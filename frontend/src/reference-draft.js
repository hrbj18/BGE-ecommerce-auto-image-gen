const databaseName = "bge-ecommerce-workbench";
const databaseVersion = 1;
const storeName = "reference-drafts";

export function referenceDraftScope(portalUser) {
  const username = String(portalUser?.username || "").trim();
  return username ? `portal:${username}` : "local-workbench";
}

export function referenceDraftSnapshot(images) {
  return Array.from(images || []).map((image) => ({
    id: String(image.id || ""),
    file: image.file,
    originalName: String(image.originalName || image.file?.name || "参考图"),
    role: String(image.role || "细节图"),
    useForExpansion: image.useForExpansion !== false,
    type: String(image.file?.type || "application/octet-stream"),
    lastModified: Number(image.file?.lastModified || Date.now()),
  }));
}

export function restoreReferenceDraft(items, createObjectUrl = (file) => URL.createObjectURL(file)) {
  return Array.from(items || []).flatMap((item, index) => {
    const stored = item?.file;
    if (!(stored instanceof Blob)) return [];
    const originalName = String(item.originalName || stored.name || `参考图${index + 1}.png`);
    const file = stored instanceof File && stored.name === originalName
      ? stored
      : new File([stored], originalName, {
          type: String(item.type || stored.type || "application/octet-stream"),
          lastModified: Number(item.lastModified || Date.now()),
        });
    return [{
      id: String(item.id || `${Date.now()}-${index}`),
      file,
      previewUrl: createObjectUrl(file),
      originalName,
      role: String(item.role || (index === 0 ? "主参考图" : "细节图")),
      useForExpansion: item.useForExpansion !== false,
    }];
  });
}

export async function loadReferenceDraft(scope) {
  if (!scope || typeof indexedDB === "undefined") return [];
  const db = await openDraftDatabase();
  try {
    const record = await requestResult(db.transaction(storeName, "readonly").objectStore(storeName).get(scope));
    return Array.isArray(record?.images) ? record.images : [];
  } finally {
    db.close();
  }
}

export async function saveReferenceDraft(scope, images) {
  if (!scope || typeof indexedDB === "undefined") return;
  const db = await openDraftDatabase();
  try {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put({ scope, images: referenceDraftSnapshot(images), updatedAt: Date.now() });
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

function openDraftDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "scope" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开参考图草稿数据库。"));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("读取参考图草稿失败。"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("保存参考图草稿失败。"));
    transaction.onabort = () => reject(transaction.error || new Error("保存参考图草稿已中止。"));
  });
}
