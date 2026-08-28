import fs from "node:fs/promises";
import path from "node:path";
import { importOptional } from "./module-loader.ts";
import { ensureDir } from "./fs-utils.ts";

type SharpModule = {
  default?: SharpFactory;
} & SharpFactory;

type SharpFactory = (input?: string | Buffer | Uint8Array | { create: Record<string, unknown> }) => SharpInstance;

type SharpInstance = {
  metadata(): Promise<{ width?: number; height?: number; format?: string }>;
  resize(width?: number, height?: number, options?: Record<string, unknown>): SharpInstance;
  flatten(options?: Record<string, unknown>): SharpInstance;
  jpeg(options?: Record<string, unknown>): SharpInstance;
  png(options?: Record<string, unknown>): SharpInstance;
  composite(input: { input: Buffer | string; top?: number; left?: number }[]): SharpInstance;
  extend(options: Record<string, unknown>): SharpInstance;
  toBuffer(): Promise<Buffer>;
  toFile(filePath: string): Promise<unknown>;
};

export interface ImageMetadata {
  width: number;
  height: number;
  format?: string;
  bytes: number;
}

export async function getImageMetadata(filePath: string): Promise<ImageMetadata> {
  const stat = await fs.stat(filePath);
  const sharp = await getSharp();
  if (!sharp) {
    return { width: 0, height: 0, bytes: stat.size };
  }

  const metadata = await sharp(filePath).metadata();
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    format: metadata.format,
    bytes: stat.size
  };
}

export async function normalizeSquareImage(inputPath: string, outputPath: string, size = 800): Promise<ImageMetadata> {
  await ensureDir(path.dirname(outputPath));
  const sharp = await getSharp();
  if (!sharp) {
    await fs.copyFile(inputPath, outputPath);
    return getImageMetadata(outputPath);
  }

  await sharp(inputPath)
    .resize(size, size, { fit: "cover", position: "centre" })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outputPath);
  return getImageMetadata(outputPath);
}

export async function createDetailLongImage(options: {
  outputPath: string;
  productImagePath: string;
  title: string;
  sellingPoints: string[];
  specs: string[];
  referenceSummary: string;
}): Promise<ImageMetadata> {
  const width = 750;
  const height = 1800;
  const sharp = await getSharp();
  await ensureDir(path.dirname(options.outputPath));

  if (!sharp) {
    await fs.copyFile(options.productImagePath, options.outputPath);
    return getImageMetadata(options.outputPath);
  }

  const textSvg = buildDetailSvg({
    width,
    height,
    title: options.title,
    sellingPoints: options.sellingPoints,
    specs: options.specs,
    referenceSummary: options.referenceSummary
  });
  const productBuffer = await sharp(options.productImagePath)
    .resize(560, 560, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92 })
    .toBuffer();

  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#f7f4ef"
    }
  })
    .composite([
      { input: Buffer.from(textSvg), top: 0, left: 0 },
      { input: productBuffer, top: 180, left: 95 }
    ])
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(options.outputPath);

  return getImageMetadata(options.outputPath);
}

export async function assertImageLooksValid(filePath: string, expected: { minBytes?: number; minWidth?: number; minHeight?: number }): Promise<ImageMetadata> {
  const metadata = await getImageMetadata(filePath);
  const minBytes = expected.minBytes ?? 10_000;
  const minWidth = expected.minWidth ?? 1;
  const minHeight = expected.minHeight ?? 1;
  if (metadata.bytes < minBytes) {
    throw new Error(`Generated image is too small: ${filePath} (${metadata.bytes} bytes)`);
  }
  if (metadata.width && metadata.width < minWidth) {
    throw new Error(`Generated image width is too small: ${filePath} (${metadata.width}px)`);
  }
  if (metadata.height && metadata.height < minHeight) {
    throw new Error(`Generated image height is too small: ${filePath} (${metadata.height}px)`);
  }
  return metadata;
}

async function getSharp(): Promise<SharpFactory | null> {
  const sharpModule = await importOptional<SharpModule>("sharp");
  if (!sharpModule) {
    return null;
  }
  return sharpModule.default ?? sharpModule;
}

function buildDetailSvg(options: {
  width: number;
  height: number;
  title: string;
  sellingPoints: string[];
  specs: string[];
  referenceSummary: string;
}): string {
  const title = escapeXml(options.title);
  const sellingPoints = options.sellingPoints.length ? options.sellingPoints : ["核心卖点清晰呈现", "场景氛围自然真实", "细节参数一目了然"];
  const specs = options.specs.length ? options.specs : ["规格参数请在飞书表格补充"];

  return `
<svg width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${options.width}" height="${options.height}" fill="#f7f4ef"/>
  <rect x="48" y="54" width="654" height="92" rx="0" fill="#14213d"/>
  <text x="375" y="113" text-anchor="middle" font-size="36" font-weight="700" font-family="PingFang SC, Hiragino Sans GB, Arial" fill="#ffffff">${title}</text>
  <text x="64" y="820" font-size="34" font-weight="700" font-family="PingFang SC, Hiragino Sans GB, Arial" fill="#14213d">核心卖点</text>
  ${sellingPoints
    .slice(0, 5)
    .map((point, index) => `
  <rect x="64" y="${865 + index * 86}" width="622" height="58" rx="0" fill="#ffffff"/>
  <circle cx="92" cy="${895 + index * 86}" r="10" fill="#fca311"/>
  <text x="120" y="${906 + index * 86}" font-size="24" font-family="PingFang SC, Hiragino Sans GB, Arial" fill="#1f2933">${escapeXml(point)}</text>`)
    .join("")}
  <text x="64" y="1340" font-size="34" font-weight="700" font-family="PingFang SC, Hiragino Sans GB, Arial" fill="#14213d">规格参数</text>
  ${specs
    .slice(0, 5)
    .map((spec, index) => `
  <text x="64" y="${1395 + index * 46}" font-size="23" font-family="PingFang SC, Hiragino Sans GB, Arial" fill="#344054">${escapeXml(spec)}</text>`)
    .join("")}
  <rect x="48" y="1640" width="654" height="82" rx="0" fill="#ffffff"/>
  <text x="375" y="1692" text-anchor="middle" font-size="22" font-family="PingFang SC, Hiragino Sans GB, Arial" fill="#475467">实拍质感 · 场景展示 · 参数清晰</text>
</svg>`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => {
    switch (character) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return character;
    }
  });
}
