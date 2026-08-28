const stages = new Set([
  "planning",
  "generating-main",
  "generating-detail",
  "recovering",
  "quality-review",
  "quality-retry",
  "packaging",
  "complete",
]);

function finiteInteger(value, fallback = 0, max = 10_000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(number)));
}

export function normalizeGenerationProgress(value) {
  if (!value || typeof value !== "object" || !stages.has(value.stage)) return null;
  const total = finiteInteger(value.total);
  const mainCompleted = finiteInteger(value.mainCompleted, 0, 5);
  const detailCompleted = finiteInteger(value.detailCompleted, 0, 8);
  const completed = Math.min(total || 13, Math.max(finiteInteger(value.completed), mainCompleted + detailCompleted));
  return {
    stage: value.stage,
    message: String(value.message || "图片生成进行中。").slice(0, 240),
    total: total || 13,
    completed,
    mainCompleted,
    detailCompleted,
    retries: finiteInteger(value.retries, 0, 100),
    backpressureCount: finiteInteger(value.backpressureCount, 0, 100),
    concurrency: finiteInteger(value.concurrency, 0, 8),
    qualityRetryTotal: finiteInteger(value.qualityRetryTotal, 0, 13),
    qualityRetryCompleted: finiteInteger(value.qualityRetryCompleted, 0, 13),
    nextRetryDelayMs: finiteInteger(value.nextRetryDelayMs, 0, 300_000) || undefined,
    firstPreviewAt: typeof value.firstPreviewAt === "string" ? value.firstPreviewAt.slice(0, 40) : undefined,
    firstPreviewElapsedMs: finiteInteger(value.firstPreviewElapsedMs, 0, 7_200_000) || undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt.slice(0, 40) : new Date().toISOString(),
  };
}

export function parseNativeProgressLines(text) {
  const marker = /^\[native-progress\]\s+(\{.+\})\s*$/gm;
  let match;
  let latest = null;
  while ((match = marker.exec(String(text || "")))) {
    try {
      latest = normalizeGenerationProgress(JSON.parse(match[1])) || latest;
    } catch {
      // Workflow logs are best-effort telemetry; malformed lines must never stop a job.
    }
  }
  return latest;
}
