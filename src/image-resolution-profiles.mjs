const publicProfiles = [
  {
    id: "720p",
    label: "720P 预览",
    summary: "720P 预览",
    description: "以供应商最低 1K 生成后缩小，提升页面加载与下载速度；生图耗时接近 1K。",
    providerResolution: "1k",
    mainWidth: 720,
    mainHeight: 720,
    detailWidth: 720,
    detailHeight: 1280,
    nativeProviderSize: false,
  },
  {
    id: "1k",
    label: "1K 快速",
    summary: "1K 快速",
    description: "供应商原生 1K，适合快速验证构图、卖点和商品一致性。",
    providerResolution: "1k",
    mainWidth: 1024,
    mainHeight: 1024,
    detailWidth: 1024,
    detailHeight: evenPortraitHeight(1024),
    nativeProviderSize: true,
  },
  {
    id: "2k",
    label: "2K 标准",
    summary: "2K 标准",
    description: "当前标准交付清晰度，适合正式成品。",
    providerResolution: "2k",
    mainWidth: 2048,
    mainHeight: 2048,
    detailWidth: 2048,
    detailHeight: evenPortraitHeight(2048),
    nativeProviderSize: true,
  },
];

const legacyFourKProfile = {
  id: "4k",
  label: "4K 兼容",
  summary: "4K 兼容",
  description: "仅兼容既有本地配置，当前不在用户界面开放。",
  providerResolution: "4k",
  mainWidth: 4096,
  mainHeight: 4096,
  detailWidth: 4096,
  detailHeight: evenPortraitHeight(4096),
  nativeProviderSize: true,
};

const publicProfileById = new Map(publicProfiles.map((profile) => [profile.id, Object.freeze(profile)]));
const allProfileById = new Map([
  ...publicProfileById.entries(),
  [legacyFourKProfile.id, Object.freeze(legacyFourKProfile)],
]);

export const defaultImageResolutionId = "2k";

export function listImageResolutionProfiles() {
  return publicProfiles.map((profile) => ({ ...profile }));
}

export function findImageResolutionProfile(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return id ? publicProfileById.get(id) ?? null : null;
}

export function resolveImageResolutionProfile(value) {
  return findImageResolutionProfile(value) ?? publicProfileById.get(defaultImageResolutionId);
}

export function imageResolutionProfileForTask(task, fallbackResolution = defaultImageResolutionId) {
  const requested = String(task?.imageResolutionId ?? "").trim().toLowerCase();
  if (requested && allProfileById.has(requested)) return allProfileById.get(requested);
  const fallback = String(fallbackResolution ?? "").trim().toLowerCase();
  return allProfileById.get(fallback) ?? publicProfileById.get(defaultImageResolutionId);
}

export function imageDimensionsForRole(profile, role, aspectRatio) {
  const width = role === "detail" ? profile.detailWidth : profile.mainWidth;
  const ratio = aspectRatio || (role === "detail" ? "9:16" : "1:1");
  if (ratio === "3:4") return { width, height: evenScaledHeight(width, 4, 3) };
  if (ratio === "9:16") return { width, height: evenScaledHeight(width, 16, 9) };
  return { width, height: width };
}

function evenPortraitHeight(width) {
  return evenScaledHeight(width, 16, 9);
}

function evenScaledHeight(width, numerator, denominator) {
  const raw = Math.ceil(width * numerator / denominator);
  return raw % 2 === 0 ? raw : raw + 1;
}
