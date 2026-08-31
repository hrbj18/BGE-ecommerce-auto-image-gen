import { randomUUID } from "node:crypto";

export class SubmissionGate {
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.active = null;
    this.idempotency = new Map();
    this.maxIdempotencyEntries = Math.max(50, Number(options.maxIdempotencyEntries || 500));
  }

  begin({ jobId, idempotencyKey = "", phase = "receiving" }) {
    const key = normalizeIdempotencyKey(idempotencyKey);
    if (key && this.idempotency.has(key)) {
      return { kind: "duplicate", jobId: this.idempotency.get(key), idempotencyKey: key };
    }
    if (this.active) return { kind: "busy", active: this.snapshot() };

    const lease = {
      token: this.tokenFactory(),
      jobId: String(jobId),
      idempotencyKey: key,
      phase: String(phase || "receiving"),
      acquiredAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.active = lease;
    if (key) this.remember(key, lease.jobId);
    return { kind: "acquired", lease: { ...lease } };
  }

  remember(idempotencyKey, jobId) {
    const key = normalizeIdempotencyKey(idempotencyKey);
    if (!key || !jobId) return;
    this.idempotency.delete(key);
    this.idempotency.set(key, String(jobId));
    while (this.idempotency.size > this.maxIdempotencyEntries) {
      const oldest = this.idempotency.keys().next().value;
      if (!oldest) break;
      this.idempotency.delete(oldest);
    }
  }

  forget(idempotencyKey) {
    const key = normalizeIdempotencyKey(idempotencyKey);
    if (key) this.idempotency.delete(key);
  }

  transition(token, phase) {
    if (!this.active || this.active.token !== token) return false;
    this.active.phase = String(phase || this.active.phase);
    this.active.updatedAt = new Date(this.now()).toISOString();
    return true;
  }

  release(token) {
    if (!this.active || this.active.token !== token) return false;
    this.active = null;
    return true;
  }

  snapshot() {
    return this.active ? { ...this.active } : null;
  }
}

export function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (key.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    const error = new Error("幂等键格式不合法，请重新提交任务。");
    error.statusCode = 400;
    error.code = "INVALID_IDEMPOTENCY_KEY";
    throw error;
  }
  return key;
}
