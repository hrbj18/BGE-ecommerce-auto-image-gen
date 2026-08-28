import type { FeishuAttachment, ProductTask, RawFeishuRecord } from "./types.ts";

export const FIELDS = {
  sku: "SKU",
  productName: "商品名称",
  targetAudience: "人群",
  targetPlatform: "目标平台",
  category: "类目",
  productImages: "商品图",
  sellingPoints: "卖点",
  specs: "规格参数",
  bannedElements: "禁用元素",
  referenceKeywords: "参考关键词",
  referenceProductUrls: "参考商品链接",
  status: "状态",
  outputMainImages: "输出主图",
  outputDetailImage: "输出详情页",
  localArchivePath: "本地归档路径",
  referenceSummary: "竞品参考摘要",
  generationReport: "生成报告",
  errorMessage: "错误信息"
} as const;

export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .join("、")
      .trim();
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    if (typeof objectValue.text === "string") {
      return objectValue.text.trim();
    }
    if (typeof objectValue.name === "string") {
      return objectValue.name.trim();
    }
    if (typeof objectValue.value === "string") {
      return objectValue.value.trim();
    }
  }
  return "";
}

export function normalizeAttachments(value: unknown): FeishuAttachment[] {
  if (!value) {
    return [];
  }
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const raw = item as Record<string, unknown>;
      return {
        fileToken: normalizeText(raw.file_token ?? raw.fileToken ?? raw.token),
        name: normalizeText(raw.name ?? raw.file_name ?? raw.fileName),
        size: typeof raw.size === "number" ? raw.size : undefined,
        type: normalizeText(raw.type ?? raw.mime_type ?? raw.mimeType),
        url: normalizeText(raw.url),
        tmpUrl: normalizeText(raw.tmp_url ?? raw.tmpUrl),
        ...raw
      };
    });
}

function normalizeUrls(value: unknown): string[] {
  return normalizeText(value)
    .split(/[\r\n,，;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//i.test(item));
}

export function parseTask(record: RawFeishuRecord): ProductTask {
  const fields = record.fields;
  const task: ProductTask = {
    recordId: record.recordId,
    recordUrl: record.recordUrl,
    sku: normalizeText(fields[FIELDS.sku]),
    brandId: "default",
    productName: normalizeText(fields[FIELDS.productName]),
    targetAudience: normalizeText(fields[FIELDS.targetAudience]),
    targetPlatform: normalizeText(fields[FIELDS.targetPlatform]),
    category: normalizeText(fields[FIELDS.category]),
    productImages: normalizeAttachments(fields[FIELDS.productImages]),
    localProductImages: [],
    referenceImageUrls: [],
    referenceProductUrls: normalizeUrls(fields[FIELDS.referenceProductUrls]),
    materialDir: "",
    mainProductImage: "",
    sellingPoints: normalizeText(fields[FIELDS.sellingPoints]),
    specs: normalizeText(fields[FIELDS.specs]),
    bannedElements: normalizeText(fields[FIELDS.bannedElements]),
    referenceKeywords: normalizeText(fields[FIELDS.referenceKeywords]),
    notes: "",
    briefPath: undefined,
    mainImageCount: 5,
    generateDetail: true,
    imageRatio: "1:1"
  };
  validateTask(task);
  return task;
}

export function validateTask(task: ProductTask): void {
  const missing: string[] = [];
  if (!task.sku) {
    missing.push(FIELDS.sku);
  }
  if (!task.productName) {
    missing.push(FIELDS.productName);
  }
  if (!task.productImages.length) {
    missing.push(FIELDS.productImages);
  }
  if (missing.length) {
    throw new Error(`Missing required field(s): ${missing.join(", ")}`);
  }
}

export function feishuAttachmentField(files: { fileToken: string; name: string }[]): Record<string, string>[] {
  return files.map((file) => ({
    file_token: file.fileToken,
    name: file.name
  }));
}
