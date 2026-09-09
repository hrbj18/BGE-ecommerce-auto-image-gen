const publicProfiles = [
  {
    id: "ecommerce-standard",
    label: "电商标准",
    summary: "主图 1:1 / 详情页 9:16",
    description: "方形主图适合货架展示，详情页保持移动端竖版阅读。",
    mainAspectRatio: "1:1",
    detailAspectRatio: "9:16",
  },
  {
    id: "portrait-main",
    label: "竖版主图",
    summary: "主图 3:4 / 详情页 9:16",
    description: "主图增加纵向展示空间，详情页继续使用 9:16。",
    mainAspectRatio: "3:4",
    detailAspectRatio: "9:16",
  },
];

const profileById = new Map(publicProfiles.map((profile) => [profile.id, Object.freeze(profile)]));

export const defaultImageAspectRatioProfileId = "ecommerce-standard";

export function listImageAspectRatioProfiles() {
  return publicProfiles.map((profile) => ({ ...profile }));
}

export function findImageAspectRatioProfile(value) {
  const id = String(value ?? "").trim().toLowerCase();
  return id ? profileById.get(id) ?? null : null;
}

export function resolveImageAspectRatioProfile(value) {
  return findImageAspectRatioProfile(value) ?? profileById.get(defaultImageAspectRatioProfileId);
}

export function imageAspectRatioProfileForTask(task) {
  const selected = findImageAspectRatioProfile(task?.imageAspectRatioProfileId);
  if (selected) return selected;
  const legacySuiteRatio = String(task?.suiteRatio ?? "").replaceAll(" ", "");
  if (/主图3:4\/详情页9:16/i.test(legacySuiteRatio) || /main3:4\/detail9:16/i.test(legacySuiteRatio)) {
    return profileById.get("portrait-main");
  }
  return profileById.get(defaultImageAspectRatioProfileId);
}

export function aspectRatioForRole(profile, role) {
  return role === "detail" ? profile.detailAspectRatio : profile.mainAspectRatio;
}
