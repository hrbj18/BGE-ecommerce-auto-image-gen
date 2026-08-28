import fs from "node:fs/promises";
import path from "node:path";
import type { BrandProfile } from "./types.ts";
import { ensureDir } from "./fs-utils.ts";
import { getImageMetadata } from "./image-utils.ts";
import { importOptional } from "./module-loader.ts";

type SharpFactory = (input?: string | Buffer | Uint8Array | { create: Record<string, unknown> }) => SharpInstance;
type SharpInstance = {
  resize(width?: number, height?: number, options?: Record<string, unknown>): SharpInstance;
  flatten(options?: Record<string, unknown>): SharpInstance;
  jpeg(options?: Record<string, unknown>): SharpInstance;
  png(options?: Record<string, unknown>): SharpInstance;
  composite(input: { input: Buffer | string; top?: number; left?: number }[]): SharpInstance;
  toBuffer(): Promise<Buffer>;
  toFile(filePath: string): Promise<unknown>;
};

export async function renderBrandedMain(options: {
  backgroundPath: string;
  outputPath: string;
  brand: BrandProfile;
  title: string;
  subtitle: string;
  index: number;
}): Promise<{ width: number; height: number; bytes: number }> {
  const sharp = await requireSharp();
  await ensureDir(path.dirname(options.outputPath));
  const background = await sharp(options.backgroundPath)
    .resize(800, 800, { fit: "cover", position: "centre" })
    .flatten({ background: options.brand.backgroundColor })
    .jpeg({ quality: 93 })
    .toBuffer();
  const logo = await logoBuffer(sharp, options.brand.logoPath, 150, 64);
  const showCopy = options.index !== 1;
  const overlay = mainOverlaySvg({
    brand: options.brand,
    title: options.title,
    subtitle: options.subtitle,
    showCopy
  });
  const mainLayers: { input: Buffer | string; top?: number; left?: number }[] = [
    { input: Buffer.from(overlay), top: 0, left: 0 }
  ];
  if (logo) mainLayers.push({ input: logo, top: 34, left: 616 });
  await sharp(background)
    .composite(mainLayers)
    .jpeg({ quality: 94, mozjpeg: true })
    .toFile(options.outputPath);
  return getImageMetadata(options.outputPath);
}

export async function renderDetailModule(options: {
  backgroundPath: string;
  productImagePath: string;
  outputPath: string;
  brand: BrandProfile;
  moduleIndex: number;
  eyebrow: string;
  title: string;
  bodyLines: string[];
}): Promise<{ width: number; height: number; bytes: number }> {
  const sharp = await requireSharp();
  await ensureDir(path.dirname(options.outputPath));
  const width = 750;
  const height = 1000;
  const background = await sharp(options.backgroundPath)
    .resize(width, height, { fit: "cover", position: "centre" })
    .flatten({ background: options.brand.backgroundColor })
    .jpeg({ quality: 91 })
    .toBuffer();
  const product = await sharp(options.productImagePath)
    .resize(500, 500, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: options.brand.backgroundColor })
    .jpeg({ quality: 92 })
    .toBuffer();
  const logo = await logoBuffer(sharp, options.brand.logoPath, 150, 64);
  const productTop = options.moduleIndex === 1 || options.moduleIndex === 8 ? 290 : 350;
  const overlay = detailOverlaySvg(options);
  const detailLayers: { input: Buffer | string; top?: number; left?: number }[] = [
      { input: Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="${options.brand.backgroundColor}" opacity="0.78"/></svg>`), top: 0, left: 0 },
      { input: product, top: productTop, left: 125 },
      { input: Buffer.from(overlay), top: 0, left: 0 }
  ];
  if (logo) detailLayers.push({ input: logo, top: 36, left: 566 });
  await sharp(background)
    .composite(detailLayers)
    .jpeg({ quality: 94, mozjpeg: true })
    .toFile(options.outputPath);
  return getImageMetadata(options.outputPath);
}

async function logoBuffer(sharp: SharpFactory, logoPath: string, width: number, height: number): Promise<Buffer | null> {
  if (!logoPath) return null;
  try {
    await fs.access(logoPath);
    return sharp(logoPath).resize(width, height, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch {
    return null;
  }
}

function mainOverlaySvg(options: {
  brand: BrandProfile;
  title: string;
  subtitle: string;
  showCopy: boolean;
}): string {
  const titleLines = wrapText(options.title, 13, 2);
  const subtitleLines = wrapText(options.subtitle, 22, 2);
  return `
<svg width="800" height="800" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="14" height="800" fill="${options.brand.primaryColor}"/>
  <rect x="42" y="42" width="716" height="716" fill="none" stroke="${options.brand.primaryColor}" stroke-width="2" opacity="0.3"/>
  ${options.showCopy ? `
  <rect x="44" y="548" width="712" height="210" fill="${options.brand.backgroundColor}" opacity="0.94"/>
  <rect x="44" y="548" width="12" height="210" fill="${options.brand.secondaryColor}"/>
  ${svgTextLines(titleLines, 82, 616, 43, 48, options.brand.titleFont, options.brand.primaryColor, 700)}
  ${svgTextLines(subtitleLines, 84, 698, 30, 26, options.brand.bodyFont, "#334155", 400)}
  ` : ""}
</svg>`;
}

function detailOverlaySvg(options: {
  brand: BrandProfile;
  moduleIndex: number;
  eyebrow: string;
  title: string;
  bodyLines: string[];
}): string {
  const titleLines = wrapText(options.title, 14, 2);
  const body = options.bodyLines.flatMap((line) => wrapText(line, 25, 2)).slice(0, 5);
  return `
<svg width="750" height="1000" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="18" height="1000" fill="${options.brand.primaryColor}"/>
  <rect x="44" y="42" width="662" height="916" fill="none" stroke="${options.brand.primaryColor}" stroke-width="2" opacity="0.35"/>
  <rect x="62" y="92" width="118" height="36" rx="18" fill="${options.brand.secondaryColor}"/>
  <text x="121" y="117" text-anchor="middle" font-size="18" font-family="${escapeXml(options.brand.bodyFont)}" fill="${contrastText(options.brand.secondaryColor)}">${escapeXml(options.eyebrow)}</text>
  ${svgTextLines(titleLines, 62, 190, 55, 50, options.brand.titleFont, options.brand.primaryColor, 700)}
  <rect x="62" y="304" width="110" height="5" fill="${options.brand.secondaryColor}"/>
  ${svgTextLines(body, 74, 842, 32, 29, options.brand.bodyFont, "#334155", 400)}
  <text x="676" y="930" text-anchor="end" font-size="18" font-family="${escapeXml(options.brand.bodyFont)}" fill="${options.brand.primaryColor}" opacity="0.65">0${options.moduleIndex}</text>
</svg>`;
}

function svgTextLines(
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
  fontSize: number,
  fontFamily: string,
  fill: string,
  fontWeight: number
): string {
  return lines.map((line, index) =>
    `<text x="${x}" y="${y + index * lineHeight}" font-size="${fontSize}" font-weight="${fontWeight}" font-family="${escapeXml(fontFamily)}" fill="${fill}">${escapeXml(line)}</text>`
  ).join("");
}

export function wrapText(value: string, maxUnits: number, maxLines: number): string[] {
  const clean = value.trim();
  if (!clean) return [];
  const lines: string[] = [];
  let current = "";
  let units = 0;
  for (const character of clean) {
    const size = /[\u0000-\u00ff]/.test(character) ? 0.55 : 1;
    if (current && units + size > maxUnits) {
      lines.push(current);
      current = "";
      units = 0;
      if (lines.length === maxLines) break;
    }
    current += character;
    units += size;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.join("").length < clean.length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.。…]+$/, "")}…`;
  }
  return lines;
}

function contrastText(hex: string): string {
  const normalized = hex.slice(1);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 170 ? "#1f2937" : "#ffffff";
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;"
  })[character] ?? character);
}

async function requireSharp(): Promise<SharpFactory> {
  const module = await importOptional<{ default?: SharpFactory } & SharpFactory>("sharp");
  const sharp = module?.default ?? module;
  if (!sharp) {
    throw new Error("缺少依赖 sharp，请先运行 npm install。");
  }
  return sharp;
}
