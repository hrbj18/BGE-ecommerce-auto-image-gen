import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type {
  AppConfig,
  ImageGenerator,
  LocalProductImage,
  ProductTask,
  ReferenceAnalysis,
  ReferenceSearcher,
  TaskSource
} from "./types.ts";
import { ensureDir, inferMimeType, writeJson } from "./fs-utils.ts";
import { Logger } from "./logger.ts";
import { publishLocalImages, type PublishedImages } from "./temporary-image-publisher.ts";

export class LocalExcelWorker {
  private readonly logger: Logger;
  private readonly options: {
    config: AppConfig;
    taskSource: TaskSource;
    searcher: ReferenceSearcher;
    generator: ImageGenerator;
    logger?: Logger;
  };

  constructor(options: {
    config: AppConfig;
    taskSource: TaskSource;
    searcher: ReferenceSearcher;
    generator: ImageGenerator;
    logger?: Logger;
  }) {
    this.options = options;
    this.logger = options.logger ?? new Logger();
  }

  async runPending(): Promise<{ processed: number; completed: number; failed: number }> {
    const lockPath = path.join(this.options.config.paths.workspaceDir, ".automation.lock");
    return withRunLock(lockPath, this.logger, async () => {
      const tasks = await this.options.taskSource.listPendingTasks(Math.min(10, this.options.config.worker.concurrency * 10));
      if (!tasks.length) {
        this.logger.info("Excel 中没有待生成任务。");
        return { processed: 0, completed: 0, failed: 0 };
      }
      let completed = 0;
      let failed = 0;
      for (const task of tasks) {
        const ok = await this.processTask(task);
        if (ok) completed += 1;
        else failed += 1;
      }
      return { processed: tasks.length, completed, failed };
    });
  }

  private async processTask(task: ProductTask): Promise<boolean> {
    const outputDir = task.outputDir ?? path.join(this.options.config.paths.outputDir, task.sku);
    let publishedImages: PublishedImages | undefined;
    try {
      await this.options.taskSource.updateTask(task, {
        status: "处理中",
        outputDir,
        errorMessage: "",
        report: ""
      });
      await ensureDir(outputDir);
      await writeJson(path.join(outputDir, "task.json"), {
        ...task,
        localProductImages: task.localProductImages.map((item) => path.relative(this.options.config.paths.workspaceDir, item))
      });
      const brand = await this.options.taskSource.getBrand(task.brandId);
      const productImages = await toLocalProductImages(task.localProductImages);
      const referenceDir = path.join(outputDir, "references");
      const analysis = await this.getReferenceAnalysis(task, referenceDir);
      const localReferenceImages = referenceImagePaths(analysis);
      if (this.options.config.worker.forceRegenerate) {
        task.referenceImageUrls = task.referenceImageUrls.filter(isDurableReferenceImageUrl);
      }
      if (
        this.options.config.openai.imageProvider === "aiecho" &&
        !localImageTestMode() &&
        (this.options.config.worker.forceRegenerate ||
          (!task.referenceImageUrls.length &&
            !(await hasReusableNativeOutputs(task, outputDir, this.options.config.openai.aiEchoResolution))))
      ) {
        publishedImages = await publishLocalImages({
          imagePaths: [...task.localProductImages, ...localReferenceImages],
          workspaceDir: this.options.config.paths.workspaceDir,
          provider: this.options.config.openai.imageTunnelProvider
        });
        task.referenceImageUrls = [...task.referenceImageUrls, ...publishedImages.urls];
      }
      await writeJson(path.join(outputDir, "reference-analysis.json"), analysis);

      const result = await this.options.generator.generate(task, brand, productImages, analysis, outputDir);
      await this.options.taskSource.updateTask(task, {
        status: result.status ?? "已完成",
        outputDir,
        errorMessage: result.failures?.map((item) => `${item.role}-${item.index}: ${item.error}`).join("\n").slice(0, 1800) ?? "",
        report: result.report
      });
      this.logger.info(`任务完成：${task.sku}（${result.status ?? "已完成"}）`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`任务失败：${task.sku}`, error);
      await this.options.taskSource.updateTask(task, {
        status: "失败",
        outputDir,
        errorMessage: message.slice(0, 1800)
      }).catch((updateError) => this.logger.error(`Excel 回写失败：${task.sku}`, updateError));
      return false;
    } finally {
      await publishedImages?.close().catch(() => undefined);
    }
  }

  private async getReferenceAnalysis(task: ProductTask, referenceDir: string): Promise<ReferenceAnalysis> {
    let analysis: ReferenceAnalysis;
    if (this.options.config.worker.skipReferenceSearch) {
      analysis = fallbackAnalysis(task, "已关闭外部参考搜索，使用本地商品图与参考案例学习库。");
      return attachDesignLearning(analysis, this.options.config.paths.workspaceDir);
    }
    try {
      analysis = await this.options.searcher.search(task, referenceDir, this.options.config.worker.maxReferences);
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      this.logger.warn(`外部参考搜索不可用，继续使用本地商品图与参考案例学习库：${warning}`);
      analysis = fallbackAnalysis(task, warning);
    }
    return attachDesignLearning(analysis, this.options.config.paths.workspaceDir);
  }
}

function localImageTestMode(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LOCAL_IMAGE_TEST_MODE?.trim() ?? "");
}

async function hasReusableNativeOutputs(
  task: ProductTask,
  outputDir: string,
  resolution: AppConfig["openai"]["aiEchoResolution"]
): Promise<boolean> {
  const expectedMain = nativeResolutionPixels(resolution);
  const expectedDetail = nativeDetailHeight(resolution);
  for (let index = 1; index <= task.mainImageCount; index += 1) {
    const files = await matchingImageFiles(path.join(outputDir, "main"), index);
    if (!(await anyImageHasUsableSize(files, expectedMain, expectedMain))) return false;
  }
  if (!task.generateDetail) return true;
  for (let index = 1; index <= 8; index += 1) {
    const files = await matchingImageFiles(path.join(outputDir, "detail"), index);
    if (!(await anyImageHasUsableSize(files, expectedMain, expectedDetail, true))) return false;
  }
  return true;
}

async function matchingImageFiles(dirPath: string, index: number): Promise<string[]> {
  try {
    const prefix = `${String(index).padStart(2, "0")}-`;
    const files = await fs.readdir(dirPath);
    return files
      .filter((file) => file.startsWith(prefix) && /\.(png|jpe?g|webp)$/i.test(file))
      .map((file) => path.join(dirPath, file));
  } catch {
    return [];
  }
}

async function anyImageHasUsableSize(
  files: string[],
  expectedWidth: number,
  expectedHeight: number,
  allowSameRatio = false
): Promise<boolean> {
  for (const file of files) {
    try {
      const metadata = await sharp(file).metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      if (width === expectedWidth && height === expectedHeight) return true;
      const expectedRatio = expectedWidth / expectedHeight;
      const actualRatio = width && height ? width / height : 0;
      if (allowSameRatio && width >= 1000 && height >= 1000 && Math.abs(expectedRatio - actualRatio) < 0.012) {
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

function nativeResolutionPixels(resolution: "1k" | "2k" | "4k"): number {
  if (resolution === "1k") return 1024;
  if (resolution === "4k") return 4096;
  return 2048;
}

function nativeDetailHeight(resolution: "1k" | "2k" | "4k"): number {
  const raw = Math.ceil(nativeResolutionPixels(resolution) * 16 / 9);
  return raw % 2 === 0 ? raw : raw + 1;
}

async function toLocalProductImages(paths: string[]): Promise<LocalProductImage[]> {
  return Promise.all(paths.map(async (imagePath) => ({
    sourceName: path.basename(imagePath),
    path: imagePath,
    mimeType: await inferMimeType(imagePath)
  })));
}

export function fallbackAnalysis(task: ProductTask, warning: string): ReferenceAnalysis {
  return {
    query: [task.productName, task.category, task.referenceKeywords].filter(Boolean).join(" "),
    references: [],
    summary: `外部参考未使用：${warning}`,
    visualPatterns: ["商品主体清晰", "品牌留白稳定", "卖点必须转化成可看见的画面证据"],
    sellingPointPatterns: task.sellingPoints.split(/[，,、;；\n]/).map((item) => item.trim()).filter((item) => item && !isPlaceholderCopy(item)),
    detailPagePatterns: ["首屏", "利益点", "场景", "卖点", "细节", "参数", "品牌收尾"]
  };
}

export async function attachDesignLearning(analysis: ReferenceAnalysis, workspaceDir: string): Promise<ReferenceAnalysis> {
  const libraryPath = path.join(workspaceDir, "已完成", "参考案例分析", "zcool-case-library.json");
  try {
    const library = JSON.parse(await fs.readFile(libraryPath, "utf8")) as {
      successful?: number;
      failed?: number;
      ecommerceDesignRules?: string[];
      categories?: Record<string, number>;
      styles?: Record<string, number>;
    };
    const rules = (library.ecommerceDesignRules ?? []).map((item) => item.trim()).filter(Boolean);
    if (!rules.length) return analysis;
    const learnedSummary = `站酷高阶详情案例学习库：成功分析 ${library.successful ?? 0} 个案例，覆盖 ${Object.keys(library.categories ?? {}).join("、") || "多类目"}；抽象学习结构，不复用原图素材。`;
    return {
      ...analysis,
      summary: [analysis.summary, learnedSummary].filter(Boolean).join("\n"),
      visualPatterns: appendUnique(analysis.visualPatterns, [
        "学习库结论：首图必须先让商品足够大，移动端 3 秒内看清商品、目标人群和第一卖点。",
        "学习库结论：每张主图只承担一个转化任务，不能把点击、功能、场景、细节、参数混在一张图里。",
        "学习库结论：功能型产品要用近景、操作动作或真实使用场景证明卖点，不能只做氛围海报。"
      ]),
      detailPagePatterns: appendUnique(analysis.detailPagePatterns, [
        ...rules,
        "详情页屏序采用：品牌首屏/核心主张 -> 用户痛点 -> 功能证据 -> 场景代入 -> 细节信任 -> 规格选择 -> 品牌收尾。",
        "文字排版学习成熟详情页的短句大层级、留白、局部放大和信息块节奏，但文案必须原创。"
      ]),
      brandVisualLogic: appendUnique(analysis.brandVisualLogic ?? [], buildBrandVisualLogic(library)),
      designReviewRules: appendUnique(analysis.designReviewRules ?? [], buildDesignReviewRules(library))
    };
  } catch {
    return analysis;
  }
}

function buildBrandVisualLogic(library: {
  successful?: number;
  categories?: Record<string, number>;
  styles?: Record<string, number>;
}): string[] {
  const styleNames = Object.keys(library.styles ?? {});
  return [
    `参考案例库基于 ${library.successful ?? 0} 个高阶电商案例抽象，只迁移视觉逻辑，不复制素材和文案。`,
    "全案必须先定义一套稳定的品牌色彩、光线、字体层级和图形语言，主图与详情页沿用同一系统。",
    "首图是货架点击入口，商品体量、品类识别、核心卖点优先级高于氛围和装饰。",
    "详情页是销售动线，不是图片堆叠：首屏立价值，第二屏回答顾虑，中段用功能/材质/场景证明，末段降低选择成本。",
    "每一屏只证明一个购买理由，画面证据先于文案，文案只做短句解释。",
    "版式使用移动端大层级、强留白、局部放大、细线标注和稳定信息区，避免卡片堆叠、促销贴纸和杂色跳变。",
    styleNames.length ? `案例库主要风格信号：${styleNames.slice(0, 8).join("、")}。` : ""
  ].filter(Boolean);
}

function buildDesignReviewRules(library: {
  ecommerceDesignRules?: string[];
}): string[] {
  return appendUnique([
    "审核首图：商品是否为第一视觉主体，是否 3 秒内看清品类、目标人群和第一卖点。",
    "审核套图：主图和详情页是否共享同一色彩、光线、字体层级和图形语言，不能每屏换风格。",
    "审核转化：每张图是否只承担一个明确购买理由，卖点是否被画面证明。",
    "审核详情页：屏序是否符合首屏价值 -> 顾虑 -> 证据 -> 场景 -> 细节 -> 选择建议 -> 收尾。",
    "审核文字：中文是否短、准、可读，是否没有乱码、随机英文、错别字和无关标识。",
    "审核合规：是否未复制参考案例素材/文案/商标，且未虚构未提供的认证、数据、材质或功效。"
  ], library.ecommerceDesignRules ?? []);
}

function appendUnique(base: string[], extra: string[]): string[] {
  const result = [...base];
  for (const item of extra) {
    const clean = item.trim();
    if (clean && !result.includes(clean)) result.push(clean);
  }
  return result;
}

function isPlaceholderCopy(value: string): boolean {
  const normalized = value.replace(/\s+/g, "");
  return /无|暂无|没有|未提供|请你自行分析|自行分析|你自行分析|请自行分析|待补充|N\/?A|null|undefined/i.test(normalized);
}

function referenceImagePaths(analysis: ReferenceAnalysis): string[] {
  const paths = new Set<string>();
  for (const reference of analysis.references) {
    if (reference.mainImagePath) paths.add(reference.mainImagePath);
    if (reference.detailScreenshotPath) paths.add(reference.detailScreenshotPath);
  }
  return [...paths];
}

function isDurableReferenceImageUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !/(^|\.)litter\.catbox\.moe$/.test(host);
  } catch {
    return false;
  }
}

async function withRunLock<T>(lockPath: string, logger: Logger, action: () => Promise<T>): Promise<T> {
  let handle: fs.FileHandle | undefined;
  const startedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: startedAt }));
      break;
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: string }).code : "";
      if (code !== "EEXIST") throw error;

      const inspection = await inspectRunLock(lockPath);
      if (inspection.missing) continue;
      if (inspection.stale) {
        await fs.unlink(lockPath).catch(() => undefined);
        logger.warn(`检测到陈旧自动化锁，已自动清理：${inspection.reason}`);
        continue;
      }
      throw new Error(buildActiveLockMessage(lockPath, inspection));
    }
  }
  if (!handle) throw new Error(`自动化锁创建失败，请稍后重试：${lockPath}`);
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.utimes(lockPath, now, now).catch(() => undefined);
  }, runLockHeartbeatMs());
  heartbeat.unref();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    await handle?.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

type RunLockInspection = {
  missing?: boolean;
  stale: boolean;
  reason: string;
  pid?: number;
  startedAt?: string;
  heartbeatAt?: string;
  ageMs?: number;
  heartbeatAgeMs?: number;
};

async function inspectRunLock(lockPath: string): Promise<RunLockInspection> {
  let raw = "";
  let lockMtime = "";
  try {
    raw = await fs.readFile(lockPath, "utf8");
    lockMtime = (await fs.stat(lockPath)).mtime.toISOString();
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: string }).code : "";
    if (code === "ENOENT") return { missing: true, stale: true, reason: "锁文件已不存在" };
    return { stale: true, reason: `锁文件无法读取：${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: { pid?: unknown; startedAt?: unknown; heartbeatAt?: unknown } = {};
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { stale: true, reason: "锁文件内容不是合法 JSON" };
  }

  const pid = typeof parsed.pid === "number" ? parsed.pid : Number(parsed.pid);
  const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : "";
  const storedHeartbeatAt = typeof parsed.heartbeatAt === "string" ? parsed.heartbeatAt : "";
  const heartbeatAt = [storedHeartbeatAt, lockMtime]
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || "";
  const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
  const heartbeatAtMs = heartbeatAt ? Date.parse(heartbeatAt) : NaN;
  const ageMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : undefined;
  const heartbeatAgeMs = Number.isFinite(heartbeatAtMs) ? Date.now() - heartbeatAtMs : undefined;
  const maxAgeMs = runLockStaleMs();

  if (heartbeatAt && heartbeatAgeMs !== undefined && heartbeatAgeMs > runLockHeartbeatStaleMs()) {
    return { stale: true, reason: `锁心跳已停止 ${formatDuration(heartbeatAgeMs)}`, pid, startedAt, heartbeatAt, ageMs, heartbeatAgeMs };
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    return { stale: true, reason: "锁文件缺少有效进程号", startedAt, heartbeatAt, ageMs, heartbeatAgeMs };
  }
  if (ageMs !== undefined && ageMs > maxAgeMs) {
    return {
      stale: true,
      reason: `锁文件已超过 ${formatDuration(maxAgeMs)}，上次任务可能异常中断`,
      pid,
      startedAt,
      heartbeatAt,
      ageMs,
      heartbeatAgeMs
    };
  }
  if (!isProcessAlive(pid)) {
    return { stale: true, reason: `锁中进程 ${pid} 已不存在`, pid, startedAt, heartbeatAt, ageMs, heartbeatAgeMs };
  }

  return { stale: false, reason: heartbeatAt ? "锁心跳正常" : "锁中进程仍在运行", pid, startedAt, heartbeatAt, ageMs, heartbeatAgeMs };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: string }).code : "";
    return code === "EPERM";
  }
}

function runLockStaleMs(): number {
  const raw = Number(process.env.AUTOMATION_LOCK_STALE_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 12 * 60 * 60 * 1000;
}

function runLockHeartbeatMs(): number {
  const raw = Number(process.env.AUTOMATION_LOCK_HEARTBEAT_MS ?? "");
  return Number.isFinite(raw) && raw >= 1000 ? raw : 15_000;
}

function runLockHeartbeatStaleMs(): number {
  const raw = Number(process.env.AUTOMATION_LOCK_HEARTBEAT_STALE_MS ?? "");
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 90_000;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return `${hours} 小时`;
}

function buildActiveLockMessage(lockPath: string, inspection: RunLockInspection): string {
  const parts = [
    "已有自动化任务正在运行，请等待当前任务完成后再提交。",
    inspection.pid ? `运行进程：${inspection.pid}` : "",
    inspection.startedAt ? `启动时间：${inspection.startedAt}` : "",
    `锁文件：${lockPath}`
  ].filter(Boolean);
  return parts.join(" ");
}
