export const promptCacheStorageKey = "bge-ecommerce-history-prompts-v1";

export function cachePromptSnapshot(task, storage = browserStorage()) {
  const snapshot = promptSnapshotFromTask(task);
  if (!snapshot.complete || !snapshot.id || !snapshot.promptText.trim()) return;
  const cache = readPromptCache(storage);
  const existing = cache[snapshot.id];
  if (existing?.complete && existing.promptText && !snapshot.complete) return;
  cache[snapshot.id] = snapshot;
  const entries = Object.values(cache)
    .filter((item) => item?.complete && item.promptText)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 200);
  writePromptCache(Object.fromEntries(entries.map((item) => [item.id, item])), storage);
}

export function promptSnapshotFromTask(task) {
  if (!task) return emptyPromptSnapshot();
  const candidates = [
    ["final-brief", task.finalBriefText],
    ["expanded-brief", task.expandedBriefText],
    ["raw-brief", task.rawBriefText],
  ];
  if (task.source && task.source !== "preview") candidates.push([task.source, task.promptText]);
  const [source, promptText] = candidates
    .map(([candidateSource, value]) => [candidateSource, completePromptText(value)])
    .find(([, value]) => value) || ["", ""];
  const id = String(task.id || task.taskId || "");
  return {
    id,
    taskId: String(task.taskId || task.id || ""),
    productName: String(task.productName || ""),
    originalProductName: String(task.originalProductName || task.productName || ""),
    visibleProductName: String(task.visibleProductName || ""),
    targetPlatform: String(task.targetPlatform || ""),
    outputLanguage: String(task.outputLanguage || ""),
    suiteRatio: String(task.suiteRatio || ""),
    outputId: String(task.output?.id || task.outputId || task.outputFolderName || ""),
    submittedAtLocal: String(task.submittedAtLocal || ""),
    source,
    promptText,
    complete: Boolean(promptText),
    promptLength: promptText.length,
    updatedAt: new Date().toISOString(),
  };
}

export function readCachedPromptSnapshot(id, storage = browserStorage()) {
  const cached = readPromptCache(storage)[String(id || "")] || null;
  if (!cached) return null;
  const snapshot = promptSnapshotFromTask(cached);
  return snapshot.complete ? snapshot : null;
}

export function readPromptCache(storage = browserStorage()) {
  try {
    const value = storage?.getItem(promptCacheStorageKey);
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writePromptCache(cache, storage = browserStorage()) {
  try {
    storage?.setItem(promptCacheStorageKey, JSON.stringify(cache));
  } catch {
    // Browser storage can be full or disabled; backend history remains authoritative.
  }
}

function emptyPromptSnapshot() {
  return { id: "", promptText: "", complete: false, source: "" };
}

function completePromptText(value) {
  const clean = String(value || "").trim();
  if (!clean || isTruncatedPreviewText(clean)) return "";
  return clean;
}

function isTruncatedPreviewText(value) {
  const clean = String(value || "").trim();
  return clean.endsWith("...") && !/[\r\n]/.test(clean);
}

function browserStorage() {
  return globalThis.window?.localStorage ?? globalThis.localStorage ?? null;
}
