import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig, BrandProfile } from "./types.ts";
import type { FeishuClient, FeishuUploadedFile, ImageGenerator, LocalProductImage, ProductOutput, RawFeishuRecord, ReferenceSearcher } from "./types.ts";
import { destinationPathForAttachment } from "./feishu-client.ts";
import { FIELDS, feishuAttachmentField, parseTask } from "./field-map.ts";
import { ensureDir, inferMimeType, safeSegment, writeJson } from "./fs-utils.ts";
import { Logger } from "./logger.ts";
import { attachDesignLearning, fallbackAnalysis } from "./local-worker.ts";

export class EcommerceImageWorker {
  private readonly config: AppConfig;
  private readonly feishu: FeishuClient;
  private readonly searcher: ReferenceSearcher;
  private readonly generator: ImageGenerator;
  private readonly logger: Logger;
  private readonly localLocks = new Set<string>();

  constructor(options: {
    config: AppConfig;
    feishu: FeishuClient;
    searcher: ReferenceSearcher;
    generator: ImageGenerator;
    logger?: Logger;
  }) {
    this.config = options.config;
    this.feishu = options.feishu;
    this.searcher = options.searcher;
    this.generator = options.generator;
    this.logger = options.logger ?? new Logger();
  }

  async runForever(): Promise<void> {
    this.logger.info(`Worker started. Polling every ${this.config.worker.pollIntervalMinutes} minute(s).`);
    for (;;) {
      await this.runOnePoll();
      await sleep(this.config.worker.pollIntervalMinutes * 60 * 1000);
    }
  }

  async runOnePoll(): Promise<void> {
    const rawTasks = await this.feishu.listPendingTasks(this.config.worker.concurrency);
    if (!rawTasks.length) {
      this.logger.info("No pending tasks.");
      return;
    }

    for (const record of rawTasks) {
      await this.processRecord(record);
    }
  }

  async runSku(sku: string): Promise<void> {
    const record = await this.feishu.findTaskBySku(sku);
    if (!record) {
      throw new Error(`SKU not found in Feishu Bitable: ${sku}`);
    }
    await this.processRecord(record);
  }

  async processRecord(record: RawFeishuRecord): Promise<void> {
    const lockKey = record.recordId;
    if (this.localLocks.has(lockKey)) {
      this.logger.warn(`Record is already processing locally: ${record.recordId}`);
      return;
    }
    this.localLocks.add(lockKey);

    let taskSku = record.recordId;
    try {
      const task = parseTask(record);
      taskSku = task.sku;
      this.logger.info(`Claiming task ${task.sku}`);
      await this.feishu.updateRecord(record.recordId, {
        [FIELDS.status]: "处理中",
        [FIELDS.errorMessage]: ""
      });

      const productDir = this.productDataDir(task.sku);
      const referenceDir = path.join(this.productOutputDir(task.sku), "references");
      const outputDir = this.productOutputDir(task.sku);
      await ensureDir(productDir);
      await ensureDir(referenceDir);
      await ensureDir(outputDir);

      const productImages = await this.downloadProductImages(record.recordId, task.productImages, productDir);
      await writeJson(path.join(outputDir, "task.json"), task);

      this.logger.info(`Building local reference strategy for ${task.sku}`);
      const analysis = await this.getReferenceAnalysis(task, referenceDir);
      await writeJson(path.join(outputDir, "reference-analysis.json"), analysis);

      this.logger.info(`Generating ecommerce images for ${task.sku}`);
      const legacyBrand: BrandProfile = {
        id: "default",
        name: "默认品牌",
        logoPath: productImages[0].path,
        primaryColor: "#14213d",
        secondaryColor: "#fca311",
        backgroundColor: "#f7f4ef",
        titleFont: "PingFang SC",
        bodyFont: "PingFang SC",
        positioning: task.category,
        visualKeywords: ["干净", "高级电商质感"],
        slogan: "",
        referenceImagePaths: [],
        bannedElements: task.bannedElements
      };
      const result = await this.generator.generate(task, legacyBrand, productImages, analysis, outputDir);

      this.logger.info(`Uploading outputs to Feishu for ${task.sku}`);
      await this.completeTask(record, result, analysis.summary);
      this.logger.info(`Task completed: ${task.sku}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Task failed: ${taskSku}`, error);
      await this.markFailed(record.recordId, message).catch((updateError) => {
        this.logger.error(`Failed to write error status for ${taskSku}`, updateError);
      });
    } finally {
      this.localLocks.delete(lockKey);
    }
  }

  private async downloadProductImages(
    recordId: string,
    attachments: ProductTaskLikeAttachment[],
    destinationDir: string
  ): Promise<LocalProductImage[]> {
    const images: LocalProductImage[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const destinationPath = destinationPathForAttachment(destinationDir, index, attachment);
      await this.feishu.downloadAttachment(attachment, destinationPath, {
        recordId,
        fieldName: FIELDS.productImages
      });
      images.push({
        sourceName: attachment.name ?? path.basename(destinationPath),
        path: destinationPath,
        mimeType: await inferMimeType(destinationPath)
      });
    }
    return images;
  }

  private async completeTask(record: RawFeishuRecord, result: ProductOutput, referenceSummary: string): Promise<void> {
    const mainUploads: FeishuUploadedFile[] = [];
    for (const asset of result.mainImages) {
      mainUploads.push(await this.feishu.uploadBitableFile(asset.path));
    }
    const firstDetail = result.detailImages[0] ?? result.detailImage;
    if (!firstDetail) {
      throw new Error("No detail image was generated.");
    }
    const detailUpload = await this.feishu.uploadBitableFile(firstDetail.path);
    await this.feishu.uploadBitableFile(result.packagePath);

    await this.feishu.updateRecord(record.recordId, {
      [FIELDS.status]: result.status ?? "已完成",
      [FIELDS.outputMainImages]: feishuAttachmentField(mainUploads),
      [FIELDS.outputDetailImage]: feishuAttachmentField([detailUpload]),
      [FIELDS.localArchivePath]: result.outputDir,
      [FIELDS.referenceSummary]: referenceSummary,
      [FIELDS.generationReport]: result.report,
      [FIELDS.errorMessage]: ""
    });

    const previewImageKey = await this.feishu.uploadMessageImage(result.mainImages[0].path);
    await this.feishu.sendImageMessage(this.config.feishu.chatId, previewImageKey);
    await this.feishu.sendTextMessage(
      this.config.feishu.chatId,
      [
        `电商图生成完成：${result.sku}`,
        `主图：${result.mainImages.length} 张`,
        `详情页：1 张`,
        `本地归档：${result.outputDir}`,
        record.recordUrl ? `飞书记录：${record.recordUrl}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  private async markFailed(recordId: string, message: string): Promise<void> {
    await this.feishu.updateRecord(recordId, {
      [FIELDS.status]: "失败",
      [FIELDS.errorMessage]: message.slice(0, 1800)
    });
  }

  private productDataDir(sku: string): string {
    return path.join(this.config.paths.dataDir, safeSegment(sku), "input");
  }

  private productOutputDir(sku: string): string {
    return path.join(this.config.paths.outputDir, safeSegment(sku));
  }

  private async getReferenceAnalysis(task: ReturnType<typeof parseTask>, referenceDir: string) {
    if (this.config.worker.skipReferenceSearch) {
      return attachDesignLearning(
        fallbackAnalysis(task, "已关闭外部参考搜索，使用本地商品图与参考案例学习库。"),
        this.config.paths.workspaceDir
      );
    }
    try {
      return attachDesignLearning(
        await this.searcher.search(task, referenceDir, this.config.worker.maxReferences),
        this.config.paths.workspaceDir
      );
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      this.logger.warn(`外部参考搜索不可用，继续使用本地商品图与参考案例学习库：${warning}`);
      return attachDesignLearning(fallbackAnalysis(task, warning), this.config.paths.workspaceDir);
    }
  }
}

type ProductTaskLikeAttachment = Parameters<FeishuClient["downloadAttachment"]>[0];

export async function removeEmptyDirIfPossible(dirPath: string): Promise<void> {
  try {
    const items = await fs.readdir(dirPath);
    if (!items.length) {
      await fs.rmdir(dirPath);
    }
  } catch {
    // Best effort cleanup only.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
