import fs from "node:fs/promises";
import path from "node:path";
import type { BrandProfile, ProductTask, TaskSource, TaskStatus } from "./types.ts";
import { fileExists, safeSegment } from "./fs-utils.ts";
import { importOptional } from "./module-loader.ts";

type SheetRow = Record<string, unknown>;

type XlsxModule = {
  readFile(filePath: string): Workbook;
  writeFile(workbook: Workbook, filePath: string): void;
  utils: {
    sheet_to_json<T>(sheet: Worksheet, options?: Record<string, unknown>): T[];
    json_to_sheet(rows: SheetRow[], options?: Record<string, unknown>): Worksheet;
    decode_range(range: string): { s: { r: number; c: number }; e: { r: number; c: number } };
    encode_cell(cell: { r: number; c: number }): string;
  };
};

type Worksheet = Record<string, unknown> & { "!ref"?: string };
type Workbook = {
  SheetNames: string[];
  Sheets: Record<string, Worksheet>;
};

const TASK_SHEET = "作图任务";
const BRAND_SHEET = "品牌配置";

const TASK_HEADERS = {
  sku: "SKU",
  brandId: "品牌ID",
  productName: "商品名称",
  targetAudience: "人群",
  targetPlatform: "目标平台",
  category: "类目",
  materialDir: "本地素材文件夹",
  mainProductImage: "主商品图文件名",
  sellingPoints: "卖点",
  specs: "规格参数",
  referenceKeywords: "参考关键词",
  referenceProductUrls: "参考商品链接",
  bannedElements: "禁用元素",
  notes: "特殊要求",
  mainImageCount: "主图数量",
  generateDetail: "生成详情页",
  imageRatio: "图片比例",
  status: "状态",
  outputDir: "输出文件夹",
  report: "生成报告",
  errorMessage: "错误信息"
} as const;

export class ExcelTaskSource implements TaskSource {
  private readonly workbookPath: string;
  private readonly workspaceDir: string;
  private readonly requireLogo: boolean;

  constructor(options: { workbookPath: string; workspaceDir: string; requireLogo?: boolean }) {
    this.workbookPath = path.resolve(options.workbookPath);
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.requireLogo = options.requireLogo ?? true;
  }

  async listPendingTasks(limit: number): Promise<ProductTask[]> {
    const xlsx = await loadXlsx();
    const { workbook, rows } = await this.readTaskRows();
    const sheet = workbook.Sheets[TASK_SHEET];
    const tasks: ProductTask[] = [];
    const skuCounts = new Map<string, number>();
    let workbookChanged = false;
    for (const row of rows) {
      const sku = text(row[TASK_HEADERS.sku]);
      if (sku) skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1);
    }
    const columns = readHeaderColumns(xlsx, sheet);

    for (const [index, row] of rows.entries()) {
      const sku = text(row[TASK_HEADERS.sku]);
      if (!sku || text(row[TASK_HEADERS.status]) !== "待生成") {
        continue;
      }
      if ((skuCounts.get(sku) ?? 0) > 1) {
        setCell(xlsx, sheet, index + 1, columns[TASK_HEADERS.status], "失败");
        setCell(xlsx, sheet, index + 1, columns[TASK_HEADERS.errorMessage], `Excel 中存在重复 SKU：${sku}`);
        workbookChanged = true;
        continue;
      }
      try {
        tasks.push(await this.parseTask(row, index + 2));
      } catch (error) {
        setCell(xlsx, sheet, index + 1, columns[TASK_HEADERS.status], "失败");
        setCell(
          xlsx,
          sheet,
          index + 1,
          columns[TASK_HEADERS.errorMessage],
          (error instanceof Error ? error.message : String(error)).slice(0, 1800)
        );
        workbookChanged = true;
      }
      if (tasks.length >= limit) {
        break;
      }
    }
    if (workbookChanged) await this.atomicWrite(xlsx, workbook);
    return tasks;
  }

  async updateTask(
    task: ProductTask,
    fields: { status?: TaskStatus; outputDir?: string; errorMessage?: string; report?: string }
  ): Promise<void> {
    const xlsx = await loadXlsx();
    const { workbook } = await this.readTaskRows();
    const sheet = workbook.Sheets[TASK_SHEET];
    const location = findTaskRow(xlsx, sheet, task.sku);
    if (!location) {
      throw new Error(`无法在 Excel 中找到 SKU：${task.sku}`);
    }
    if (fields.status !== undefined) setCell(xlsx, sheet, location.row, location.columns[TASK_HEADERS.status], fields.status);
    if (fields.outputDir !== undefined) setCell(xlsx, sheet, location.row, location.columns[TASK_HEADERS.outputDir], fields.outputDir);
    if (fields.errorMessage !== undefined) setCell(xlsx, sheet, location.row, location.columns[TASK_HEADERS.errorMessage], fields.errorMessage);
    if (fields.report !== undefined) setCell(xlsx, sheet, location.row, location.columns[TASK_HEADERS.report], fields.report);
    await this.atomicWrite(xlsx, workbook);
  }

  async getBrand(brandId: string): Promise<BrandProfile> {
    const xlsx = await loadXlsx();
    const workbook = xlsx.readFile(this.workbookPath);
    const sheet = workbook.Sheets[BRAND_SHEET];
    if (!sheet) {
      throw new Error(`Excel 缺少工作表：${BRAND_SHEET}`);
    }
    const rows = xlsx.utils.sheet_to_json<SheetRow>(sheet, { defval: "" });
    const row = rows.find((candidate) => text(candidate["品牌ID"]) === brandId);
    if (!row) {
      throw new Error(`品牌配置不存在：${brandId}`);
    }

    const primaryColor = color(row["主色"], "#14213d", "主色", brandId);
    const secondaryColor = color(row["辅色"], "#fca311", "辅色", brandId);
    const backgroundColor = color(row["背景色"], "#f7f4ef", "背景色", brandId);
    const logoPath = this.resolvePath(text(row["Logo路径"]));
    if (this.requireLogo && (!logoPath || !(await fileExists(logoPath)))) {
      throw new Error(`品牌 ${brandId} 的 Logo 不存在：${logoPath || "未填写"}`);
    }
    const referenceDir = this.resolvePath(text(row["风格参考图目录"]));

    return {
      id: brandId,
      name: text(row["品牌名称"]) || brandId,
      logoPath: logoPath && await fileExists(logoPath) ? logoPath : "",
      primaryColor,
      secondaryColor,
      backgroundColor,
      titleFont: text(row["标题字体"]) || "PingFang SC",
      bodyFont: text(row["正文字体"]) || "PingFang SC",
      positioning: text(row["品牌定位"]),
      visualKeywords: splitList(text(row["视觉关键词"])),
      slogan: text(row["品牌口号"]),
      referenceImagePaths: referenceDir ? await listImages(referenceDir) : [],
      bannedElements: text(row["统一禁用规则"])
    };
  }

  private async readTaskRows(): Promise<{ workbook: Workbook; rows: SheetRow[] }> {
    if (!(await fileExists(this.workbookPath))) {
      throw new Error(`任务 Excel 不存在：${this.workbookPath}`);
    }
    const xlsx = await loadXlsx();
    const workbook = xlsx.readFile(this.workbookPath);
    const sheet = workbook.Sheets[TASK_SHEET];
    if (!sheet) {
      throw new Error(`Excel 缺少工作表：${TASK_SHEET}`);
    }
    return {
      workbook,
      rows: xlsx.utils.sheet_to_json<SheetRow>(sheet, { defval: "" })
    };
  }

  private async parseTask(row: SheetRow, rowNumber: number): Promise<ProductTask> {
    const sku = required(row, TASK_HEADERS.sku, rowNumber);
    const brandId = required(row, TASK_HEADERS.brandId, rowNumber);
    const productName = required(row, TASK_HEADERS.productName, rowNumber);
    const materialDir = this.resolvePath(required(row, TASK_HEADERS.materialDir, rowNumber));
    const mainProductImage = required(row, TASK_HEADERS.mainProductImage, rowNumber);
    const primaryPath = path.resolve(materialDir, mainProductImage);
    if (!(await fileExists(primaryPath))) {
      throw new Error(`第 ${rowNumber} 行主商品图不存在：${primaryPath}`);
    }
    const localProductImages = [primaryPath, ...(await listImages(materialDir)).filter((item) => item !== primaryPath)];
    const requestedCount = numberValue(row[TASK_HEADERS.mainImageCount], 5);
    const outputValue = text(row[TASK_HEADERS.outputDir]) || `output/${safeSegment(sku)}`;

    return {
      recordId: `excel:${rowNumber}`,
      sku,
      brandId,
      productName,
      targetAudience: text(row[TASK_HEADERS.targetAudience]),
      targetPlatform: text(row[TASK_HEADERS.targetPlatform]),
      category: text(row[TASK_HEADERS.category]),
      productImages: [],
      localProductImages,
      referenceImageUrls: [],
      referenceProductUrls: normalizeUrls(row[TASK_HEADERS.referenceProductUrls]),
      materialDir,
      mainProductImage,
      outputDir: this.resolvePath(outputValue),
      sellingPoints: text(row[TASK_HEADERS.sellingPoints]),
      specs: text(row[TASK_HEADERS.specs]),
      bannedElements: text(row[TASK_HEADERS.bannedElements]),
      referenceKeywords: text(row[TASK_HEADERS.referenceKeywords]),
      notes: text(row[TASK_HEADERS.notes]),
      briefPath: undefined,
      mainImageCount: Math.min(5, Math.max(1, requestedCount)),
      generateDetail: !["否", "false", "0"].includes(text(row[TASK_HEADERS.generateDetail]).toLowerCase()),
      imageRatio: text(row[TASK_HEADERS.imageRatio]) || "1:1"
    };
  }

  private resolvePath(value: string): string {
    return path.resolve(this.workspaceDir, value || ".");
  }

  private async atomicWrite(xlsx: XlsxModule, workbook: Workbook): Promise<void> {
    const tempPath = `${this.workbookPath}.tmp.xlsx`;
    xlsx.writeFile(workbook, tempPath);
    await fs.rename(tempPath, this.workbookPath);
  }
}

async function loadXlsx(): Promise<XlsxModule> {
  const module = await importOptional<XlsxModule & { default?: XlsxModule }>("xlsx");
  const xlsx = module?.default ?? module;
  if (!xlsx) {
    throw new Error("缺少依赖 xlsx，请先运行 npm install。");
  }
  return xlsx;
}

function required(row: SheetRow, header: string, rowNumber: number): string {
  const value = text(row[header]);
  if (!value) {
    throw new Error(`Excel 第 ${rowNumber} 行缺少必填字段：${header}`);
  }
  return value;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(text(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function color(value: unknown, fallback: string, field: string, brandId: string): string {
  const candidate = text(value) || fallback;
  if (!/^#[0-9a-f]{6}$/i.test(candidate)) {
    throw new Error(`品牌 ${brandId} 的${field}不是合法的 #RRGGBB：${candidate}`);
  }
  return candidate.toLowerCase();
}

function splitList(value: string): string[] {
  return value.split(/[，,、;；\n]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeUrls(value: unknown): string[] {
  return text(value)
    .split(/[\r\n,，;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//i.test(item));
}

async function listImages(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
      .map((entry) => path.join(dirPath, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function findTaskRow(
  xlsx: XlsxModule,
  sheet: Worksheet,
  sku: string
): { row: number; columns: Record<string, number> } | null {
  if (!sheet["!ref"]) return null;
  const range = xlsx.utils.decode_range(sheet["!ref"]);
  const columns = readHeaderColumns(xlsx, sheet);
  const skuColumn = columns[TASK_HEADERS.sku];
  if (skuColumn === undefined) return null;
  for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
    const address = xlsx.utils.encode_cell({ r: row, c: skuColumn });
    const cell = sheet[address] as { v?: unknown } | undefined;
    if (text(cell?.v) === sku) return { row, columns };
  }
  return null;
}

function readHeaderColumns(xlsx: XlsxModule, sheet: Worksheet): Record<string, number> {
  if (!sheet["!ref"]) return {};
  const range = xlsx.utils.decode_range(sheet["!ref"]);
  const columns: Record<string, number> = {};
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const address = xlsx.utils.encode_cell({ r: range.s.r, c: column });
    const cell = sheet[address] as { v?: unknown } | undefined;
    const header = text(cell?.v);
    if (header) columns[header] = column;
  }
  return columns;
}

function setCell(xlsx: XlsxModule, sheet: Worksheet, row: number, column: number | undefined, value: string): void {
  if (column === undefined) {
    throw new Error("Excel 任务表缺少状态回写列。");
  }
  const address = xlsx.utils.encode_cell({ r: row, c: column });
  const existing = sheet[address] as Record<string, unknown> | undefined;
  sheet[address] = { ...existing, t: "s", v: value };
}
