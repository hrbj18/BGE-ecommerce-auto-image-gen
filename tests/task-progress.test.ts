import assert from "node:assert/strict";
import test from "node:test";
import { taskImageCounts, taskProgressLabel } from "../frontend/src/task-progress.js";

test("task progress uses the selected compact delivery counts", () => {
  assert.deepEqual(taskImageCounts({ mainImageCount: 1, detailImageCount: 2 }), { main: 1, detail: 2 });
  assert.deepEqual(taskImageCounts({ mainImageCount: 2, detailImageCount: 3 }), { main: 2, detail: 3 });
  assert.deepEqual(taskImageCounts({ mainImageCount: 3, detailImageCount: 4 }), { main: 3, detail: 4 });
  assert.equal(taskProgressLabel({ mainImageCount: 1, detailImageCount: 2 }), "1 主图 + 2 详情页");
});

test("task progress retains the standard suite for older or malformed records", () => {
  assert.deepEqual(taskImageCounts({}), { main: 5, detail: 8 });
  assert.deepEqual(taskImageCounts({ mainImageCount: 7, detailImageCount: -1 }), { main: 5, detail: 8 });
});
