const STANDARD_MAIN_IMAGE_COUNT = 5;
const STANDARD_DETAIL_IMAGE_COUNT = 8;

function imageCount(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const whole = Math.floor(parsed);
  return whole >= 0 && whole <= maximum ? whole : fallback;
}

/**
 * Uses the task's persisted delivery contract. Older records did not carry
 * counts, so they retain the historical 5+8 display instead of becoming 0+0.
 */
export function taskImageCounts(task) {
  return {
    main: imageCount(task?.mainImageCount, STANDARD_MAIN_IMAGE_COUNT, STANDARD_MAIN_IMAGE_COUNT),
    detail: imageCount(task?.detailImageCount, STANDARD_DETAIL_IMAGE_COUNT, STANDARD_DETAIL_IMAGE_COUNT),
  };
}

export function taskProgressLabel(task) {
  const counts = taskImageCounts(task);
  return `${counts.main} 主图 + ${counts.detail} 详情页`;
}
