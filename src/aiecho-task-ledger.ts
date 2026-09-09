import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const AIECHO_TASK_LEDGER_VERSION = 1 as const;
export const AIECHO_TASK_LEDGER_FILENAME = "aiecho-tasks.json";

export type AiEchoTaskLedgerStatus =
  | "planned"
  | "submitting"
  | "submitted"
  | "polling"
  | "downloading"
  | "validating"
  | "completed"
  | "retry_waiting"
  | "failed"
  | "ambiguous";

export interface AiEchoTaskIdentity {
  fingerprint: string;
  role: "main" | "detail";
  index: number;
  aspectRatio: "1:1" | "3:4" | "9:16";
  model: string;
  resolution: "1k" | "2k" | "4k";
}

export interface AiEchoTaskLedgerEntry extends AiEchoTaskIdentity {
  attempts: number;
  status: AiEchoTaskLedgerStatus;
  localTaskId?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  completedAt?: string;
  lastError?: string;
  retryAuthorized?: boolean;
}

export interface AiEchoTaskLedgerDocument {
  version: typeof AIECHO_TASK_LEDGER_VERSION;
  revision: number;
  updatedAt: string;
  tasks: AiEchoTaskLedgerEntry[];
}

export interface AiEchoTaskFingerprintInput {
  stableProductInput: unknown;
  referenceImageHashes: string[];
  role: "main" | "detail";
  index: number;
  aspectRatio: "1:1" | "3:4" | "9:16";
  model: string;
  resolution: "1k" | "2k" | "4k";
}

export interface AiEchoTaskLedgerOptions {
  now?: () => Date;
  beforeAtomicWrite?: (target: "backup" | "primary", filePath: string) => Promise<void> | void;
}

export class AiEchoTaskLedgerCorruptionError extends Error {
  readonly code = "AIECHO_LEDGER_CORRUPT";

  constructor(filePath: string) {
    super(`aiEcho 任务账本主文件和备份都无法安全读取，已停止可能产生费用的自动提交：${filePath}`);
    this.name = "AiEchoTaskLedgerCorruptionError";
  }
}

export class AiEchoTaskAmbiguousError extends Error {
  readonly code = "AIECHO_TASK_AMBIGUOUS";

  constructor(fingerprint: string) {
    super(`aiEcho 任务可能已被供应商受理，但本地没有可恢复的任务号，已停止自动重提：${fingerprint.slice(0, 12)}`);
    this.name = "AiEchoTaskAmbiguousError";
  }
}

type LedgerCandidate =
  | { kind: "valid"; document: AiEchoTaskLedgerDocument }
  | { kind: "missing" }
  | { kind: "invalid"; error: unknown };

const ledgerQueues = new Map<string, Promise<unknown>>();
const statuses = new Set<AiEchoTaskLedgerStatus>([
  "planned",
  "submitting",
  "submitted",
  "polling",
  "downloading",
  "validating",
  "completed",
  "retry_waiting",
  "failed",
  "ambiguous"
]);

export class AiEchoTaskLedger {
  readonly filePath: string;
  readonly backupPath: string;
  private readonly now: () => Date;
  private readonly beforeAtomicWrite?: AiEchoTaskLedgerOptions["beforeAtomicWrite"];

  constructor(filePath: string, options: AiEchoTaskLedgerOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.backupPath = `${this.filePath}.bak`;
    this.now = options.now ?? (() => new Date());
    this.beforeAtomicWrite = options.beforeAtomicWrite;
  }

  async snapshot(): Promise<AiEchoTaskLedgerDocument> {
    return enqueueLedger(this.filePath, async () => cloneDocument(await this.loadAndRepairUnlocked()));
  }

  async get(fingerprint: string): Promise<AiEchoTaskLedgerEntry | undefined> {
    const snapshot = await this.snapshot();
    const entry = snapshot.tasks.find((candidate) => candidate.fingerprint === fingerprint);
    return entry ? { ...entry } : undefined;
  }

  async recoverInterruptedSubmissions(): Promise<number> {
    let recoveredCount = 0;
    await this.update(async (document) => {
      for (const entry of document.tasks) {
        if (entry.status !== "submitting" || entry.localTaskId) continue;
        entry.status = "ambiguous";
        entry.lastError = sanitizeErrorSummary("程序在供应商任务号安全落盘前中断，不能判定是否已受理。");
        entry.retryAuthorized = undefined;
        entry.updatedAt = this.timestamp();
        recoveredCount += 1;
      }
      return recoveredCount > 0;
    });
    return recoveredCount;
  }

  async ensureEntries(identities: AiEchoTaskIdentity[]): Promise<void> {
    await this.update(async (document) => {
      let changed = false;
      const known = new Map(document.tasks.map((entry) => [entry.fingerprint, entry]));
      for (const identity of identities) {
        validateIdentity(identity);
        const existing = known.get(identity.fingerprint);
        if (existing) {
          assertSameIdentity(existing, identity);
          continue;
        }
        const now = this.timestamp();
        const entry: AiEchoTaskLedgerEntry = {
          ...identity,
          attempts: 0,
          status: "planned",
          createdAt: now,
          updatedAt: now
        };
        document.tasks.push(entry);
        known.set(entry.fingerprint, entry);
        changed = true;
      }
      return changed;
    });
  }

  async beginSubmission(fingerprint: string): Promise<AiEchoTaskLedgerEntry> {
    let result: AiEchoTaskLedgerEntry | undefined;
    await this.update(async (document) => {
      const entry = requireEntry(document, fingerprint);
      if (entry.status === "ambiguous") throw new AiEchoTaskAmbiguousError(fingerprint);
      if (!["planned", "failed"].includes(entry.status)) {
        throw new Error(`aiEcho 任务当前状态不允许重新提交：${entry.status}`);
      }
      if (entry.status !== "planned" && entry.retryAuthorized !== true) {
        throw new Error(`aiEcho 任务 ${entry.status} 没有明确的重试授权，已停止新提交。`);
      }
      entry.attempts += 1;
      entry.status = "submitting";
      entry.localTaskId = undefined;
      entry.submittedAt = undefined;
      entry.completedAt = undefined;
      entry.lastError = undefined;
      entry.retryAuthorized = undefined;
      entry.updatedAt = this.timestamp();
      result = { ...entry };
      return true;
    });
    return result!;
  }

  async markSubmitted(fingerprint: string, localTaskId: string, submittedAt: string): Promise<AiEchoTaskLedgerEntry> {
    const cleanTaskId = normalizeTaskId(localTaskId);
    let result: AiEchoTaskLedgerEntry | undefined;
    await this.update(async (document) => {
      const entry = requireEntry(document, fingerprint);
      if (entry.status === "submitted" && entry.localTaskId === cleanTaskId) {
        result = { ...entry };
        return false;
      }
      if (entry.localTaskId && entry.localTaskId !== cleanTaskId) {
        throw new Error("aiEcho 任务已绑定不同的 local_task_id，已安全停止覆盖。");
      }
      if (entry.status !== "submitting") {
        throw new Error(`aiEcho 任务号只能从 submitting 状态保存，当前为 ${entry.status}`);
      }
      entry.localTaskId = cleanTaskId;
      entry.submittedAt = normalizeTimestamp(submittedAt, this.timestamp());
      entry.status = "submitted";
      entry.updatedAt = this.timestamp();
      result = { ...entry };
      return true;
    });
    return result!;
  }

  async markStatus(
    fingerprint: string,
    status: Extract<AiEchoTaskLedgerStatus, "submitted" | "polling" | "downloading" | "validating" | "retry_waiting">
  ): Promise<AiEchoTaskLedgerEntry> {
    let result: AiEchoTaskLedgerEntry | undefined;
    await this.update(async (document) => {
      const entry = requireEntry(document, fingerprint);
      if (!entry.localTaskId) throw new AiEchoTaskAmbiguousError(fingerprint);
      const allowedFrom: Record<typeof status, AiEchoTaskLedgerStatus[]> = {
        submitted: ["submitted"],
        polling: ["submitted", "polling", "downloading", "validating", "retry_waiting", "completed"],
        downloading: ["polling"],
        validating: ["downloading"],
        retry_waiting: ["polling"]
      };
      if (!allowedFrom[status].includes(entry.status)) {
        throw new Error(`aiEcho 任务不能从 ${entry.status} 转为 ${status}`);
      }
      entry.status = status;
      entry.retryAuthorized = undefined;
      entry.completedAt = undefined;
      entry.updatedAt = this.timestamp();
      result = { ...entry };
      return true;
    });
    return result!;
  }

  async markFailed(
    fingerprint: string,
    error: unknown,
    source: "provider-terminal" | "quality-rejected" | "manual-replacement" = "provider-terminal"
  ): Promise<AiEchoTaskLedgerEntry> {
    let result: AiEchoTaskLedgerEntry | undefined;
    await this.update(async (document) => {
      const entry = requireEntry(document, fingerprint);
      if (entry.status === "ambiguous") throw new AiEchoTaskAmbiguousError(fingerprint);
      const allowed = source === "provider-terminal"
        ? entry.status === "polling" || entry.status === "failed"
        : source === "quality-rejected"
          ? entry.status === "validating" || entry.status === "failed"
          : entry.status === "completed" || entry.status === "failed";
      if (!allowed) {
        throw new Error(`aiEcho 任务不能从 ${entry.status} 由 ${source} 转为 failed`);
      }
      if (source !== "manual-replacement" && !entry.localTaskId) {
        throw new AiEchoTaskAmbiguousError(fingerprint);
      }
      entry.status = "failed";
      entry.lastError = sanitizeErrorSummary(error);
      entry.retryAuthorized = true;
      entry.updatedAt = this.timestamp();
      result = { ...entry };
      return true;
    });
    return result!;
  }

  async markAmbiguous(fingerprint: string, error: unknown): Promise<AiEchoTaskLedgerEntry> {
    let result: AiEchoTaskLedgerEntry | undefined;
    await this.update(async (document) => {
      const entry = requireEntry(document, fingerprint);
      if (entry.localTaskId) {
        throw new Error("aiEcho 任务号已知，不得转为 ambiguous 或清除可恢复任务号。");
      }
      if (entry.status !== "submitting" && entry.status !== "ambiguous") {
        throw new Error(`aiEcho 任务不能从 ${entry.status} 转为 ambiguous`);
      }
      entry.status = "ambiguous";
      entry.localTaskId = undefined;
      entry.submittedAt = undefined;
      entry.lastError = sanitizeErrorSummary(error);
      entry.retryAuthorized = undefined;
      entry.updatedAt = this.timestamp();
      result = { ...entry };
      return true;
    });
    return result!;
  }

  async markCompleted(
    fingerprint: string,
    source: "validated-candidate" | "existing-valid-file" = "validated-candidate"
  ): Promise<AiEchoTaskLedgerEntry> {
    let result: AiEchoTaskLedgerEntry | undefined;
    await this.update(async (document) => {
      const entry = requireEntry(document, fingerprint);
      if (entry.status === "ambiguous") throw new AiEchoTaskAmbiguousError(fingerprint);
      if (source === "validated-candidate") {
        if (entry.status !== "validating" && entry.status !== "completed") {
          throw new Error(`aiEcho 只能将已校验候选文件从 validating 转为 completed，当前为 ${entry.status}`);
        }
        if (entry.status === "validating" && !entry.localTaskId) {
          throw new AiEchoTaskAmbiguousError(fingerprint);
        }
      } else {
        // An old formal image cannot prove that an in-flight provider task has
        // finished. Only legacy planned records and already-completed records
        // may be reconciled from a pre-existing valid file.
        const safeExistingFileState = entry.status === "planned" || entry.status === "completed";
        if (!safeExistingFileState) {
          throw new Error(`aiEcho 当前状态不允许用现有文件覆盖账本：${entry.status}`);
        }
      }
      entry.status = "completed";
      entry.completedAt = this.timestamp();
      entry.lastError = undefined;
      entry.retryAuthorized = undefined;
      entry.updatedAt = entry.completedAt;
      result = { ...entry };
      return true;
    });
    return result!;
  }

  private async update(mutator: (document: AiEchoTaskLedgerDocument) => Promise<boolean> | boolean): Promise<void> {
    await enqueueLedger(this.filePath, async () => {
      const document = await this.loadAndRepairUnlocked();
      const changed = await mutator(document);
      if (changed) await this.persistUnlocked(document);
    });
  }

  private async loadAndRepairUnlocked(): Promise<AiEchoTaskLedgerDocument> {
    const [primary, backup] = await Promise.all([
      readCandidate(this.filePath),
      readCandidate(this.backupPath)
    ]);
    if (primary.kind === "missing" && backup.kind === "missing") return emptyDocument(this.timestamp());

    let document: AiEchoTaskLedgerDocument;
    let repairPrimary = false;
    let repairBackup = false;
    if (primary.kind === "valid" && backup.kind === "valid") {
      if (backup.document.revision > primary.document.revision) {
        document = backup.document;
        repairPrimary = true;
      } else if (primary.document.revision > backup.document.revision) {
        document = primary.document;
        repairBackup = true;
      } else {
        if (canonicalJson(primary.document) !== canonicalJson(backup.document)) {
          throw new AiEchoTaskLedgerCorruptionError(this.filePath);
        }
        document = primary.document;
      }
    } else if (primary.kind === "valid") {
      document = primary.document;
      repairBackup = true;
    } else if (backup.kind === "valid") {
      document = backup.document;
      repairPrimary = true;
    } else {
      throw new AiEchoTaskLedgerCorruptionError(this.filePath);
    }

    if (repairBackup || repairPrimary) {
      const serialized = `${JSON.stringify(document, null, 2)}\n`;
      if (repairBackup) {
        await this.beforeAtomicWrite?.("backup", this.backupPath);
        await writeAtomicFile(this.backupPath, serialized);
      }
      if (repairPrimary) {
        await this.beforeAtomicWrite?.("primary", this.filePath);
        await writeAtomicFile(this.filePath, serialized);
      }
    }
    return document;
  }

  private async persistUnlocked(document: AiEchoTaskLedgerDocument): Promise<void> {
    document.tasks.sort((left, right) => left.role.localeCompare(right.role) || left.index - right.index || left.fingerprint.localeCompare(right.fingerprint));
    document.revision += 1;
    document.updatedAt = this.timestamp();
    validateDocument(document);
    const serialized = `${JSON.stringify(document, null, 2)}\n`;

    // Write the mirrored backup first. Both files carry a monotonically increasing
    // revision, so a crash between the two renames still leaves one newest copy.
    await this.beforeAtomicWrite?.("backup", this.backupPath);
    await writeAtomicFile(this.backupPath, serialized);
    await this.beforeAtomicWrite?.("primary", this.filePath);
    await writeAtomicFile(this.filePath, serialized);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export function createAiEchoTaskFingerprint(input: AiEchoTaskFingerprintInput): string {
  const canonical = canonicalJson({
    product: input.stableProductInput,
    referenceImageHashes: input.referenceImageHashes.map((value) => String(value).trim().toLowerCase()),
    role: input.role,
    index: input.index,
    aspectRatio: input.aspectRatio,
    model: input.model,
    resolution: input.resolution
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function sanitizeErrorSummary(error: unknown, maxLength = 600): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/key:[A-Za-z0-9._~+/=-]+/gi, "key:[redacted]")
    .replace(/(["']?activationCode["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, Math.max(80, maxLength));
}

function emptyDocument(now: string): AiEchoTaskLedgerDocument {
  return { version: AIECHO_TASK_LEDGER_VERSION, revision: 0, updatedAt: now, tasks: [] };
}

async function readCandidate(filePath: string): Promise<LedgerCandidate> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    validateDocument(parsed);
    return { kind: "valid", document: parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", error };
  }
}

function validateDocument(value: unknown): asserts value is AiEchoTaskLedgerDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ledger must be an object");
  const document = value as Partial<AiEchoTaskLedgerDocument>;
  if (document.version !== AIECHO_TASK_LEDGER_VERSION) throw new Error("unsupported ledger version");
  if (!Number.isInteger(document.revision) || Number(document.revision) < 0) throw new Error("invalid ledger revision");
  if (typeof document.updatedAt !== "string" || !document.updatedAt) throw new Error("invalid ledger updatedAt");
  if (!Array.isArray(document.tasks) || document.tasks.length > 1_000) throw new Error("invalid ledger task list");
  const fingerprints = new Set<string>();
  for (const entry of document.tasks) {
    validateEntry(entry);
    if (fingerprints.has(entry.fingerprint)) throw new Error("duplicate ledger fingerprint");
    fingerprints.add(entry.fingerprint);
  }
}

function validateEntry(value: unknown): asserts value is AiEchoTaskLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid ledger entry");
  const entry = value as Partial<AiEchoTaskLedgerEntry>;
  validateIdentity(entry as AiEchoTaskIdentity);
  if (!Number.isInteger(entry.attempts) || Number(entry.attempts) < 0 || Number(entry.attempts) > 1_000) throw new Error("invalid attempt count");
  if (!statuses.has(entry.status as AiEchoTaskLedgerStatus)) throw new Error("invalid ledger status");
  if (typeof entry.createdAt !== "string" || !entry.createdAt || typeof entry.updatedAt !== "string" || !entry.updatedAt) {
    throw new Error("invalid ledger timestamps");
  }
  if (entry.localTaskId !== undefined) normalizeTaskId(entry.localTaskId);
  if (["submitted", "polling", "downloading", "validating", "retry_waiting"].includes(String(entry.status)) && !entry.localTaskId) {
    throw new Error("recoverable ledger status is missing local_task_id");
  }
  if (entry.lastError !== undefined && (typeof entry.lastError !== "string" || entry.lastError.length > 600)) {
    throw new Error("invalid ledger error summary");
  }
  if (entry.retryAuthorized !== undefined && typeof entry.retryAuthorized !== "boolean") {
    throw new Error("invalid ledger retry authorization");
  }
}

function validateIdentity(identity: AiEchoTaskIdentity): void {
  if (!/^[a-f0-9]{64}$/i.test(String(identity.fingerprint || ""))) throw new Error("invalid aiEcho task fingerprint");
  if (!new Set(["main", "detail"]).has(identity.role)) throw new Error("invalid aiEcho task role");
  if (!Number.isInteger(identity.index) || identity.index < 1 || identity.index > 1_000) throw new Error("invalid aiEcho task index");
  if (!new Set(["1:1", "3:4", "9:16"]).has(identity.aspectRatio)) throw new Error("invalid aiEcho aspect ratio");
  if (typeof identity.model !== "string" || !identity.model.trim() || identity.model.length > 120) throw new Error("invalid aiEcho model");
  if (!new Set(["1k", "2k", "4k"]).has(identity.resolution)) throw new Error("invalid aiEcho resolution");
}

function assertSameIdentity(existing: AiEchoTaskLedgerEntry, identity: AiEchoTaskIdentity): void {
  if (
    existing.role !== identity.role
    || existing.index !== identity.index
    || existing.aspectRatio !== identity.aspectRatio
    || existing.model !== identity.model
    || existing.resolution !== identity.resolution
  ) {
    throw new Error(`aiEcho 任务指纹与已有账本记录冲突：${identity.fingerprint.slice(0, 12)}`);
  }
}

function requireEntry(document: AiEchoTaskLedgerDocument, fingerprint: string): AiEchoTaskLedgerEntry {
  const entry = document.tasks.find((candidate) => candidate.fingerprint === fingerprint);
  if (!entry) throw new Error(`aiEcho 任务账本缺少记录：${fingerprint.slice(0, 12)}`);
  return entry;
}

function normalizeTaskId(value: string): string {
  const clean = String(value || "").trim();
  if (!clean || clean.length > 512 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error("invalid aiEcho local_task_id");
  return clean;
}

function normalizeTimestamp(value: string, fallback: string): string {
  const clean = String(value || "").trim();
  return clean && Number.isFinite(Date.parse(clean)) ? clean : fallback;
}

function cloneDocument(document: AiEchoTaskLedgerDocument): AiEchoTaskLedgerDocument {
  return {
    ...document,
    tasks: document.tasks.map((entry) => ({ ...entry }))
  };
}

async function writeAtomicFile(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Windows does not allow syncing directory handles. File fsync + atomic
    // rename is still used, and supported platforms get the extra dir fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function enqueueLedger<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath).toLowerCase();
  const previous = ledgerQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  ledgerQueues.set(key, current);
  return current.finally(() => {
    if (ledgerQueues.get(key) === current) ledgerQueues.delete(key);
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("stable fingerprint input contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item === undefined ? null : item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  if (value === undefined) return null;
  throw new Error(`stable fingerprint input contains unsupported value: ${typeof value}`);
}
