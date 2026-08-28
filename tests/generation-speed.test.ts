import test from "node:test";
import assert from "node:assert/strict";
import { mapLimitedSettled, prioritizeNativeImageJobs } from "../src/openai-image-generator.ts";
import { normalizeGenerationProgress, parseNativeProgressLines } from "../scripts/generation-progress.mjs";

test("generation progress parser keeps only valid structured workflow telemetry", () => {
  const progress = parseNativeProgressLines([
    "ordinary log line",
    "[native-progress] {not-json}",
    '[native-progress] {"stage":"generating-main","message":"首图已完成","total":13,"completed":1,"mainCompleted":1,"detailCompleted":0,"retries":0,"backpressureCount":0,"concurrency":5,"firstPreviewElapsedMs":2300}',
  ].join("\n"));

  assert.deepEqual(progress, {
    stage: "generating-main",
    message: "首图已完成",
    total: 13,
    completed: 1,
    mainCompleted: 1,
    detailCompleted: 0,
    retries: 0,
    backpressureCount: 0,
    concurrency: 5,
    qualityRetryTotal: 0,
    qualityRetryCompleted: 0,
    nextRetryDelayMs: undefined,
    firstPreviewAt: undefined,
    firstPreviewElapsedMs: 2300,
    updatedAt: progress?.updatedAt,
  });
  assert.equal(normalizeGenerationProgress({ stage: "unknown" }), null);
});

test("bounded recovery and review workers execute in parallel without exceeding their limit", async () => {
  let active = 0;
  let peak = 0;
  const settled: number[] = [];
  await mapLimitedSettled(
    [1, 2, 3, 4, 5],
    2,
    async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 12));
      active -= 1;
      return item * 10;
    },
    async (_item, result) => {
      assert.equal(result.status, "fulfilled");
      if (result.status === "fulfilled") settled.push(result.value);
    }
  );
  assert.equal(peak, 2);
  assert.deepEqual(settled.sort((a, b) => a - b), [10, 20, 30, 40, 50]);
});

test("delivery queue puts all main images before detail images while keeping index order", () => {
  const ordered = prioritizeNativeImageJobs([
    { spec: { role: "detail" as const, index: 2 } },
    { spec: { role: "main" as const, index: 4 } },
    { spec: { role: "detail" as const, index: 1 } },
    { spec: { role: "main" as const, index: 1 } },
    { spec: { role: "main" as const, index: 2 } },
  ]);
  assert.deepEqual(ordered.map((item) => `${item.spec.role}-${item.spec.index}`), [
    "main-1",
    "main-2",
    "main-4",
    "detail-1",
    "detail-2",
  ]);
});
