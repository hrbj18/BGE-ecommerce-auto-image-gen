import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { SubmissionGate } from "../scripts/local-web-admission.mjs";
import { authorizeWriteRequest, corsOriginForRequest } from "../scripts/local-web-access.mjs";
import { createOnceAsyncFinalizer, terminateProcessTree, windowsTaskkillArgs } from "../scripts/local-web-process-manager.mjs";
import { inspectDiskSpace, requireDiskSpace } from "../scripts/local-web-storage.mjs";
import { AtomicJsonStore } from "../scripts/local-web-task-store.mjs";
import { LocalWebHttpError, readUploadLimits, validateBriefInputs, validateReferenceImages } from "../scripts/local-web-upload-policy.mjs";

test("submission gate admits one task and rejects concurrent distinct jobs", async () => {
  let token = 0;
  const gate = new SubmissionGate({ tokenFactory: () => `lease-${++token}`, now: () => 1_700_000_000_000 });
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => Promise.resolve().then(() => gate.begin({
    jobId: `job-${index}`,
    idempotencyKey: `key-${index}`,
  }))));
  assert.equal(results.filter((item) => item.kind === "acquired").length, 1);
  assert.equal(results.filter((item) => item.kind === "busy").length, 9);
});

test("submission gate deduplicates retries and stale leases cannot release a new task", () => {
  let token = 0;
  const gate = new SubmissionGate({ tokenFactory: () => `lease-${++token}` });
  const first = gate.begin({ jobId: "job-1", idempotencyKey: "same-key" });
  assert.equal(first.kind, "acquired");
  assert.deepEqual(gate.begin({ jobId: "job-2", idempotencyKey: "same-key" }), {
    kind: "duplicate", jobId: "job-1", idempotencyKey: "same-key",
  });
  if (first.kind !== "acquired") throw new Error("expected acquired lease");
  assert.equal(gate.release(first.lease.token), true);
  const second = gate.begin({ jobId: "job-3", idempotencyKey: "new-key" });
  if (second.kind !== "acquired") throw new Error("expected second lease");
  assert.equal(gate.release(first.lease.token), false);
  assert.equal(gate.snapshot()?.jobId, "job-3");
});

test("upload policy validates real images and rejects count, size, text, and corrupt bytes", async () => {
  const limits = readUploadLimits({
    LOCAL_WEB_MAX_REQUEST_MB: "2",
    LOCAL_WEB_MAX_FILE_MB: "1",
    LOCAL_WEB_MAX_REFERENCE_IMAGES: "1",
    LOCAL_WEB_MAX_IMAGE_PIXELS: "10000",
    LOCAL_WEB_MAX_IMAGE_DIMENSION: "200",
    LOCAL_WEB_MAX_BRIEF_CHARS: "20",
  } as NodeJS.ProcessEnv);
  const png = await sharp({ create: { width: 40, height: 50, channels: 4, background: "#336699" } }).png().toBuffer();
  const valid = new File([Uint8Array.from(png)], "product.png", { type: "image/png" });
  const result = await validateReferenceImages([valid], limits);
  assert.equal(result[0].width, 40);
  assert.equal(result[0].height, 50);
  await assert.rejects(() => validateReferenceImages([valid, valid], limits), (error: unknown) => error instanceof LocalWebHttpError && error.statusCode === 413);
  await assert.rejects(() => validateReferenceImages([new File([Buffer.from("not an image")], "fake.png")], limits), (error: unknown) => error instanceof LocalWebHttpError && error.statusCode === 422);
  assert.throws(() => validateBriefInputs({ briefText: "x".repeat(21) }, limits), (error: unknown) => error instanceof LocalWebHttpError && error.statusCode === 413);
});

test("atomic task store serializes writes and recovers from a valid backup", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bge-task-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "tasks.json");
  const store = new AtomicJsonStore(filePath, { backupIntervalMs: 0 });
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.save({ sequence: index })));
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { sequence: 19 });
  await store.save({ sequence: 20 });
  await fs.writeFile(filePath, "{broken", "utf8");
  const loaded = await store.load();
  assert.equal(loaded.source, "backup");
  assert.deepEqual(loaded.value, { sequence: 19 });
});

test("disk guard reports minimum space and rejects insufficient storage", async () => {
  const statfs = async () => ({ bavail: 4n, bsize: 1024n, blocks: 10n });
  const status = await inspectDiskSpace(["x"], { statfs, minimumBytes: 4096 });
  assert.equal(status.ok, true);
  await assert.rejects(() => requireDiskSpace(["x"], { statfs, minimumBytes: 4097 }), (error: unknown) => (
    error instanceof Error && "statusCode" in error && error.statusCode === 507
  ));
});

test("write authorization is open by default and retained token mode protects LAN writes", () => {
  const lanRequest = fakeRequest({ remoteAddress: "127.0.0.1", forwardedFor: "192.168.1.20", origin: "http://192.168.1.10:5173", forwardedHost: "192.168.1.10:5173" });
  assert.equal(authorizeWriteRequest(lanRequest as never, "").ok, true);
  assert.equal(authorizeWriteRequest(lanRequest as never, "", "token").ok, false);
  assert.equal(authorizeWriteRequest(lanRequest as never, "secret", "token").ok, false);
  lanRequest.headers.authorization = "Bearer secret";
  assert.equal(authorizeWriteRequest(lanRequest as never, "secret", "token").ok, true);
  assert.equal(corsOriginForRequest(lanRequest as never), "http://192.168.1.10:5173");
  lanRequest.headers.origin = "https://evil.example";
  assert.equal(corsOriginForRequest(lanRequest as never), "");
});

test("process finalizer runs once and Windows termination uses the full process tree", async () => {
  let finalized = 0;
  const finalize = createOnceAsyncFinalizer(async () => { finalized += 1; });
  await Promise.all([finalize(), finalize(), finalize()]);
  assert.equal(finalized, 1);
  assert.deepEqual(windowsTaskkillArgs(123), ["/pid", "123", "/t", "/f"]);

  const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  let invocation: unknown[] = [];
  setImmediate(() => child.emit("exit", 1));
  await terminateProcessTree(child as never, {
    platform: "win32",
    spawnSync: (...args: unknown[]) => { invocation = args; return {}; },
    graceMs: 200,
  });
  assert.deepEqual(invocation.slice(0, 2), ["taskkill", ["/pid", "123", "/t", "/f"]]);
});

function fakeRequest(options: { remoteAddress: string; forwardedFor?: string; origin?: string; forwardedHost?: string }) {
  return {
    socket: { remoteAddress: options.remoteAddress },
    headers: {
      "x-forwarded-for": options.forwardedFor || "",
      "x-forwarded-host": options.forwardedHost || "",
      origin: options.origin || "",
      authorization: "",
    },
  };
}
