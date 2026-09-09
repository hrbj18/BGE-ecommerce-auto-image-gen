const profiles = [
  {
    id: "standard-5-8",
    label: "标准套图",
    summary: "5 主图 + 8 详情页",
    suiteRatio: "主图 1:1 / 详情页 9:16",
    mainImageCount: 5,
    detailImageCount: 8,
  },
  {
    id: "compact-1-2",
    label: "极速验证套图",
    summary: "1 主图 + 2 详情页",
    suiteRatio: "主图 1:1 / 详情页 9:16",
    mainImageCount: 1,
    detailImageCount: 2,
  },
  {
    id: "compact-2-3",
    label: "轻量套图",
    summary: "2 主图 + 3 详情页",
    suiteRatio: "主图 1:1 / 详情页 9:16",
    mainImageCount: 2,
    detailImageCount: 3,
  },
  {
    id: "compact-3-4",
    label: "核心卖点套图",
    summary: "3 主图 + 4 详情页",
    suiteRatio: "主图 1:1 / 详情页 9:16",
    mainImageCount: 3,
    detailImageCount: 4,
  },
];

const profileById = new Map(profiles.map((profile) => [profile.id, Object.freeze(profile)]));
const maxRegisteredDetailImageCount = Math.max(...profiles.map((profile) => profile.detailImageCount));

export const defaultGenerationProfileId = "standard-5-8";

export function listGenerationProfiles() {
  return profiles.map((profile) => ({ ...profile }));
}

export function findGenerationProfile(value) {
  const id = String(value ?? "").trim();
  return id ? profileById.get(id) ?? null : null;
}

export function resolveGenerationProfile(value) {
  return findGenerationProfile(value) ?? profileById.get(defaultGenerationProfileId);
}

export function detailImageCountForTask(task) {
  if (!task?.generateDetail) return 0;
  const profile = findGenerationProfile(task?.generationProfileId);
  if (profile) return profile.detailImageCount;
  const explicit = Number(task?.detailImageCount);
  if (Number.isInteger(explicit) && explicit >= 0 && explicit <= maxRegisteredDetailImageCount) return explicit;
  return 8;
}

export function generationProfileForTask(task) {
  const profile = findGenerationProfile(task?.generationProfileId);
  if (profile) return profile;
  const detailImageCount = detailImageCountForTask(task);
  return {
    id: "legacy-custom",
    label: "历史套图",
    summary: `${Number(task?.mainImageCount) || 5} 主图 + ${detailImageCount} 详情页`,
    suiteRatio: String(task?.suiteRatio || "主图 1:1 / 详情页 9:16"),
    mainImageCount: Number(task?.mainImageCount) || 5,
    detailImageCount,
  };
}

export function overviewFilename(kind, count) {
  const prefix = kind === "detail" ? "详情页" : "主图";
  return `${count}张${prefix}总览.jpg`;
}
