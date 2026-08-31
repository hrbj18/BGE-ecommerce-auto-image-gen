import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class AtomicJsonStore {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.backupPath = `${this.filePath}.bak`;
    this.fs = options.fs ?? fs;
    this.queue = Promise.resolve();
    this.backupIntervalMs = Number.isFinite(Number(options.backupIntervalMs)) ? Math.max(0, Number(options.backupIntervalMs)) : 30_000;
    this.lastBackupAt = 0;
  }

  async load() {
    await this.cleanupTemporaryFiles();
    const primary = await readValidJson(this.fs, this.filePath);
    if (primary.ok) return { value: primary.value, source: "primary", recovered: false };
    const backup = await readValidJson(this.fs, this.backupPath);
    if (backup.ok) return { value: backup.value, source: "backup", recovered: true, primaryError: primary.error };
    return { value: null, source: "missing", recovered: false, primaryError: primary.error, backupError: backup.error };
  }

  save(value) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const operation = this.queue.then(() => this.writeAtomic(serialized));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async flush() {
    await this.queue;
  }

  async writeAtomic(serialized) {
    const dir = path.dirname(this.filePath);
    const tempPath = path.join(dir, `${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    await this.fs.mkdir(dir, { recursive: true });
    const current = await readValidJson(this.fs, this.filePath);
    const now = Date.now();
    if (current.ok && (this.backupIntervalMs === 0 || now - this.lastBackupAt >= this.backupIntervalMs)) {
      await this.fs.copyFile(this.filePath, this.backupPath);
      this.lastBackupAt = now;
    }

    let handle;
    try {
      handle = await this.fs.open(tempPath, "wx");
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fs.rename(tempPath, this.filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await this.fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async cleanupTemporaryFiles() {
    const dir = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.`;
    const entries = await this.fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".tmp"))
      .map((entry) => this.fs.rm(path.join(dir, entry.name), { force: true }).catch(() => undefined)));
  }
}

async function readValidJson(fsModule, filePath) {
  try {
    const raw = await fsModule.readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}
