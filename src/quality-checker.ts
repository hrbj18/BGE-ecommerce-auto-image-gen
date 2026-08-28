import type { QualityCheckResult } from "./types.ts";
import { getImageMetadata } from "./image-utils.ts";

export async function checkGeneratedImage(options: {
  filePath: string;
  expectedWidth: number;
  expectedHeight: number;
  brandApplied: boolean;
  safeArea: boolean;
  minBytes?: number;
}): Promise<QualityCheckResult> {
  const metadata = await getImageMetadata(options.filePath);
  const fileSize = metadata.bytes >= (options.minBytes ?? 20_000);
  const dimensions = metadata.width === options.expectedWidth && metadata.height === options.expectedHeight;
  const expectedRatio = options.expectedWidth / options.expectedHeight;
  const actualRatio = metadata.width && metadata.height ? metadata.width / metadata.height : 0;
  const aspectRatio = Math.abs(expectedRatio - actualRatio) < 0.01;
  const checks = {
    fileSize,
    dimensions,
    aspectRatio,
    brandApplied: options.brandApplied,
    safeArea: options.safeArea
  };
  const warnings: string[] = [];
  if (!fileSize) warnings.push("文件体积过小，可能生成不完整。");
  if (!dimensions) warnings.push(`尺寸不符合 ${options.expectedWidth}x${options.expectedHeight}。`);
  if (!aspectRatio) warnings.push("图片比例不符合模板要求。");
  if (!options.brandApplied) warnings.push("品牌 Logo 或品牌模板未成功应用。");
  if (!options.safeArea) warnings.push("文字或 Logo 超出安全区。");
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    warnings
  };
}
