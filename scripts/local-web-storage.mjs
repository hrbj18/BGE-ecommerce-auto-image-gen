import fs from "node:fs/promises";

const GIB = 1024 ** 3;

export class InsufficientStorageError extends Error {
  constructor(status) {
    super(`磁盘可用空间不足，至少需要 ${status.minimumGiB} GiB，当前约 ${status.availableGiB} GiB。请清理历史任务后重试。`);
    this.name = "InsufficientStorageError";
    this.statusCode = 507;
    this.code = "INSUFFICIENT_STORAGE";
    this.status = status;
  }
}

export function minimumFreeBytes(env = process.env) {
  const gib = Number(env.LOCAL_WEB_MIN_FREE_GB || 5);
  return (Number.isFinite(gib) && gib > 0 ? gib : 5) * GIB;
}

export async function inspectDiskSpace(paths, options = {}) {
  const statfs = options.statfs ?? ((target) => fs.statfs(target, { bigint: true }));
  const minimumBytes = Number(options.minimumBytes ?? minimumFreeBytes());
  const uniquePaths = [...new Set((paths || []).filter(Boolean).map(String))];
  const checks = [];
  for (const target of uniquePaths) {
    const stats = await statfs(target);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    checks.push({ target, availableBytes, totalBytes, ok: availableBytes >= minimumBytes });
  }
  const availableBytes = checks.length ? Math.min(...checks.map((item) => item.availableBytes)) : 0;
  return {
    ok: checks.length > 0 && checks.every((item) => item.ok),
    minimumBytes,
    minimumGiB: roundGiB(minimumBytes),
    availableBytes,
    availableGiB: roundGiB(availableBytes),
    checks,
  };
}

export async function requireDiskSpace(paths, options = {}) {
  const status = await inspectDiskSpace(paths, options);
  if (!status.ok) throw new InsufficientStorageError(status);
  return status;
}

function roundGiB(bytes) {
  return Math.round((bytes / GIB) * 10) / 10;
}
