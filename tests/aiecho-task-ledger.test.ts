import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AIECHO_TASK_LEDGER_VERSION,
  AiEchoTaskAmbiguousError,
  AiEchoTaskLedger,
  AiEchoTaskLedgerCorruptionError,
  createAiEchoTaskFingerprint,
  type AiEchoTaskIdentity
} from "../src/aiecho-task-ledger.ts";

test("aiEcho ledger serializes 13 concurrent image transitions without losing records", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-concurrent-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "raw", "aiecho-tasks.json");
  const ledger = new AiEchoTaskLedger(ledgerPath);
  const identities = Array.from({ length: 13 }, (_, offset) => identityFor(offset));
  await ledger.ensureEntries(identities);

  await Promise.all(identities.map(async (identity, offset) => {
    await ledger.beginSubmission(identity.fingerprint);
    await ledger.markSubmitted(identity.fingerprint, `provider-task-${offset + 1}`, new Date(1_700_000_000_000 + offset).toISOString());
    await ledger.markStatus(identity.fingerprint, "polling");
    await ledger.markStatus(identity.fingerprint, "downloading");
    await ledger.markStatus(identity.fingerprint, "validating");
    await ledger.markCompleted(identity.fingerprint);
  }));

  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.version, AIECHO_TASK_LEDGER_VERSION);
  assert.equal(snapshot.tasks.length, 13);
  assert.equal(new Set(snapshot.tasks.map((entry) => entry.fingerprint)).size, 13);
  assert.equal(snapshot.tasks.every((entry) => entry.status === "completed" && entry.attempts === 1 && entry.localTaskId), true);

  const primary = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { revision: number; tasks: unknown[] };
  const backup = JSON.parse(await fs.readFile(`${ledgerPath}.bak`, "utf8")) as { revision: number; tasks: unknown[] };
  assert.equal(primary.revision, backup.revision);
  assert.equal(primary.tasks.length, 13);
  assert.doesNotMatch(JSON.stringify(primary), /activationCode|Bearer |https?:\/\/|CURRENT FRAME MISSION/);
});

test("aiEcho ledger recovers the newest valid backup when the primary is corrupt", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-backup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "raw", "aiecho-tasks.json");
  const ledger = new AiEchoTaskLedger(ledgerPath);
  const identity = identityFor(0);
  await ledger.ensureEntries([identity]);
  await ledger.beginSubmission(identity.fingerprint);
  await ledger.markSubmitted(identity.fingerprint, "persisted-provider-task", "2026-09-01T00:00:00.000Z");
  await fs.writeFile(ledgerPath, "{broken", "utf8");

  const recovered = await new AiEchoTaskLedger(ledgerPath).snapshot();
  assert.equal(recovered.tasks[0]?.localTaskId, "persisted-provider-task");
  assert.equal(recovered.tasks[0]?.status, "submitted");
  const healedPrimary = await fs.readFile(ledgerPath, "utf8");
  assert.doesNotThrow(() => JSON.parse(healedPrimary));
});

test("aiEcho ledger fails closed when both primary and backup are corrupt", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-corrupt-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "raw", "aiecho-tasks.json");
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, "{broken-primary", "utf8");
  await fs.writeFile(`${ledgerPath}.bak`, "{broken-backup", "utf8");

  await assert.rejects(
    new AiEchoTaskLedger(ledgerPath).snapshot(),
    (error: unknown) => error instanceof AiEchoTaskLedgerCorruptionError && error.code === "AIECHO_LEDGER_CORRUPT"
  );
});

test("an interrupted submitting entry becomes ambiguous and cannot be submitted again automatically", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-ambiguous-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "raw", "aiecho-tasks.json");
  const identity = identityFor(0);
  const firstProcess = new AiEchoTaskLedger(ledgerPath);
  await firstProcess.ensureEntries([identity]);
  await firstProcess.beginSubmission(identity.fingerprint);

  const restartedProcess = new AiEchoTaskLedger(ledgerPath);
  assert.equal(await restartedProcess.recoverInterruptedSubmissions(), 1);
  const entry = await restartedProcess.get(identity.fingerprint);
  assert.equal(entry?.status, "ambiguous");
  assert.equal(entry?.localTaskId, undefined);
  await assert.rejects(
    restartedProcess.beginSubmission(identity.fingerprint),
    (error: unknown) => error instanceof AiEchoTaskAmbiguousError && error.code === "AIECHO_TASK_AMBIGUOUS"
  );
});

test("explicit failed starts a new attempt while retry waiting resumes the old task id", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-explicit-retry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledger = new AiEchoTaskLedger(path.join(directory, "raw", "aiecho-tasks.json"));
  const failedIdentity = identityFor(0);
  const waitingIdentity = identityFor(1);
  await ledger.ensureEntries([failedIdentity, waitingIdentity]);

  await ledger.beginSubmission(failedIdentity.fingerprint);
  await ledger.markSubmitted(failedIdentity.fingerprint, "failed-old-id", "2026-09-01T00:00:00.000Z");
  await ledger.markStatus(failedIdentity.fingerprint, "polling");
  await ledger.markFailed(failedIdentity.fingerprint, "provider explicitly failed", "provider-terminal");
  const failedRetry = await ledger.beginSubmission(failedIdentity.fingerprint);

  await ledger.beginSubmission(waitingIdentity.fingerprint);
  await ledger.markSubmitted(waitingIdentity.fingerprint, "waiting-old-id", "2026-09-01T00:00:00.000Z");
  await ledger.markStatus(waitingIdentity.fingerprint, "polling");
  await ledger.markStatus(waitingIdentity.fingerprint, "retry_waiting");
  await assert.rejects(ledger.beginSubmission(waitingIdentity.fingerprint), /retry_waiting/);
  const waitingResume = await ledger.markStatus(waitingIdentity.fingerprint, "polling");

  assert.equal(failedRetry.status, "submitting");
  assert.equal(failedRetry.attempts, 2);
  assert.equal(failedRetry.localTaskId, undefined);
  assert.equal(waitingResume.status, "polling");
  assert.equal(waitingResume.attempts, 1);
  assert.equal(waitingResume.localTaskId, "waiting-old-id");
});

test("ambiguous and completed-without-id entries cannot be auto-unlocked for a paid retry", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-terminal-state-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledger = new AiEchoTaskLedger(path.join(directory, "raw", "aiecho-tasks.json"));
  const ambiguousIdentity = identityFor(0);
  const existingFileIdentity = identityFor(1);
  await ledger.ensureEntries([ambiguousIdentity, existingFileIdentity]);

  await ledger.beginSubmission(ambiguousIdentity.fingerprint);
  await ledger.markAmbiguous(ambiguousIdentity.fingerprint, "provider acceptance is unknown");
  await assert.rejects(
    ledger.markCompleted(ambiguousIdentity.fingerprint, "existing-valid-file"),
    (error: unknown) => error instanceof AiEchoTaskAmbiguousError
  );
  assert.equal((await ledger.get(ambiguousIdentity.fingerprint))?.status, "ambiguous");

  await ledger.markCompleted(existingFileIdentity.fingerprint, "existing-valid-file");
  const completedWithoutId = await ledger.get(existingFileIdentity.fingerprint);
  assert.equal(completedWithoutId?.status, "completed");
  assert.equal(completedWithoutId?.localTaskId, undefined);
  await assert.rejects(
    ledger.beginSubmission(existingFileIdentity.fingerprint),
    /completed/
  );
});

test("a known task id cannot be cleared by marking the task ambiguous", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-known-id-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledger = new AiEchoTaskLedger(path.join(directory, "raw", "aiecho-tasks.json"));
  const identity = identityFor(0);
  await ledger.ensureEntries([identity]);
  await ledger.beginSubmission(identity.fingerprint);
  await ledger.markSubmitted(identity.fingerprint, "known-provider-id", "2026-09-01T00:00:00.000Z");

  await assert.rejects(ledger.markAmbiguous(identity.fingerprint, "must not clear"), /任务号已知/);
  const entry = await ledger.get(identity.fingerprint);
  assert.equal(entry?.status, "submitted");
  assert.equal(entry?.localTaskId, "known-provider-id");
});

test("markSubmitted is idempotent for the same task id and fails closed for a conflicting id", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-task-id-conflict-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledger = new AiEchoTaskLedger(path.join(directory, "raw", "aiecho-tasks.json"));
  const identity = identityFor(0);
  await ledger.ensureEntries([identity]);
  await ledger.beginSubmission(identity.fingerprint);
  const first = await ledger.markSubmitted(identity.fingerprint, "stable-provider-id", "2026-09-01T00:00:00.000Z");
  const same = await ledger.markSubmitted(identity.fingerprint, "stable-provider-id", "2026-09-01T00:00:01.000Z");

  assert.equal(same.localTaskId, first.localTaskId);
  assert.equal(same.submittedAt, first.submittedAt);
  await assert.rejects(
    ledger.markSubmitted(identity.fingerprint, "conflicting-provider-id", "2026-09-01T00:00:02.000Z"),
    /不同的 local_task_id/
  );
  const preserved = await ledger.get(identity.fingerprint);
  assert.equal(preserved?.status, "submitted");
  assert.equal(preserved?.localTaskId, "stable-provider-id");
});

test("invalid failure and status transitions cannot manufacture retry authorization", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-transition-guard-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledger = new AiEchoTaskLedger(path.join(directory, "raw", "aiecho-tasks.json"));
  const identity = identityFor(0);
  await ledger.ensureEntries([identity]);
  await ledger.beginSubmission(identity.fingerprint);
  await ledger.markSubmitted(identity.fingerprint, "transition-provider-id", "2026-09-01T00:00:00.000Z");

  await assert.rejects(ledger.markStatus(identity.fingerprint, "validating"), /不能从 submitted 转为 validating/);
  await assert.rejects(
    ledger.markFailed(identity.fingerprint, "not a terminal provider result", "provider-terminal"),
    /不能从 submitted/
  );
  await assert.rejects(
    ledger.markFailed(identity.fingerprint, "not a completed quality check", "quality-rejected"),
    /不能从 submitted/
  );
  const preserved = await ledger.get(identity.fingerprint);
  assert.equal(preserved?.status, "submitted");
  assert.equal(preserved?.retryAuthorized, undefined);
  await assert.rejects(ledger.beginSubmission(identity.fingerprint), /submitted/);
});

test("backup-first persistence recovers task id when primary write fails", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-primary-window-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "raw", "aiecho-tasks.json");
  let failNextPrimary = false;
  const faultedLedger = new AiEchoTaskLedger(ledgerPath, {
    beforeAtomicWrite(target) {
      if (target === "primary" && failNextPrimary) {
        failNextPrimary = false;
        throw new Error("injected primary rename failure");
      }
    }
  });
  const identity = identityFor(0);
  await faultedLedger.ensureEntries([identity]);
  await faultedLedger.beginSubmission(identity.fingerprint);
  failNextPrimary = true;

  await assert.rejects(
    faultedLedger.markSubmitted(identity.fingerprint, "backup-persisted-id", "2026-09-01T00:00:00.000Z"),
    /injected primary rename failure/
  );
  const stalePrimary = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { revision: number; tasks: Array<{ status: string; localTaskId?: string }> };
  const newestBackup = JSON.parse(await fs.readFile(`${ledgerPath}.bak`, "utf8")) as typeof stalePrimary;
  assert.equal(stalePrimary.tasks[0].status, "submitting");
  assert.equal(stalePrimary.tasks[0].localTaskId, undefined);
  assert.equal(newestBackup.tasks[0].status, "submitted");
  assert.equal(newestBackup.tasks[0].localTaskId, "backup-persisted-id");
  assert.ok(newestBackup.revision > stalePrimary.revision);

  const recovered = await new AiEchoTaskLedger(ledgerPath).snapshot();
  assert.equal(recovered.tasks[0].status, "submitted");
  assert.equal(recovered.tasks[0].localTaskId, "backup-persisted-id");
  const healedPrimary = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as typeof stalePrimary;
  assert.equal(healedPrimary.tasks[0].localTaskId, "backup-persisted-id");
});

test("same-revision replicas with different content fail closed", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiecho-ledger-divergent-replicas-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "raw", "aiecho-tasks.json");
  const ledger = new AiEchoTaskLedger(ledgerPath);
  await ledger.ensureEntries([identityFor(0)]);
  const backup = JSON.parse(await fs.readFile(`${ledgerPath}.bak`, "utf8")) as {
    revision: number;
    tasks: Array<{ lastError?: string }>;
  };
  backup.tasks[0].lastError = "valid but divergent replica";
  await fs.writeFile(`${ledgerPath}.bak`, `${JSON.stringify(backup, null, 2)}\n`, "utf8");

  await assert.rejects(
    new AiEchoTaskLedger(ledgerPath).snapshot(),
    (error: unknown) => error instanceof AiEchoTaskLedgerCorruptionError
  );
});

test("stable task fingerprints ignore temporary public URLs supplied outside the input", () => {
  const common = {
    stableProductInput: { sku: "sku-1", sellingPoints: "stable input" },
    referenceImageHashes: ["a".repeat(64), "b".repeat(64)],
    role: "main" as const,
    index: 1,
    aspectRatio: "1:1" as const,
    model: "gpt-2.0",
    resolution: "2k" as const
  };
  assert.equal(createAiEchoTaskFingerprint(common), createAiEchoTaskFingerprint({ ...common }));
  assert.notEqual(createAiEchoTaskFingerprint(common), createAiEchoTaskFingerprint({ ...common, index: 2 }));
});

function identityFor(offset: number): AiEchoTaskIdentity {
  const role = offset < 5 ? "main" as const : "detail" as const;
  const index = role === "main" ? offset + 1 : offset - 4;
  const aspectRatio = role === "main" ? "1:1" as const : "9:16" as const;
  return {
    fingerprint: createAiEchoTaskFingerprint({
      stableProductInput: { sku: "stable-sku", sellingPoints: ["one", "two"] },
      referenceImageHashes: ["1".repeat(64), "2".repeat(64)],
      role,
      index,
      aspectRatio,
      model: "gpt-2.0",
      resolution: "2k"
    }),
    role,
    index,
    aspectRatio,
    model: "gpt-2.0",
    resolution: "2k"
  };
}
