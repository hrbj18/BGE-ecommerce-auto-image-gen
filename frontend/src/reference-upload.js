const referenceImagePattern = /\.(png|jpe?g|webp|gif)$/i;

export function isReferenceImageFile(file) {
  return Boolean(file?.type?.startsWith("image/") || referenceImagePattern.test(file?.name || ""));
}

export function referenceFileFingerprint(file) {
  const name = String(file?.name || "").trim().toLowerCase();
  const size = Number.isFinite(Number(file?.size)) ? Number(file.size) : 0;
  const lastModified = Number.isFinite(Number(file?.lastModified)) ? Number(file.lastModified) : 0;
  return `${name}\u0000${size}\u0000${lastModified}`;
}

export function planReferenceFileAddition(currentItems, incomingItems, limit = 5) {
  const currentFiles = Array.from(currentItems ?? []).map((item) => item?.file ?? item);
  const incomingFiles = Array.from(incomingItems ?? []);
  const normalizedLimit = Number.isInteger(limit) && limit >= 0 ? limit : 5;
  const available = Math.max(0, normalizedLimit - currentFiles.length);
  const knownFingerprints = new Set(currentFiles.map(referenceFileFingerprint));
  const incomingFingerprints = new Set();
  const accepted = [];
  let invalidCount = 0;
  let duplicateCount = 0;
  let overflowCount = 0;

  for (const file of incomingFiles) {
    if (!isReferenceImageFile(file)) {
      invalidCount += 1;
      continue;
    }

    const fingerprint = referenceFileFingerprint(file);
    if (knownFingerprints.has(fingerprint) || incomingFingerprints.has(fingerprint)) {
      duplicateCount += 1;
      continue;
    }
    incomingFingerprints.add(fingerprint);

    if (accepted.length >= available) {
      overflowCount += 1;
      continue;
    }
    accepted.push(file);
  }

  return {
    accepted,
    incomingCount: incomingFiles.length,
    invalidCount,
    duplicateCount,
    overflowCount,
    limit: normalizedLimit,
  };
}

function countPhrase(count, noun) {
  return `${count} ${noun}`;
}

export function referenceUploadFeedback(plan) {
  if (!plan?.incomingCount) return "请选择图片文件。";

  const skipped = [];
  if (plan.invalidCount) skipped.push(countPhrase(plan.invalidCount, "个非图片文件"));
  if (plan.duplicateCount) skipped.push(countPhrase(plan.duplicateCount, "张重复图片"));
  if (plan.overflowCount) skipped.push(countPhrase(plan.overflowCount, `张超出 ${plan.limit} 张上限的图片`));

  if (plan.accepted.length) {
    const accepted = `已添加 ${plan.accepted.length} 张参考图`;
    return skipped.length ? `${accepted}；已跳过${skipped.join("、")}。` : `${accepted}。`;
  }

  if (plan.overflowCount && skipped.length === 1) {
    return `最多上传 ${plan.limit} 张参考图，未添加新图片。`;
  }
  return skipped.length ? `未添加新图片；已跳过${skipped.join("、")}。` : "未添加新图片。";
}
