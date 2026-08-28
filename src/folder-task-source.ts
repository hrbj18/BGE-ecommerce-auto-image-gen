import fs from "node:fs/promises";
import path from "node:path";
import type { BrandProfile, ProductTask, TaskSource, TaskStatus } from "./types.ts";
import { ensureDir, fileExists, safeSegment, writeJson } from "./fs-utils.ts";

const IMAGE_PATTERN = /\.(png|jpe?g|webp)$/i;
const TASK_METADATA_FILE = "任务信息.json";

function matchesTargetTask(options: { productName: string; sku: string; materialDir: string; taskId?: string; folderName?: string }): boolean {
  const targetDir = process.env.TARGET_TASK_DIR?.trim();
  if (targetDir) return path.resolve(targetDir) === path.resolve(options.materialDir);
  const targetId = process.env.TARGET_TASK_ID?.trim();
  if (targetId) return options.taskId === targetId;
  const targetFolder = process.env.TARGET_TASK_FOLDER?.trim();
  if (targetFolder) return options.folderName === targetFolder || options.sku === targetFolder;
  const target = process.env.TARGET_PRODUCT_NAME?.trim();
  if (!target) return true;
  return options.productName === target || options.sku === target || safeSegment(target) === options.sku;
}

export class FolderTaskSource implements TaskSource {
  private readonly inputDir: string;
  private readonly outputDir: string;
  private readonly workspaceDir: string;
  private readonly forceRegenerate: boolean;

  constructor(options: { inputDir: string; outputDir: string; workspaceDir: string; forceRegenerate?: boolean }) {
    this.inputDir = path.resolve(options.inputDir);
    this.outputDir = path.resolve(options.outputDir);
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.forceRegenerate = options.forceRegenerate ?? false;
  }

  async listPendingTasks(limit: number): Promise<ProductTask[]> {
    await ensureDir(this.inputDir);
    await ensureDir(this.outputDir);
    const entries = await fs.readdir(this.inputDir, { withFileTypes: true });
    const imageFiles = entries
      .filter((entry) => entry.isFile() && IMAGE_PATTERN.test(entry.name) && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "zh-CN"));

    const groups: Array<{ productName: string; images: string[]; materialDir: string }> = [];
    const rootGroups = new Map<string, string[]>();
    for (const fileName of imageFiles) {
      const productName = productNameFromFile(fileName);
      const group = rootGroups.get(productName) ?? [];
      group.push(path.join(this.inputDir, fileName));
      rootGroups.set(productName, group);
    }
    for (const [productName, images] of rootGroups) {
      groups.push({ productName, images, materialDir: this.inputDir });
    }

    const productDirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "品牌参考")
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
    for (const dirName of productDirs) {
      const materialDir = path.join(this.inputDir, dirName);
      const images = await listImages(materialDir);
      if (images.length) groups.push({ productName: dirName.trim(), images, materialDir });
    }

    const tasks: ProductTask[] = [];
    for (const { productName, images, materialDir } of groups) {
      const metadata = await readOptionalMetadata(materialDir, productName);
      const finalProductName = metadata.productName || productName;
      const folderName = path.basename(materialDir);
      const sku = safeSegment(metadata.outputFolderName || metadata.inputFolderName || (metadata.taskId ? folderName : finalProductName));
      if (!matchesTargetTask({ productName: finalProductName, sku, materialDir, taskId: metadata.taskId, folderName })) continue;
      const statusPath = path.join(this.outputDir, sku, "folder-status.json");
      if (!this.forceRegenerate && await isCompleted(statusPath, images, metadata.briefPath)) continue;
      tasks.push({
        recordId: `folder:${sku}`,
        taskId: metadata.taskId,
        submittedAt: metadata.submittedAt,
        submittedAtLocal: metadata.submittedAtLocal,
        inputFolderName: metadata.inputFolderName || folderName,
        outputFolderName: metadata.outputFolderName || sku,
        sku,
        brandId: metadata.brandId || "folder-default",
        productName: finalProductName,
        originalProductName: metadata.originalProductName || finalProductName,
        visibleProductName: metadata.visibleProductName,
        targetAudience: metadata.targetAudience,
        targetPlatform: metadata.targetPlatform,
        outputLanguage: metadata.outputLanguage,
        category: metadata.category,
        productImages: [],
        localProductImages: images,
        referenceImageUrls: metadata.referenceImageUrls,
        referenceProductUrls: metadata.referenceProductUrls,
        materialDir,
        mainProductImage: path.basename(images[0]),
        outputDir: path.join(this.outputDir, sku),
        sellingPoints: metadata.sellingPoints,
        specs: metadata.specs,
        bannedElements: metadata.bannedElements,
        referenceKeywords: metadata.referenceKeywords,
        notes: metadata.notes,
        briefPath: metadata.briefPath,
        suiteRatio: metadata.suiteRatio,
        briefFocus: metadata.briefFocus,
        commonRuleProfile: metadata.commonRuleProfile,
        commonRuleName: metadata.commonRuleName,
        commonRuleFile: metadata.commonRuleFile,
        commonRuleVersion: metadata.commonRuleVersion,
        commonRuleReason: metadata.commonRuleReason,
        commonRuleText: metadata.commonRuleText,
        commonRuleMatchedKeywords: metadata.commonRuleMatchedKeywords,
        platformRuleProfile: metadata.platformRuleProfile,
        platformRuleName: metadata.platformRuleName,
        platformRuleFile: metadata.platformRuleFile,
        platformRuleVersion: metadata.platformRuleVersion,
        platformRuleReason: metadata.platformRuleReason,
        platformRuleText: metadata.platformRuleText,
        platformRuleMatchedKeywords: metadata.platformRuleMatchedKeywords,
        languageRuleProfile: metadata.languageRuleProfile,
        languageRuleName: metadata.languageRuleName,
        languageRuleFile: metadata.languageRuleFile,
        languageRuleVersion: metadata.languageRuleVersion,
        languageRuleReason: metadata.languageRuleReason,
        languageRuleText: metadata.languageRuleText,
        languageRuleMatchedKeywords: metadata.languageRuleMatchedKeywords,
        generationRuleProfile: metadata.generationRuleProfile,
        generationRuleName: metadata.generationRuleName,
        generationRuleFile: metadata.generationRuleFile,
        generationRuleVersion: metadata.generationRuleVersion,
        generationRuleReason: metadata.generationRuleReason,
        generationRuleText: metadata.generationRuleText,
        generationRuleMatchedKeywords: metadata.generationRuleMatchedKeywords,
        mainImageCount: 5,
        generateDetail: metadata.generateDetail,
        imageRatio: "1:1"
      });
      if (tasks.length >= limit) break;
    }
    return tasks;
  }

  async updateTask(
    task: ProductTask,
    fields: { status?: TaskStatus; outputDir?: string; errorMessage?: string; report?: string }
  ): Promise<void> {
    const outputDir = fields.outputDir || task.outputDir || path.join(this.outputDir, safeSegment(task.sku));
    await ensureDir(outputDir);
    const statusPath = path.join(outputDir, "folder-status.json");
    const previous = await readJson(statusPath);
    await writeJson(statusPath, {
      ...previous,
      taskId: task.taskId ?? previous.taskId ?? "",
      submittedAt: task.submittedAt ?? previous.submittedAt ?? "",
      submittedAtLocal: task.submittedAtLocal ?? previous.submittedAtLocal ?? "",
      productName: task.productName,
      originalProductName: task.originalProductName ?? previous.originalProductName ?? task.productName,
      visibleProductName: task.visibleProductName ?? previous.visibleProductName ?? "",
      targetPlatform: task.targetPlatform ?? previous.targetPlatform ?? "",
      outputLanguage: task.outputLanguage ?? previous.outputLanguage ?? "",
      suiteRatio: task.suiteRatio ?? previous.suiteRatio ?? "",
      briefFocus: task.briefFocus ?? previous.briefFocus ?? "",
      inputFolderName: task.inputFolderName ?? previous.inputFolderName ?? path.basename(task.materialDir),
      outputFolderName: task.outputFolderName ?? previous.outputFolderName ?? task.sku,
      materialDir: path.relative(this.workspaceDir, task.materialDir),
      sourceImages: task.localProductImages.map((item) => path.relative(this.workspaceDir, item)),
      sourceSignature: await sourceSignature(task.localProductImages, task.briefPath),
      briefPath: task.briefPath ? path.relative(this.workspaceDir, task.briefPath) : "",
      commonRuleProfile: task.commonRuleProfile ?? previous.commonRuleProfile ?? "",
      commonRuleName: task.commonRuleName ?? previous.commonRuleName ?? "",
      commonRuleFile: task.commonRuleFile ?? previous.commonRuleFile ?? "",
      commonRuleVersion: task.commonRuleVersion ?? previous.commonRuleVersion ?? "",
      commonRuleReason: task.commonRuleReason ?? previous.commonRuleReason ?? "",
      commonRuleText: task.commonRuleText ?? previous.commonRuleText ?? "",
      commonRuleMatchedKeywords: task.commonRuleMatchedKeywords ?? previous.commonRuleMatchedKeywords ?? [],
      platformRuleProfile: task.platformRuleProfile ?? previous.platformRuleProfile ?? "",
      platformRuleName: task.platformRuleName ?? previous.platformRuleName ?? "",
      platformRuleFile: task.platformRuleFile ?? previous.platformRuleFile ?? "",
      platformRuleVersion: task.platformRuleVersion ?? previous.platformRuleVersion ?? "",
      platformRuleReason: task.platformRuleReason ?? previous.platformRuleReason ?? "",
      platformRuleText: task.platformRuleText ?? previous.platformRuleText ?? "",
      platformRuleMatchedKeywords: task.platformRuleMatchedKeywords ?? previous.platformRuleMatchedKeywords ?? [],
      languageRuleProfile: task.languageRuleProfile ?? previous.languageRuleProfile ?? "",
      languageRuleName: task.languageRuleName ?? previous.languageRuleName ?? "",
      languageRuleFile: task.languageRuleFile ?? previous.languageRuleFile ?? "",
      languageRuleVersion: task.languageRuleVersion ?? previous.languageRuleVersion ?? "",
      languageRuleReason: task.languageRuleReason ?? previous.languageRuleReason ?? "",
      languageRuleText: task.languageRuleText ?? previous.languageRuleText ?? "",
      languageRuleMatchedKeywords: task.languageRuleMatchedKeywords ?? previous.languageRuleMatchedKeywords ?? [],
      generationRuleProfile: task.generationRuleProfile ?? previous.generationRuleProfile ?? "",
      generationRuleName: task.generationRuleName ?? previous.generationRuleName ?? "",
      generationRuleFile: task.generationRuleFile ?? previous.generationRuleFile ?? "",
      generationRuleVersion: task.generationRuleVersion ?? previous.generationRuleVersion ?? "",
      generationRuleReason: task.generationRuleReason ?? previous.generationRuleReason ?? "",
      generationRuleText: task.generationRuleText ?? previous.generationRuleText ?? "",
      generationRuleMatchedKeywords: task.generationRuleMatchedKeywords ?? previous.generationRuleMatchedKeywords ?? [],
      status: fields.status ?? previous.status ?? "待生成",
      outputDir: path.relative(this.workspaceDir, outputDir),
      errorMessage: fields.errorMessage ?? previous.errorMessage ?? "",
      report: fields.report ?? previous.report ?? "",
      updatedAt: new Date().toISOString()
    });
  }

  async getBrand(_brandId: string): Promise<BrandProfile> {
    const configPath = path.join(this.inputDir, "品牌配置.json");
    const config = await readJson(configPath);
    const logoCandidate = text(config.logoPath);
    const logoPath = logoCandidate ? path.resolve(this.workspaceDir, logoCandidate) : "";
    return {
      id: "folder-default",
      name: text(config.brandName) || "自有品牌",
      logoPath: logoPath && await fileExists(logoPath) ? logoPath : "",
      primaryColor: validColor(config.primaryColor, "#3b2f2f"),
      secondaryColor: validColor(config.secondaryColor, "#d9a441"),
      backgroundColor: validColor(config.backgroundColor, "#f7f1e8"),
      titleFont: text(config.titleFont) || "PingFang SC",
      bodyFont: text(config.bodyFont) || "PingFang SC",
      positioning: text(config.positioning) || "质感、可信、适合日常使用",
      visualKeywords: splitList(text(config.visualKeywords) || "干净；高级；真实摄影；品牌留白"),
      slogan: text(config.slogan),
      referenceImagePaths: await listImages(path.join(this.inputDir, "品牌参考")),
      bannedElements: text(config.bannedElements) || "竞品商标；水印；廉价促销爆炸贴"
    };
  }
}

export function productNameFromFile(fileName: string): string {
  const extension = path.extname(fileName);
  return path.basename(fileName, extension)
    .replace(/__(?:\d+|正面|侧面|背面|细节)$/i, "")
    .replace(/[_-](?:\d+|正面|侧面|背面|细节)$/i, "")
    .trim();
}

async function isCompleted(statusPath: string, images: string[], briefPath?: string): Promise<boolean> {
  const status = await readJson(statusPath);
  if (text(status.status) !== "已完成") return false;
  return text(status.sourceSignature) === await sourceSignature(images, briefPath);
}

async function sourceSignature(images: string[], briefPath?: string): Promise<string> {
  const parts = await Promise.all(images.map(async (imagePath) => {
    const stat = await fs.stat(imagePath);
    return `${path.basename(imagePath)}:${stat.size}:${stat.mtimeMs}`;
  }));
  if (briefPath) {
    const stat = await fs.stat(briefPath);
    parts.push(`${path.basename(briefPath)}:${stat.size}:${stat.mtimeMs}`);
  }
  return parts.join("|");
}

async function readOptionalMetadata(inputDir: string, productName: string) {
  const markdown = await readMarkdownBrief(inputDir, productName);
  const taskMetadata = await readJson(path.join(inputDir, TASK_METADATA_FILE));
  const metadata = await readJson(path.join(inputDir, `${productName}.json`));
  return {
    taskId: text(taskMetadata.taskId ?? taskMetadata.id),
    submittedAt: text(taskMetadata.submittedAt),
    submittedAtLocal: text(taskMetadata.submittedAtLocal),
    inputFolderName: text(taskMetadata.inputFolderName ?? taskMetadata.folderName),
    outputFolderName: text(taskMetadata.outputFolderName ?? taskMetadata.folderName),
    productName: text(metadata.productName ?? metadata["产品名称"] ?? taskMetadata.productName) || markdown.productName,
    originalProductName: text(taskMetadata.originalProductName ?? metadata.originalProductName ?? metadata.productName ?? metadata["产品名称"]) || markdown.productName,
    visibleProductName: text(taskMetadata.visibleProductName ?? metadata.visibleProductName) || markdown.visibleProductName,
    brandId: text(metadata.brandId),
    targetAudience: text(metadata.targetAudience ?? metadata.audience ?? metadata["人群"] ?? metadata["目标人群"] ?? taskMetadata.targetAudience) || markdown.targetAudience,
    targetPlatform: text(metadata.targetPlatform ?? metadata.platform ?? metadata["目标平台"] ?? metadata["平台"] ?? taskMetadata.targetPlatform) || markdown.targetPlatform,
    outputLanguage: text(taskMetadata.outputLanguage ?? metadata.outputLanguage ?? metadata["输出语言"]) || markdown.outputLanguage,
    category: text(metadata.category ?? metadata["类目"]) || markdown.category,
    sellingPoints: businessText(metadata.sellingPoints ?? metadata["卖点"] ?? metadata["核心卖点"]) || businessText(markdown.sellingPoints),
    specs: businessText(metadata.specs ?? metadata["规格参数"]) || businessText(markdown.specs),
    bannedElements: text(metadata.bannedElements ?? metadata["禁用元素"]) || markdown.bannedElements,
    referenceKeywords: text(metadata.referenceKeywords ?? metadata["参考关键词"]) || markdown.referenceKeywords,
    notes: text(metadata.notes ?? metadata["特殊要求"] ?? metadata["备注"]) || markdown.notes,
    briefPath: markdown.briefPath,
    suiteRatio: text(taskMetadata.suiteRatio ?? metadata.suiteRatio ?? metadata["套图比例"]) || markdown.suiteRatio,
    briefFocus: businessText(taskMetadata.briefFocus ?? metadata.briefFocus ?? metadata["用户作图重点"]),
    commonRuleProfile: text(taskMetadata.commonRuleProfile ?? metadata.commonRuleProfile),
    commonRuleName: text(taskMetadata.commonRuleName ?? metadata.commonRuleName),
    commonRuleFile: text(taskMetadata.commonRuleFile ?? metadata.commonRuleFile),
    commonRuleVersion: text(taskMetadata.commonRuleVersion ?? metadata.commonRuleVersion),
    commonRuleReason: text(taskMetadata.commonRuleReason ?? metadata.commonRuleReason),
    commonRuleText: text(taskMetadata.commonRuleText ?? metadata.commonRuleText),
    commonRuleMatchedKeywords: normalizeTextList(
      taskMetadata.commonRuleMatchedKeywords ?? metadata.commonRuleMatchedKeywords
    ),
    platformRuleProfile: text(taskMetadata.platformRuleProfile ?? metadata.platformRuleProfile),
    platformRuleName: text(taskMetadata.platformRuleName ?? metadata.platformRuleName),
    platformRuleFile: text(taskMetadata.platformRuleFile ?? metadata.platformRuleFile),
    platformRuleVersion: text(taskMetadata.platformRuleVersion ?? metadata.platformRuleVersion),
    platformRuleReason: text(taskMetadata.platformRuleReason ?? metadata.platformRuleReason),
    platformRuleText: text(taskMetadata.platformRuleText ?? metadata.platformRuleText),
    platformRuleMatchedKeywords: normalizeTextList(
      taskMetadata.platformRuleMatchedKeywords ?? metadata.platformRuleMatchedKeywords
    ),
    languageRuleProfile: text(taskMetadata.languageRuleProfile ?? metadata.languageRuleProfile),
    languageRuleName: text(taskMetadata.languageRuleName ?? metadata.languageRuleName),
    languageRuleFile: text(taskMetadata.languageRuleFile ?? metadata.languageRuleFile),
    languageRuleVersion: text(taskMetadata.languageRuleVersion ?? metadata.languageRuleVersion),
    languageRuleReason: text(taskMetadata.languageRuleReason ?? metadata.languageRuleReason),
    languageRuleText: text(taskMetadata.languageRuleText ?? metadata.languageRuleText),
    languageRuleMatchedKeywords: normalizeTextList(
      taskMetadata.languageRuleMatchedKeywords ?? metadata.languageRuleMatchedKeywords
    ),
    generationRuleProfile: text(taskMetadata.generationRuleProfile ?? metadata.generationRuleProfile),
    generationRuleName: text(taskMetadata.generationRuleName ?? metadata.generationRuleName),
    generationRuleFile: text(taskMetadata.generationRuleFile ?? metadata.generationRuleFile),
    generationRuleVersion: text(taskMetadata.generationRuleVersion ?? metadata.generationRuleVersion),
    generationRuleReason: text(taskMetadata.generationRuleReason ?? metadata.generationRuleReason),
    generationRuleText: text(taskMetadata.generationRuleText ?? metadata.generationRuleText),
    generationRuleMatchedKeywords: normalizeTextList(
      taskMetadata.generationRuleMatchedKeywords ?? metadata.generationRuleMatchedKeywords
    ),
    referenceImageUrls: normalizeUrls(metadata.referenceImageUrls ?? metadata.image_urls ?? markdown.referenceImageUrls),
    referenceProductUrls: normalizeUrls(
      metadata.referenceProductUrls ??
        metadata.referenceUrls ??
        metadata.productUrls ??
        metadata["参考商品链接"] ??
        metadata["竞品链接"] ??
        metadata["天猫链接"] ??
        metadata["淘宝链接"] ??
        markdown.referenceProductUrls
    ),
    generateDetail: booleanValue(
      metadata.generateDetail ?? metadata["生成详情页"] ?? metadata["详情页"] ?? markdown.generateDetail,
      true
    )
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readMarkdownBrief(inputDir: string, productName: string) {
  const candidates = [
    path.join(inputDir, `${productName}.md`),
    path.join(inputDir, `${productName}.markdown`),
    path.join(inputDir, "产品信息.md"),
    path.join(inputDir, "商品信息.md"),
    path.join(inputDir, "需求模板.md"),
    path.join(inputDir, "需求.md"),
    path.join(inputDir, "brief.md")
  ];
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, "utf8");
      const values = parseMarkdownBrief(content);
      return { ...values, briefPath: candidate };
    } catch {
      // Try next candidate.
    }
  }
  return emptyBrief();
}

function parseMarkdownBrief(content: string) {
  const fields = new Map<string, string>();
  const bodyLines: string[] = [];
  let currentKey = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tableMatch = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
    if (tableMatch && !/^[-:]+$/.test(tableMatch[1].trim())) {
      appendBriefField(fields, normalizeBriefKey(tableMatch[1]), tableMatch[2].trim());
      currentKey = "";
      continue;
    }
    const normalizedLine = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[-*+]\s+/, "");
    if (currentKey && /^https?:\/\//i.test(normalizedLine)) {
      appendBriefField(fields, currentKey, normalizedLine);
      continue;
    }
    const kvMatch = normalizedLine.match(/^([^:：|]{2,20})\s*[:：]\s*(.*)$/);
    if (kvMatch) {
      currentKey = normalizeBriefKey(kvMatch[1]);
      appendBriefField(fields, currentKey, kvMatch[2].trim());
      continue;
    }
    const sectionKey = normalizeBriefKey(normalizedLine);
    if (isBriefSectionHeading(sectionKey)) {
      currentKey = sectionKey;
      if (!fields.has(currentKey)) fields.set(currentKey, "");
      continue;
    }
    if (line.startsWith("#")) {
      currentKey = "";
      continue;
    }
    if (currentKey) {
      appendBriefField(fields, currentKey, normalizedLine);
      continue;
    }
    bodyLines.push(normalizedLine);
  }
  const fallbackBody = bodyLines.join("；");
  const notesField = pickBriefField(fields, ["notes", "特殊要求", "备注", "要求"]);
  const outputLanguage = pickBriefField(fields, ["outputlanguage", "language", "输出语言", "语言"]);
  const notes = [
    notesField,
    outputLanguage ? `输出语言：${outputLanguage}` : ""
  ].filter(Boolean).join("；") || fallbackBody;
  return {
    productName: pickBriefField(fields, ["productname", "name", "产品名称", "商品名称", "品名"]),
    visibleProductName: pickBriefField(fields, ["visibleproductname", "displayname", "可见展示名", "展示名"]),
    targetAudience: pickBriefField(fields, ["targetaudience", "audience", "user", "人群", "目标人群", "适用人群", "用户人群"]),
    targetPlatform: pickBriefField(fields, ["targetplatform", "platform", "目标平台", "平台", "电商平台"]),
    outputLanguage,
    suiteRatio: pickBriefField(fields, ["suiteratio", "ratio", "套图比例", "画幅比例", "比例"]),
    category: pickBriefField(fields, ["category", "类目", "品类"]),
    sellingPoints: pickBriefField(fields, ["sellingpoints", "卖点", "核心卖点", "产品卖点"]),
    specs: pickBriefField(fields, ["specs", "规格", "规格参数", "参数"]),
    bannedElements: pickBriefField(fields, ["bannedelements", "禁用元素", "禁用", "不要"]),
    referenceKeywords: pickBriefField(fields, ["referencekeywords", "参考关键词", "关键词", "搜索词"]),
    notes,
    referenceImageUrls: normalizeUrls(pickBriefField(fields, ["referenceimageurls", "参考图", "参考图URL", "imageurls"])),
    referenceProductUrls: normalizeUrls(pickBriefField(fields, [
      "referenceproducturls",
      "referenceurls",
      "producturls",
      "参考商品链接",
      "竞品链接",
      "参考链接",
      "天猫链接",
      "淘宝链接",
      "商品链接"
    ])),
    generateDetail: pickBriefField(fields, ["generatedetail", "生成详情页", "详情页", "是否生成详情页"])
  };
}

function appendBriefField(fields: Map<string, string>, key: string, value: string): void {
  if (!key) return;
  const clean = value.trim();
  if (!clean) {
    if (!fields.has(key)) fields.set(key, "");
    return;
  }
  const previous = fields.get(key);
  fields.set(key, previous ? `${previous}；${clean}` : clean);
}

function emptyBrief() {
  return {
    productName: "",
    visibleProductName: "",
    targetAudience: "",
    targetPlatform: "",
    outputLanguage: "",
    suiteRatio: "",
    category: "",
    sellingPoints: "",
    specs: "",
    bannedElements: "",
    referenceKeywords: "",
    notes: "",
    referenceImageUrls: [] as string[],
    referenceProductUrls: [] as string[],
    generateDetail: "",
    briefPath: undefined as string | undefined
  };
}

function normalizeBriefKey(value: string): string {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

function isBriefSectionHeading(key: string): boolean {
  return new Set([
    "核心卖点",
    "卖点",
    "产品卖点",
    "画面要求",
    "主图规划",
    "详情页规划",
    "视觉风格参考",
    "本次硬要求",
    "可用文案方向",
    "禁用元素",
    "规格参数",
    "补充说明"
  ]).has(key);
}

function pickBriefField(fields: Map<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = fields.get(normalizeBriefKey(key));
    if (value) return value;
  }
  return "";
}

async function listImages(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && IMAGE_PATTERN.test(entry.name))
      .map((entry) => path.join(dirPath, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function validColor(value: unknown, fallback: string): string {
  const candidate = text(value);
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : fallback;
}

function splitList(value: string): string[] {
  return value.split(/[，,、;；\n]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeTextList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return splitList(text(value));
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function businessText(value: unknown): string {
  const clean = text(value);
  const normalized = clean.replace(/\s+/g, "");
  if (/^(无|暂无|没有|未提供|请你自行分析|自行分析|你自行分析|请自行分析|待补充|空|N\/?A|null|undefined)$/i.test(normalized)) {
    return "";
  }
  return clean;
}

function normalizeUrls(value: unknown): string[] {
  const items = Array.isArray(value) ? value.map(text) : [text(value)];
  return items
    .flatMap((item) => item.split(/\r?\n/))
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//i.test(item));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  const normalized = text(value).toLowerCase();
  if (!normalized) return fallback;
  if (["否", "不", "不要", "false", "0", "no", "n"].includes(normalized)) return false;
  if (["是", "要", "true", "1", "yes", "y"].includes(normalized)) return true;
  return fallback;
}
