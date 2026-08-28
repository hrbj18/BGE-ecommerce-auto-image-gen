export type TaskStatus = "待生成" | "处理中" | "已完成" | "部分失败" | "失败";

export interface AppConfig {
  feishu: {
    appId: string;
    appSecret: string;
    baseAppToken: string;
    tableId: string;
    chatId: string;
  };
  openai: {
    apiKey: string;
    baseUrl: string;
    imageModel: string;
    textModel: string;
    imageProvider: "openai" | "aiecho";
    imageCompositionMode: "template" | "native";
    aiEchoBaseUrl: string;
    aiEchoActivationCode: string;
    aiEchoResolution: "1k" | "2k" | "4k";
    imageTunnelProvider: "cloudflared" | "bore" | "litterbox";
  };
  worker: {
    pollIntervalMinutes: number;
    maxReferences: number;
    concurrency: number;
    taskWorkbookPath: string;
    skipReferenceSearch: boolean;
    forceRegenerate: boolean;
    dropInputDir: string;
    dropOutputDir: string;
  };
  paths: {
    workspaceDir: string;
    dataDir: string;
    outputDir: string;
  };
}

export interface FeishuAttachment {
  fileToken?: string;
  name?: string;
  size?: number;
  type?: string;
  url?: string;
  tmpUrl?: string;
  [key: string]: unknown;
}

export interface RawFeishuRecord {
  recordId: string;
  fields: Record<string, unknown>;
  recordUrl?: string;
}

export interface ProductTask {
  recordId: string;
  recordUrl?: string;
  taskId?: string;
  submittedAt?: string;
  submittedAtLocal?: string;
  inputFolderName?: string;
  outputFolderName?: string;
  sku: string;
  brandId: string;
  productName: string;
  originalProductName?: string;
  visibleProductName?: string;
  targetAudience: string;
  targetPlatform: string;
  outputLanguage?: string;
  category: string;
  productImages: FeishuAttachment[];
  localProductImages: string[];
  referenceImageUrls: string[];
  referenceProductUrls: string[];
  materialDir: string;
  mainProductImage: string;
  outputDir?: string;
  sellingPoints: string;
  specs: string;
  bannedElements: string;
  referenceKeywords: string;
  notes: string;
  briefPath?: string;
  suiteRatio?: string;
  briefFocus?: string;
  commonRuleProfile?: string;
  commonRuleName?: string;
  commonRuleFile?: string;
  commonRuleVersion?: string;
  commonRuleReason?: string;
  commonRuleText?: string;
  commonRuleMatchedKeywords?: string[];
  platformRuleProfile?: string;
  platformRuleName?: string;
  platformRuleFile?: string;
  platformRuleVersion?: string;
  platformRuleReason?: string;
  platformRuleText?: string;
  platformRuleMatchedKeywords?: string[];
  languageRuleProfile?: string;
  languageRuleName?: string;
  languageRuleFile?: string;
  languageRuleVersion?: string;
  languageRuleReason?: string;
  languageRuleText?: string;
  languageRuleMatchedKeywords?: string[];
  generationRuleProfile?: string;
  generationRuleName?: string;
  generationRuleFile?: string;
  generationRuleVersion?: string;
  generationRuleReason?: string;
  generationRuleText?: string;
  generationRuleMatchedKeywords?: string[];
  mainImageCount: number;
  generateDetail: boolean;
  imageRatio: string;
}

export interface BrandProfile {
  id: string;
  name: string;
  logoPath: string;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  titleFont: string;
  bodyFont: string;
  positioning: string;
  visualKeywords: string[];
  slogan: string;
  referenceImagePaths: string[];
  bannedElements: string;
}

export interface LocalProductImage {
  sourceName: string;
  path: string;
  mimeType: string;
}

export interface ReferenceItem {
  title: string;
  url: string;
  price?: string;
  mainImagePath?: string;
  detailScreenshotPath?: string;
  notes?: string;
}

export interface ReferenceAnalysis {
  query: string;
  references: ReferenceItem[];
  summary: string;
  visualPatterns: string[];
  sellingPointPatterns: string[];
  detailPagePatterns: string[];
  brandVisualLogic?: string[];
  designReviewRules?: string[];
}

export interface ProductVisualInsight {
  source: "openai-vision" | "prompt-layer";
  summary: string;
  productFacts: string[];
  visualSellingPoints: string[];
  promptDirectives: string[];
  warnings: string[];
}

export interface GeneratedAsset {
  role: "main" | "detail";
  index: number;
  title: string;
  prompt: string;
  path: string;
  width: number;
  height: number;
  bytes: number;
  attempts?: number;
  quality?: QualityCheckResult;
  designReview?: DesignReviewItem;
}

export interface ProductOutput {
  sku: string;
  outputDir: string;
  mainImages: GeneratedAsset[];
  detailImages: GeneratedAsset[];
  detailImage?: GeneratedAsset;
  longDetailPath?: string;
  analysisPath: string;
  promptsPath?: string;
  designReviewPath?: string;
  reportPath?: string;
  packagePath: string;
  report: string;
  status?: "已完成" | "部分失败";
  failures?: AssetFailure[];
}

export interface AssetFailure {
  role: "main" | "detail";
  index: number;
  title: string;
  error: string;
  attempts: number;
}

export interface QualityCheckResult {
  passed: boolean;
  checks: {
    fileSize: boolean;
    dimensions: boolean;
    aspectRatio: boolean;
    brandApplied: boolean;
    safeArea: boolean;
  };
  warnings: string[];
}

export interface GenerationManifest {
  sku: string;
  brandId: string;
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  mainImages: GeneratedAsset[];
  detailImages: GeneratedAsset[];
  longDetailPath?: string;
  failures: AssetFailure[];
  designReviewPath?: string;
  designReview?: DesignReviewReport;
  referenceWarning?: string;
  productVisualInsight?: ProductVisualInsight;
  sellingPointCoverage?: SellingPointCoverage[];
  generationRule?: {
    profile?: string;
    name?: string;
    file?: string;
    version?: string;
    reason?: string;
    matchedKeywords?: string[];
  };
  platformRule?: {
    profile?: string;
    name?: string;
    file?: string;
    version?: string;
    reason?: string;
    matchedKeywords?: string[];
  };
  languageRule?: {
    profile?: string;
    name?: string;
    file?: string;
    version?: string;
    reason?: string;
    matchedKeywords?: string[];
  };
}

export type SellingPointCoverageStatus = "covered" | "weak" | "uncovered" | "needs_confirmation";

export interface SellingPointCoverage {
  point: string;
  source: "explicit" | "derived";
  status: SellingPointCoverageStatus;
  frameKeys: string[];
  risk?: string;
  evidence: string;
}

export interface DesignReviewCheck {
  id: string;
  label: string;
  passed: boolean;
  evidence: string;
}

export interface DesignReviewItem {
  role: "main" | "detail";
  index: number;
  title: string;
  path: string;
  status: "通过" | "需人工复核" | "失败";
  checks: DesignReviewCheck[];
  notes: string[];
}

export interface DesignReviewReport {
  sku: string;
  brandName: string;
  generatedAt: string;
  source: "reference-case-learning";
  referenceSummary: string;
  brandVisualLogic: string[];
  designReviewRules: string[];
  sellingPointCoverage?: SellingPointCoverage[];
  summary: {
    total: number;
    passed: number;
    needsReview: number;
    failed: number;
  };
  items: DesignReviewItem[];
}

export interface FeishuUploadedFile {
  fileToken: string;
  name: string;
  url?: string;
}

export interface FeishuClient {
  listPendingTasks(limit: number): Promise<RawFeishuRecord[]>;
  findTaskBySku(sku: string): Promise<RawFeishuRecord | null>;
  updateRecord(recordId: string, fields: Record<string, unknown>): Promise<void>;
  downloadAttachment(
    attachment: FeishuAttachment,
    destinationPath: string,
    context: { recordId: string; fieldName: string }
  ): Promise<void>;
  uploadBitableFile(filePath: string): Promise<FeishuUploadedFile>;
  uploadMessageImage(filePath: string): Promise<string>;
  sendImageMessage(chatId: string, imageKey: string): Promise<void>;
  sendTextMessage(chatId: string, text: string): Promise<void>;
}

export interface ReferenceSearcher {
  ensureLogin(): Promise<void>;
  search(task: ProductTask, destinationDir: string, maxReferences: number): Promise<ReferenceAnalysis>;
}

export interface ImageGenerator {
  generate(
    task: ProductTask,
    brand: BrandProfile,
    productImages: LocalProductImage[],
    analysis: ReferenceAnalysis,
    outputDir: string
  ): Promise<ProductOutput>;
}

export interface TaskSource {
  listPendingTasks(limit: number): Promise<ProductTask[]>;
  updateTask(task: ProductTask, fields: {
    status?: TaskStatus;
    outputDir?: string;
    errorMessage?: string;
    report?: string;
  }): Promise<void>;
  getBrand(brandId: string): Promise<BrandProfile>;
}
