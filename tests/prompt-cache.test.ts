import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore - Frontend helper is plain ESM JavaScript and is covered by runtime tests.
import { cachePromptSnapshot, promptCacheStorageKey, promptSnapshotFromTask, readCachedPromptSnapshot } from "../frontend/src/prompt-cache.js";

class MemoryStorage {
  store = new Map<string, string>();

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

test("prompt snapshots do not treat truncated previews as importable prompts", () => {
  const snapshot = promptSnapshotFromTask({
    id: "task-1",
    productName: "豆包AI机器人",
    briefPreview: "商品作图需求模板 产品名称：豆包AI机器人 主图规划：1. 英雄主图...",
  });

  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.promptText, "");
});

test("prompt cache stores complete prompt text and ignores preview-only records", () => {
  const storage = new MemoryStorage();
  cachePromptSnapshot(
    {
      id: "task-1",
      productName: "豆包AI机器人",
      finalBriefText: "产品名称：豆包AI机器人\n主图规划：\n1. 英雄主图\n2. 核心卖点",
    },
    storage
  );
  cachePromptSnapshot(
    {
      id: "task-2",
      productName: "预览任务",
      briefPreview: "产品名称：预览任务 主图规划...",
    },
    storage
  );

  const cached = readCachedPromptSnapshot("task-1", storage);
  assert.equal(cached?.complete, true);
  assert.match(cached?.promptText || "", /核心卖点/);
  assert.equal(readCachedPromptSnapshot("task-2", storage), null);
  assert.equal(JSON.parse(storage.getItem(promptCacheStorageKey) || "{}")["task-2"], undefined);
});
