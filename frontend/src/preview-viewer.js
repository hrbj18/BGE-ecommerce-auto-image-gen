export const previewZoomMin = 0.25;
export const previewZoomMax = 3;
export const previewZoomStep = 0.25;

export function clampPreviewZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(previewZoomMax, Math.max(previewZoomMin, Math.round(numeric * 100) / 100));
}

export function isCompositePreviewAsset(asset) {
  return String(asset?.id || "").startsWith("overview/");
}

export function relatedPreviewAssets(asset, assets = []) {
  const assetId = String(asset?.id || "");
  const relatedGroup = assetId === "overview/main" ? "main" : ["overview/detail", "overview/long"].includes(assetId) ? "detail" : "";
  return relatedGroup ? assets.filter((candidate) => candidate.group === relatedGroup) : [];
}

export function defaultPreviewMode(asset) {
  const assetId = String(asset?.id || "");
  if (["overview/main", "overview/detail"].includes(assetId)) return "overview";
  if (assetId === "overview/long") return "composite";
  return "single";
}

export function defaultPreviewFit(asset, mode = defaultPreviewMode(asset)) {
  if (mode === "composite" || String(asset?.id || "") === "overview/long") return "width";
  return "window";
}

export function previewModeLabel(asset) {
  return String(asset?.id || "") === "overview/long" ? "完整长图" : "拼接图";
}
