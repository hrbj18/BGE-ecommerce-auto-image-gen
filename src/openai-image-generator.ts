import fs from "node:fs/promises";
import { openAsBlob } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type {
  AppConfig,
  AssetFailure,
  BrandProfile,
  DesignReviewItem,
  DesignReviewReport,
  GeneratedAsset,
  GenerationManifest,
  ImageGenerator,
  LocalProductImage,
  ProductVisualInsight,
  ProductOutput,
  ProductTask,
  ReferenceAnalysis,
  SellingPointCoverage
} from "./types.ts";
import { renderBrandedMain, renderDetailModule } from "./brand-renderer.ts";
import { ensureDir, safeSegment, sha256File, writeJson, zipFiles } from "./fs-utils.ts";
import { normalizeSquareImage } from "./image-utils.ts";
import { checkGeneratedImage } from "./quality-checker.ts";
import { auditNativePromptSet, auditTaskIdentity, classifyProductIdentity, formatPromptAuditFailure } from "./prompt-audit.ts";
import {
  isActionableGeneratedVisualAuditFailure,
  normalizeGeneratedVisualAudit,
  skippedGeneratedVisualAudit,
  type GeneratedVisualAuditExpected,
  type GeneratedVisualAuditReport
} from "./output-audit.ts";
import {
  buildReferenceCaseLayoutRule,
  buildStoryboardPlan,
  storyboardFramePrompt,
  type StoryboardPlan
} from "./storyboard-planner.ts";
import {
  buildCreativeDirectorRequestPrompt,
  buildDeterministicCreativePlan,
  compileDirectedFramePrompt,
  frameAuditSummary,
  normalizeCreativeDirectorResult,
  sanitizeReferenceAnalysisForProduct,
  sanitizeProductVisualInsight,
  type CreativePlan,
  type DirectedStoryboardFrame
} from "./creative-director.ts";

type ImageQualityResult = Awaited<ReturnType<typeof checkGeneratedImage>>;

interface ImageSpec {
  index: number;
  title: string;
  subtitle: string;
  prompt: string;
}

export interface NativeImageSpec {
  role: "main" | "detail";
  index: number;
  title: string;
  aspectRatio: "1:1" | "3:4" | "9:16";
  copy: string[];
  prompt: string;
  auditSummary?: string;
  creativeFrame?: DirectedStoryboardFrame;
}

interface NativeImageJob {
  spec: NativeImageSpec;
  outputPath: string;
}

interface AiEchoSubmission {
  taskId: string;
  submittedAt: string;
}

interface AiEchoGenerationResult {
  taskId: string;
  submittedAt: string;
  attempts: number;
}

interface NativeGeneratedAssetResult extends AiEchoGenerationResult {
  width: number;
  height: number;
  quality: ImageQualityResult;
}

interface NativePromptRecord {
  role: "main" | "detail";
  index: number;
  title: string;
  aspectRatio: "1:1" | "3:4" | "9:16";
  copy: string[];
  prompt: string;
  auditSummary?: string;
  creativeFrame?: DirectedStoryboardFrame;
  path: string;
  status: "planned" | "reused" | "completed" | "failed";
  taskId?: string;
  submittedAt?: string;
  attempts?: number;
  reused?: boolean;
  error?: string;
}

interface VisualSystem {
  platform: string;
  generationRule: string;
  productImageAuthority: string;
  productVisualInsight: string;
  palette: string;
  scene: string;
  model: string;
  consistency: string;
  sceneSellingPointLock: string;
  ecommerceLogic: string;
  referenceLearning: string;
  brandVisualLogic: string;
  designReviewStandard: string;
  typography: string;
  productLock: string;
  forbidden: string;
}

interface ProductContext {
  text: string;
  isChildProduct: boolean;
  isAiRobot: boolean;
  isFootwear: boolean;
  isYellowProduct: boolean;
  isCup: boolean;
  isTemperatureDisplay: boolean;
  isIntimateApparel: boolean;
  isKitchenTextile: boolean;
  isSkincare: boolean;
  isPortableFan: boolean;
  isPillow: boolean;
  isLaundryDetergent: boolean;
  isSneaker: boolean;
  isPants: boolean;
  isApparel: boolean;
  isBabyCare: boolean;
  isCuttingBoard: boolean;
  isMagneticLifter: boolean;
  isStudentBackpack: boolean;
  isTissue: boolean;
  isUmbrella: boolean;
  isBikeBasket: boolean;
  isAmazonPlatform: boolean;
  isAdultAudience: boolean;
  isEnglishMarketplace: boolean;
  canShowFace: boolean;
}

interface ScreenPrompt {
  role: string;
  conversionGoal: string;
  sceneDirection: string;
  composition: string;
  typography: string;
  copy: string[];
}

interface GenericCopyPlan {
  primaryPoint: string;
  secondaryPoint: string;
  tertiaryPoint: string;
  detailFocus: string;
  main: string[][];
  detail: string[][];
}

interface ProofScreenScript {
  sellingPoint: string;
  productForm: string;
  proofMethod: string;
  interaction: string;
  avoidRepeat: string;
}

interface ProductProofMatrix {
  archetype: string;
  globalRule: string;
  main: ProofScreenScript[];
  detail: ProofScreenScript[];
}

const TEMPLATE_VISIBLE_COPY_TERMS = [
  "三处日常友好设计",
  "一眼记住的商品细节",
  "日常使用建议",
  "轮廓清晰",
  "细节清晰可见",
  "体验更直接",
  "减少选择成本",
  "把好用",
  "带进每一天",
  "自然融入日常",
  "真实场景",
  "真实日常",
  "真实使用",
  "真实使用更有代入感",
  "真实使用更好理解",
  "带进真实日常",
  "自然融入你的日常",
  "使用场景",
  "场景代入",
  "核心主张",
  "用户顾虑",
  "转化目标",
  "案例学习",
  "页面模块",
  "画面里直接看懂",
  "先把核心卖点说清楚",
  "选择更简单",
  "一眼看懂",
  "Clear product appearance with practical everyday value",
  "Feature-focused scenes that make benefits easy to understand",
  "Clear Everyday Value",
  "Details You Can See",
  "Made For Daily Use",
  "Easy To Choose",
  "Visible Feature Proof",
  "Visible Detail Proof",
  "Simple Daily Value",
  "Everyday Essential",
  "Product-specific feature proof",
  "Buyer confidence"
];

const TEMPLATE_PROMPT_FORBIDDEN_COPY_TERMS = TEMPLATE_VISIBLE_COPY_TERMS.filter(
  (term) => !["画面里直接看懂", "先把核心卖点说清楚"].includes(term)
);

export class OpenAiImageGenerator implements ImageGenerator {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async generate(
    task: ProductTask,
    brand: BrandProfile,
    productImages: LocalProductImage[],
    analysis: ReferenceAnalysis,
    outputDir: string
  ): Promise<ProductOutput> {
    if (this.config.openai.imageCompositionMode === "native") {
      return this.generateNative(task, brand, productImages, analysis, outputDir);
    }

    const startedAt = new Date();
    const mainDir = path.join(outputDir, "main");
    const detailDir = path.join(outputDir, "detail");
    const rawDir = path.join(outputDir, "raw");
    await Promise.all([ensureDir(mainDir), ensureDir(detailDir), ensureDir(rawDir)]);

    const normalizedProductPath = path.join(rawDir, "product-reference.jpg");
    await normalizeSquareImage(productImages[0].path, normalizedProductPath, 1024);
    const referenceInputPaths = [normalizedProductPath, ...brand.referenceImagePaths.slice(0, 2), ...referenceImagePathsFromAnalysis(analysis).slice(0, 2)];
    const legacyStoryboard = buildStoryboardPlan(storyboardInput(task, inferSellingPoints(task, analysis)));
    const imageSpecs = buildImageSpecs(task, brand, analysis)
      .slice(0, task.mainImageCount)
      .map((spec) => {
        const frame = legacyStoryboard.frames.find((candidate) => candidate.role === "main" && candidate.index === spec.index);
        return frame ? { ...spec, prompt: `${spec.prompt}\n${storyboardFramePrompt(frame)}` } : spec;
      });
    const mainImages: GeneratedAsset[] = [];
    const failures: AssetFailure[] = [];

    for (const spec of imageSpecs) {
      const rawPath = path.join(rawDir, `main-${pad(spec.index)}.png`);
      const finalPath = path.join(mainDir, `${pad(spec.index)}.jpg`);
      try {
        const attempts = await retry(3, async () => {
          await this.generateImage({
            prompt: spec.prompt,
            referenceImagePaths: referenceInputPaths,
            referenceImageUrls: task.referenceImageUrls,
            outputPath: rawPath,
            aspectRatio: "1:1"
          });
          await renderBrandedMain({
            backgroundPath: rawPath,
            outputPath: finalPath,
            brand,
            title: spec.title,
            subtitle: spec.subtitle,
            index: spec.index
          });
          const quality = await checkGeneratedImage({
            filePath: finalPath,
            expectedWidth: 800,
            expectedHeight: 800,
            brandApplied: true,
            safeArea: true
          });
          if (!quality.passed) throw new Error(quality.warnings.join("；"));
        });
        const quality = await checkGeneratedImage({
          filePath: finalPath,
          expectedWidth: 800,
          expectedHeight: 800,
          brandApplied: true,
          safeArea: true
        });
        const stat = await fs.stat(finalPath);
        mainImages.push({
          role: "main",
          index: spec.index,
          title: spec.title,
          prompt: spec.prompt,
          path: finalPath,
          width: 800,
          height: 800,
          bytes: stat.size,
          attempts,
          quality
        });
      } catch (error) {
        failures.push(failure("main", spec.index, spec.title, error, 3));
      }
    }

    if (!mainImages.length) {
      throw new Error(`所有主图均生成失败：${failures.map((item) => item.error).join("；")}`);
    }
    const detailImages = task.generateDetail
      ? await this.generateDetailModules(task, brand, normalizedProductPath, detailDir, mainImages, failures)
      : [];

    const promptsPath = path.join(outputDir, "prompts.json");
    await writeJson(promptsPath, imageSpecs);
    const completedAt = new Date();
    const manifest: GenerationManifest = {
      sku: task.sku,
      brandId: brand.id,
      model: this.config.openai.imageModel,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      generationRule: generationRuleManifest(task),
      platformRule: platformRuleManifest(task),
      languageRule: languageRuleManifest(task),
      mainImages,
      detailImages,
      sellingPointCoverage: legacyStoryboard.coverage,
      failures
    };
    const analysisPath = path.join(outputDir, "analysis.json");
    await writeJson(analysisPath, {
      task: safeTaskForReport(task),
      brand: { ...brand, logoPath: path.relative(this.config.paths.workspaceDir, brand.logoPath) },
      analysis,
      manifest,
      hashes: await hashesFor([...mainImages, ...detailImages])
    });
    const reportPath = path.join(outputDir, "report.json");
    await writeJson(reportPath, manifest);

    const packagePath = path.join(outputDir, "package.zip");
    await zipFiles([
      ...mainImages.map((asset) => ({ filePath: asset.path, archivePath: `main/${path.basename(asset.path)}` })),
      ...detailImages.map((asset) => ({ filePath: asset.path, archivePath: `detail/${path.basename(asset.path)}` })),
      { filePath: promptsPath, archivePath: "prompts.json" },
      { filePath: reportPath, archivePath: "report.json" },
      { filePath: analysisPath, archivePath: "analysis.json" }
    ], packagePath);

    const status = failures.length ? "部分失败" : "已完成";
    return {
      sku: task.sku,
      outputDir,
      mainImages,
      detailImages,
      detailImage: detailImages[0],
      analysisPath,
      promptsPath,
      reportPath,
      packagePath,
      report: buildReport(task, brand, mainImages, detailImages, failures, packagePath, undefined, undefined, legacyStoryboard.coverage),
      status,
      failures
    };
  }

  private async generateNative(
    task: ProductTask,
    brand: BrandProfile,
    productImages: LocalProductImage[],
    analysis: ReferenceAnalysis,
    outputDir: string
  ): Promise<ProductOutput> {
    const startedAt = new Date();
    const mainDir = path.join(outputDir, "main");
    const detailDir = path.join(outputDir, "detail");
    const rawDir = path.join(outputDir, "raw");
    await Promise.all([ensureDir(mainDir), ensureDir(detailDir), ensureDir(rawDir)]);
    if (this.config.worker.forceRegenerate) {
      await clearNativeGeneratedOutputs(outputDir, mainDir, detailDir);
    }

    // Fail before vision/text enrichment or image API calls when the task metadata itself
    // identifies a different product category. This prevents contaminated prompts from
    // consuming a provider request and leaves an actionable audit artifact in the output.
    const identityAudit = auditTaskIdentity(task);
    if (!identityAudit.ok) {
      await writeJson(path.join(outputDir, "prompt-audit.json"), {
        generatedAt: new Date().toISOString(),
        stage: "identity-preflight",
        taskId: task.taskId ?? task.recordId,
        identity: identityAudit.identity,
        ok: false,
        errors: identityAudit.errors,
        warnings: [],
        forbiddenMatches: [],
        missingEvidence: [],
        duplicateSignatures: []
      });
      throw new Error(`提交前产品身份审核未通过：\n${identityAudit.errors.map((item) => `- ${item}`).join("\n")}`);
    }

    const taskAnalysis = sanitizeReferenceAnalysisForProduct(task, analysis);
    const productVisualInsight = sanitizeProductVisualInsight(
      task,
      await this.buildProductVisualInsight(task, productImages, taskAnalysis)
    );
    const enrichedAnalysis = mergeProductVisualInsight(taskAnalysis, productVisualInsight);
    const storyboard = buildStoryboardPlan(storyboardInput(task, inferSellingPoints(task, enrichedAnalysis)));
    const creativePlan = await this.buildCreativePlan(task, productVisualInsight, storyboard);
    await writeJson(path.join(outputDir, "creative-plan.json"), {
      generatedAt: new Date().toISOString(),
      taskId: task.taskId ?? task.recordId,
      ...creativePlan
    });
    if (!creativePlan.audit.passed) {
      throw new Error(`创意分镜审核未通过：\n${creativePlan.audit.errors.map((item) => `- ${item}`).join("\n")}`);
    }
    const specs = buildNativeImageSpecs(task, brand, enrichedAnalysis, productVisualInsight, creativePlan);
    const selectedSpecs = [
      ...specs.filter((spec) => spec.role === "main").slice(0, task.mainImageCount),
      ...(task.generateDetail ? specs.filter((spec) => spec.role === "detail") : [])
    ];
    const promptAudit = auditNativePromptSet(task, selectedSpecs, {
      trustedVisualEvidence: [productVisualInsight.summary, ...productVisualInsight.productFacts].filter(Boolean).join("\n")
    });
    await writeJson(path.join(outputDir, "prompt-audit.json"), {
      generatedAt: new Date().toISOString(),
      taskId: task.taskId ?? task.recordId,
      identity: promptAudit.identity,
      expectedCount: promptAudit.expectedCount,
      actualCount: promptAudit.actualCount,
      ok: promptAudit.ok,
      errors: promptAudit.errors,
      warnings: promptAudit.warnings,
      forbiddenMatches: promptAudit.forbiddenMatches,
      missingEvidence: promptAudit.missingEvidence,
      duplicateSignatures: promptAudit.duplicateSignatures
    });
    if (!promptAudit.ok) {
      throw new Error(formatPromptAuditFailure(promptAudit));
    }
    const mainImages: GeneratedAsset[] = [];
    const detailImages: GeneratedAsset[] = [];
    const failures: AssetFailure[] = [];

    const jobs = selectedSpecs.map((spec) => ({
      spec,
      outputPath: path.join(
        spec.role === "main" ? mainDir : detailDir,
        `${pad(spec.index)}-${safeSegment(spec.title)}.png`
      )
    }));
    const promptsPath = path.join(outputDir, "prompts.json");
    const promptRecords = jobs.map(({ spec, outputPath }) => buildNativePromptRecord(spec, outputPath));
    const promptRecordByKey = new Map(promptRecords.map((record) => [nativeSpecKey(record.role, record.index), record]));
    let promptRecordsWriteChain = Promise.resolve();
    const updatePromptRecord = (spec: NativeImageSpec, patch: Partial<NativePromptRecord>): void => {
      const record = promptRecordByKey.get(nativeSpecKey(spec.role, spec.index));
      if (record) Object.assign(record, patch);
    };
    const persistPromptRecords = async () => {
      promptRecordsWriteChain = promptRecordsWriteChain.then(() => writeJson(promptsPath, sortNativePromptRecords(promptRecords)));
      await promptRecordsWriteChain;
    };
    await persistPromptRecords();
    const pendingJobs: NativeImageJob[] = [];
    for (const { spec, outputPath } of jobs) {
      const reused = this.config.worker.forceRegenerate ? null : await this.reuseNativeAsset(spec, outputPath);
      if (reused) {
        if (spec.role === "main") mainImages.push(reused);
        else detailImages.push(reused);
        updatePromptRecord(spec, { status: "reused", reused: true, attempts: 0 });
      } else {
        pendingJobs.push({ spec, outputPath });
      }
    }

    // A completed hero is useful immediately, while a completed detail screen is
    // only useful after the buyer can recognize the product. Keep main images at
    // the head of the queue without withholding empty slots from detail images.
    pendingJobs.splice(0, pendingJobs.length, ...prioritizeNativeImageJobs(pendingJobs));

    const progress = createNativeProgress(selectedSpecs.length, mainImages, detailImages);
    const publishProgress = (stage: NativeProgressStage, message: string, patch: Partial<NativeGenerationProgress> = {}) => {
      Object.assign(progress, patch, { stage, message, updatedAt: new Date().toISOString() });
      emitNativeProgress(progress);
    };

    const imageJobConcurrency = nativeImageJobConcurrency(this.config.openai.imageProvider);
    const imageJobCooldownMs = nativeImageJobCooldownMs(this.config.openai.imageProvider);
    console.log(
      `[native-image] provider=${this.config.openai.imageProvider} pending=${pendingJobs.length} concurrency=${imageJobConcurrency} startCooldownMs=${imageJobCooldownMs} requestTimeoutMs=${openAiImageTimeoutMs()}`
    );
    publishProgress(
      mainImages.length < task.mainImageCount ? "generating-main" : "generating-detail",
      mainImages.length < task.mainImageCount ? "正在优先生成主图，首张完成后即可预览。" : "正在并行生成详情页。",
      { concurrency: imageJobConcurrency }
    );
    await mapAdaptiveNativeImageJobs(
      {
        provider: this.config.openai.imageProvider,
        items: pendingJobs,
        initialConcurrency: imageJobConcurrency,
        cooldownMs: imageJobCooldownMs,
        label: ({ spec }) => nativeImageJobLabel(spec),
        mapper: async ({ spec, outputPath }, _index, schedulerAttempt) => {
          try {
            const generation = await this.generateValidatedNativeAsset({
              spec,
              outputPath,
              productImages,
              task,
              invalidDir: path.join(rawDir, "invalid-native"),
              attemptNumber: schedulerAttempt
            });
            const normalized = generation;
            const quality = normalized.quality;
            if (!quality.passed) throw new Error(quality.warnings.join("; "));
            return {
              attempts: Math.max(generation.attempts, schedulerAttempt),
              quality,
              generation,
              width: normalized.width,
              height: normalized.height
            };
          } catch (error) {
            throw attachAttemptCount(error, Math.max(schedulerAttempt, attemptedCountFromError(error)));
          }
        },
        onSettled: async ({ spec, outputPath }, result, _index, schedulerAttempt) => {
          try {
            if (result.status === "rejected") throw result.reason;
            const { attempts, quality, generation, width, height } = result.value;
            const stat = await fs.stat(outputPath);
            const asset: GeneratedAsset = {
              role: spec.role,
              index: spec.index,
              title: spec.title,
              prompt: spec.prompt,
              path: outputPath,
              width,
              height,
              bytes: stat.size,
              attempts,
              quality
            };
            if (spec.role === "main") mainImages.push(asset);
            else detailImages.push(asset);
            progress.completed += 1;
            if (spec.role === "main") progress.mainCompleted += 1;
            else progress.detailCompleted += 1;
            if (!progress.firstPreviewAt && spec.role === "main") {
              progress.firstPreviewAt = new Date().toISOString();
              progress.firstPreviewElapsedMs = Date.now() - startedAt.getTime();
            }
            updatePromptRecord(spec, {
              status: "completed",
              taskId: generation.taskId,
              submittedAt: generation.submittedAt,
              attempts
            });
          } catch (error) {
            const attempts = Math.max(schedulerAttempt, attemptedCountFromError(error));
            updatePromptRecord(spec, {
              status: "failed",
              error: errorMessage(error),
              attempts
            });
            failures.push(failure(spec.role, spec.index, spec.title, error, attempts));
          }
          await persistPromptRecords();
          publishProgress(
            progress.mainCompleted < task.mainImageCount ? "generating-main" : "generating-detail",
            progress.mainCompleted < task.mainImageCount
              ? `主图 ${progress.mainCompleted}/${task.mainImageCount}，首图完成后可立即查看。`
              : `详情页 ${progress.detailCompleted}/8，主图已可查看。`
          );
        },
        onRetry: ({ delayMs, concurrency, backpressure }) => {
        progress.retries += 1;
        if (backpressure) progress.backpressureCount += 1;
        publishProgress(
          "generating-main",
          backpressure ? "供应商繁忙，已自动降低并发并继续生成。" : "图片生成正在自动重试。",
          { concurrency, nextRetryDelayMs: delayMs }
        );
        },
        onBackpressure: ({ concurrency }) => {
          publishProgress("generating-main", "供应商限流，已降低并发以保证稳定完成。", { concurrency });
        }
      }
    );

    const hasNativeAsset = (spec: NativeImageSpec): boolean =>
      (spec.role === "main" ? mainImages : detailImages).some((asset) => asset.index === spec.index);
    const registerRecoveredNativeAsset = async (
      job: NativeImageJob,
      generation: NativeGeneratedAssetResult,
      attempts: number
    ): Promise<void> => {
      if (!generation.quality.passed) {
        throw new Error(`恢复图片质量检查未通过：${generation.quality.warnings.join("；")}`);
      }
      const stat = await fs.stat(job.outputPath);
      const asset: GeneratedAsset = {
        role: job.spec.role,
        index: job.spec.index,
        title: job.spec.title,
        prompt: job.spec.prompt,
        path: job.outputPath,
        width: generation.width,
        height: generation.height,
        bytes: stat.size,
        attempts,
        quality: generation.quality
      };
      if (job.spec.role === "main") mainImages.push(asset);
      else detailImages.push(asset);
      const existingFailureIndex = failures.findIndex(
        (item) => item.role === job.spec.role && item.index === job.spec.index
      );
      if (existingFailureIndex >= 0) failures.splice(existingFailureIndex, 1);
      updatePromptRecord(job.spec, {
        status: "completed",
        taskId: generation.taskId,
        submittedAt: generation.submittedAt,
        attempts,
        error: undefined
      });
      await persistPromptRecords();
    };

    const missingJobs = pendingJobs.filter(({ spec }) => !hasNativeAsset(spec));
    const canRecoverMissing = mainImages.length + detailImages.length > 0;
    if (missingJobs.length && canRecoverMissing) {
      const recoveryConcurrency = nativeImageRecoveryConcurrency();
      console.warn(`[native-image] recovery queue start missing=${missingJobs.length} concurrency=${recoveryConcurrency}`);
      publishProgress("recovering", `正在并行补齐 ${missingJobs.length} 张失败图片。`, { concurrency: recoveryConcurrency });
      await mapLimitedSettled(
        missingJobs,
        recoveryConcurrency,
        async (job) => {
          let lastRecoveryError: unknown;
          for (let recoveryAttempt = 1; recoveryAttempt <= 2; recoveryAttempt += 1) {
            try {
              const generation = await this.generateValidatedNativeAsset({
                spec: job.spec,
                outputPath: job.outputPath,
                productImages,
                task,
                invalidDir: path.join(rawDir, "invalid-native"),
                attemptNumber: 100 + recoveryAttempt
              });
              return { generation, recoveryAttempt };
            } catch (error) {
              lastRecoveryError = error;
              if (recoveryAttempt < 2) await sleep(1_500 * recoveryAttempt);
            }
          }
          throw attachAttemptCount(lastRecoveryError, 2);
        },
        async (job, result) => {
          if (result.status === "fulfilled") {
            const { generation, recoveryAttempt } = result.value;
            await registerRecoveredNativeAsset(job, generation, generation.attempts + recoveryAttempt);
            progress.completed += 1;
            if (job.spec.role === "main") progress.mainCompleted += 1;
            else progress.detailCompleted += 1;
            if (!progress.firstPreviewAt && job.spec.role === "main") {
              progress.firstPreviewAt = new Date().toISOString();
              progress.firstPreviewElapsedMs = Date.now() - startedAt.getTime();
            }
            publishProgress("recovering", `正在并行补齐失败图片，已完成 ${progress.completed}/${progress.total}。`);
            console.log(`[native-image] recovery completed ${nativeImageJobLabel(job.spec)} attempt=${recoveryAttempt}`);
            return;
          }
          const existingFailure = failures.find((item) => item.role === job.spec.role && item.index === job.spec.index);
          const recoveryError = errorMessage(result.reason);
          if (existingFailure) {
            existingFailure.error = `${existingFailure.error}; 恢复补图失败：${recoveryError}`;
            existingFailure.attempts += 2;
          } else {
            failures.push(failure(job.spec.role, job.spec.index, job.spec.title, result.reason, 2));
          }
          await persistPromptRecords();
        }
      );
    } else if (missingJobs.length) {
      console.warn("[native-image] recovery queue skipped because the initial batch produced no usable image");
    }

    const generationAuditPath = path.join(outputDir, "generation-audit.json");
    await writeJson(generationAuditPath, {
      generatedAt: new Date().toISOString(),
      expectedCount: selectedSpecs.length,
      actualCount: mainImages.length + detailImages.length,
      missing: selectedSpecs
        .filter(({ role, index }) => !(role === "main" ? mainImages : detailImages).some((asset) => asset.index === index))
        .map(({ role, index, title }) => ({ role, index, title })),
      failures: failures.map((item) => ({ role: item.role, index: item.index, title: item.title, error: item.error, attempts: item.attempts })),
      status: failures.length ? "incomplete" : "complete"
    });

    // File validation only proves that an image exists. Run one batched visual
    // review after the recovery queue so the reviewer can compare all scenes at
    // once and identify repeated compositions or unproven selling points.
    publishProgress("quality-review", "主图已可查看，正在后台进行整组视觉质检。", { concurrency: 0 });
    let visualAudit = await this.auditGeneratedNativeOutput(task, productImages, selectedSpecs, [...mainImages, ...detailImages]);
    if (visualAudit.enabled && !visualAudit.passed && outputVisualAuditRetryEnabled()) {
      const visualRetryItems = visualAudit.items.filter(isActionableGeneratedVisualAuditFailure);
      const visualRetryConcurrency = nativeImageVisualRetryConcurrency();
      if (visualRetryItems.length) {
        publishProgress("quality-retry", `后台质检发现 ${visualRetryItems.length} 张需要返工，正在并行处理。`, {
          concurrency: visualRetryConcurrency,
          qualityRetryTotal: visualRetryItems.length,
          qualityRetryCompleted: 0
        });
      }
      await mapLimitedSettled(
        visualRetryItems,
        visualRetryConcurrency,
        async (item) => {
          const job = jobs.find((candidate) => candidate.spec.role === item.role && candidate.spec.index === item.index);
          if (!job) throw new Error(`未找到质检返工图片：${item.role}-${item.index}`);
          const retrySpec: NativeImageSpec = {
            ...job.spec,
            prompt: `${job.spec.prompt}\n\nVISUAL REVIEW RETRY:\nThe retry must still execute this exact plan:\n${job.spec.auditSummary || "Use the current frame mission above."}\nChange the composition, product state, camera or action as needed to directly prove the selling point. Do not repeat the rejected scene. Review notes: ${item.reasons.join("; ")}`
          };
          // Keep the accepted original until the replacement has passed every check.
          const retryCandidatePath = path.join(
            rawDir,
            `visual-review-${retrySpec.role}-${pad(retrySpec.index)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
          );
          await fs.rm(retryCandidatePath, { force: true });
          const generation = await this.generateValidatedNativeAsset({
            spec: retrySpec,
            outputPath: retryCandidatePath,
            productImages,
            task,
            invalidDir: path.join(rawDir, "invalid-native"),
            attemptNumber: 200 + item.index
          });
          if (!generation.quality.passed) throw new Error(generation.quality.warnings.join("; "));
          await fs.copyFile(retryCandidatePath, job.outputPath);
          await fs.rm(retryCandidatePath, { force: true });
          return { job, retrySpec, generation };
        },
        async (item, result) => {
          progress.qualityRetryCompleted = (progress.qualityRetryCompleted ?? 0) + 1;
          if (result.status === "fulfilled") {
            const { job, retrySpec, generation } = result.value;
            const collection = retrySpec.role === "main" ? mainImages : detailImages;
            const existingIndex = collection.findIndex((asset) => asset.index === retrySpec.index);
            if (existingIndex >= 0) collection.splice(existingIndex, 1);
            await registerRecoveredNativeAsset({ ...job, spec: retrySpec }, generation, generation.attempts + 1);
            updatePromptRecord(job.spec, { status: "completed", attempts: generation.attempts + 1, error: undefined });
            await persistPromptRecords();
            console.log(`[native-image] visual review retry completed ${nativeImageJobLabel(job.spec)}`);
          } else {
            console.warn(`[native-image] visual review retry failed ${item.role}-${item.index}: ${errorMessage(result.reason)}`);
          }
          publishProgress("quality-retry", `后台质检返工 ${progress.qualityRetryCompleted}/${progress.qualityRetryTotal}。`);
        }
      );
      visualAudit = await this.auditGeneratedNativeOutput(task, productImages, selectedSpecs, [...mainImages, ...detailImages]);
    }
    const visualFailures = visualAudit.items.filter((candidate) => !candidate.passed);
    if (visualFailures.length && outputVisualAuditStrict()) {
      for (const item of visualFailures) {
        const existingFailure = failures.find((failureItem) => failureItem.role === item.role && failureItem.index === item.index);
        const reason = `Output visual audit failed: ${item.reasons.join("; ") || "selling point or scene distinction was not confirmed"}`;
        if (existingFailure) {
          existingFailure.error = `${existingFailure.error}; ${reason}`;
        } else {
          failures.push(failure(item.role, item.index, item.title, new Error(reason), 1));
        }
      }
    } else if (visualFailures.length) {
      visualAudit = {
        ...visualAudit,
        warnings: [
          ...visualAudit.warnings,
          `检测到 ${visualFailures.length} 张图片需要人工复核；默认不阻断交付。需要自动返工时设置 IMAGE_OUTPUT_VISION_AUDIT_RETRY=true，需要严格拦截时设置 IMAGE_OUTPUT_VISION_AUDIT_STRICT=true。`
        ]
      };
    }
    await writeJson(path.join(outputDir, "output-visual-audit.json"), visualAudit);
    await writeJson(generationAuditPath, {
      generatedAt: new Date().toISOString(),
      expectedCount: selectedSpecs.length,
      actualCount: mainImages.length + detailImages.length,
      missing: selectedSpecs
        .filter(({ role, index }) => !(role === "main" ? mainImages : detailImages).some((asset) => asset.index === index))
        .map(({ role, index, title }) => ({ role, index, title })),
      failures: failures.map((item) => ({ role: item.role, index: item.index, title: item.title, error: item.error, attempts: item.attempts })),
      visualAudit,
      status: failures.length ? "incomplete" : "complete"
    });

    if (!mainImages.length) {
      await persistPromptRecords();
      throw new Error(`所有主图均生成失败：${failures.map((item) => item.error).join("；")}`);
    }
    sortAssets(mainImages);
    sortAssets(detailImages);
    publishProgress("packaging", "图片已生成，正在整理预览图、质检报告和下载包。", { concurrency: 0 });
    const longDetailPath = detailImages.length
      ? await composeLongDetailImage(detailImages, path.join(outputDir, "详情页完整长图.jpg"))
      : undefined;
    const isEnglishMarketplace = productContext(task).isEnglishMarketplace;
    const mainPreviewPath = mainImages.length
      ? await composeContactSheet(mainImages, path.join(outputDir, "5张主图总览.jpg"), {
        columns: 2,
        cellWidth: 720,
        background: "#f4f0ea",
        labelLanguage: isEnglishMarketplace ? "en" : "zh"
      })
      : undefined;
    const detailPreviewPath = detailImages.length
      ? await composeContactSheet(detailImages, path.join(outputDir, "8张详情页总览.jpg"), {
        columns: 2,
        cellWidth: 520,
        background: "#f4f0ea",
        labelLanguage: isEnglishMarketplace ? "en" : "zh"
      })
      : undefined;
    await persistPromptRecords();
    const designReview = buildDesignReviewReport(task, brand, enrichedAnalysis, [...mainImages, ...detailImages], failures, storyboard.coverage);
    attachDesignReviewToAssets([...mainImages, ...detailImages], designReview);
    const designReviewPath = path.join(outputDir, "design-review.json");
    await writeJson(designReviewPath, designReview);
    const completedAt = new Date();
    const manifest: GenerationManifest = {
      sku: task.sku,
      brandId: brand.id,
      model: this.config.openai.imageModel,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      generationRule: generationRuleManifest(task),
      platformRule: platformRuleManifest(task),
      languageRule: languageRuleManifest(task),
      mainImages,
      detailImages,
      longDetailPath,
      failures,
      sellingPointCoverage: storyboard.coverage,
      designReviewPath,
      designReview,
      productVisualInsight
    };
    const analysisPath = path.join(outputDir, "analysis.json");
    await writeJson(analysisPath, {
      task: safeTaskForReport(task),
      brand: { ...brand, logoPath: brand.logoPath ? path.relative(this.config.paths.workspaceDir, brand.logoPath) : "" },
      analysis: enrichedAnalysis,
      productVisualInsight,
      manifest,
      designReview,
      compositionMode: "native",
      hashes: await hashesFor([...mainImages, ...detailImages])
    });
    const reportPath = path.join(outputDir, "report.json");
    await writeJson(reportPath, manifest);

    const packagePath = path.join(outputDir, "package.zip");
    await zipFiles([
      ...mainImages.map((asset) => ({ filePath: asset.path, archivePath: `main/${path.basename(asset.path)}` })),
      ...detailImages.map((asset) => ({ filePath: asset.path, archivePath: `detail/${path.basename(asset.path)}` })),
      ...(longDetailPath ? [{ filePath: longDetailPath, archivePath: path.basename(longDetailPath) }] : []),
      ...(mainPreviewPath ? [{ filePath: mainPreviewPath, archivePath: path.basename(mainPreviewPath) }] : []),
      ...(detailPreviewPath ? [{ filePath: detailPreviewPath, archivePath: path.basename(detailPreviewPath) }] : []),
      { filePath: promptsPath, archivePath: "prompts.json" },
      { filePath: generationAuditPath, archivePath: "generation-audit.json" },
      { filePath: path.join(outputDir, "output-visual-audit.json"), archivePath: "output-visual-audit.json" },
      { filePath: designReviewPath, archivePath: "design-review.json" },
      { filePath: reportPath, archivePath: "report.json" },
      { filePath: analysisPath, archivePath: "analysis.json" }
    ], packagePath);

    const status = failures.length ? "部分失败" : "已完成";
    publishProgress("complete", failures.length ? "图片生成完成，存在需要处理的失败项。" : "图片、质检和下载包均已完成。", {
      completed: mainImages.length + detailImages.length,
      mainCompleted: mainImages.length,
      detailCompleted: detailImages.length,
      concurrency: 0
    });
    return {
      sku: task.sku,
      outputDir,
      mainImages,
      detailImages,
      detailImage: detailImages[0],
      longDetailPath,
      analysisPath,
      promptsPath,
      designReviewPath,
      reportPath,
      packagePath,
      report: buildReport(task, brand, mainImages, detailImages, failures, packagePath, longDetailPath, designReviewPath, storyboard.coverage),
      status,
      failures
    };
  }

  private async buildProductVisualInsight(
    task: ProductTask,
    productImages: LocalProductImage[],
    analysis: ReferenceAnalysis
  ): Promise<ProductVisualInsight> {
    const fallback = buildPromptLayerProductVisualInsight(task, productImages, analysis);
    if (!looksLikeUsableOpenAiKey(this.config.openai.apiKey)) {
      return fallback;
    }
    try {
      return await requestOpenAiProductVisualInsight(this.config, task, productImages, analysis, fallback);
    } catch (error) {
      return {
        ...fallback,
        warnings: [
          ...fallback.warnings,
          `OpenAI 商品视觉预分析不可用，已改用提示词内视觉分析层：${error instanceof Error ? error.message : String(error)}`
        ]
      };
    }
  }

  private async buildCreativePlan(
    task: ProductTask,
    insight: ProductVisualInsight,
    storyboard: StoryboardPlan
  ): Promise<CreativePlan> {
    const fallback = buildDeterministicCreativePlan(task, insight, storyboard);
    if (!looksLikeUsableOpenAiKey(this.config.openai.apiKey)) return fallback;
    try {
      const directed = await requestOpenAiCreativePlan(this.config, task, insight, fallback);
      if (directed.audit.passed) return directed;
      return {
        ...fallback,
        warnings: [
          ...fallback.warnings,
          `创意导演结果未通过去重审核，已使用确定性分镜：${directed.audit.errors.join("；")}`
        ]
      };
    } catch (error) {
      return {
        ...fallback,
        warnings: [
          ...fallback.warnings,
          `创意导演模型不可用，已使用确定性逐图分镜：${errorMessage(error)}`
        ]
      };
    }
  }

  private async auditGeneratedNativeOutput(
    task: ProductTask,
    productImages: LocalProductImage[],
    specs: NativeImageSpec[],
    assets: GeneratedAsset[]
  ): Promise<GeneratedVisualAuditReport> {
    if (!outputVisualAuditEnabled()) {
      return skippedGeneratedVisualAudit("Output visual audit disabled by IMAGE_OUTPUT_VISION_AUDIT.");
    }
    if (!looksLikeUsableOpenAiKey(this.config.openai.apiKey)) {
      return skippedGeneratedVisualAudit("No compatible vision key configured for output visual audit.");
    }
    try {
      return await requestOpenAiGeneratedVisualAudit(this.config, task, productImages, specs, assets);
    } catch (error) {
      return skippedGeneratedVisualAudit(`Output visual audit unavailable: ${errorMessage(error)}`);
    }
  }

  private async reuseNativeAsset(spec: NativeImageSpec, outputPath: string): Promise<GeneratedAsset | null> {
    try {
      const normalized = await this.normalizeNativeAsset(spec, outputPath);
      const { quality, width, height } = normalized;
      if (!quality.passed) return null;
      const stat = await fs.stat(outputPath);
      return {
        role: spec.role,
        index: spec.index,
        title: spec.title,
        prompt: spec.prompt,
        path: outputPath,
        width,
        height,
        bytes: stat.size,
        attempts: 0,
        quality
      };
    } catch {
      return null;
    }
  }

  async generateValidatedNativeAsset(options: {
    spec: NativeImageSpec;
    outputPath: string;
    productImages: LocalProductImage[];
    task: ProductTask;
    invalidDir: string;
    attemptNumber?: number;
  }): Promise<NativeGeneratedAssetResult> {
    // Retry ownership lives in mapAdaptiveNativeImageJobs. Keeping a second
    // validation loop here would multiply attempts (3 x 3) for one bad asset.
    const maxValidationAttempts = 1;
    let totalAttempts = 0;
    let lastError: unknown;

    for (let validationAttempt = 1; validationAttempt <= maxValidationAttempts; validationAttempt += 1) {
      let providerAttemptsCounted = false;
      try {
        const generation = localImageTestMode()
          ? await this.generateLocalTestNativeAsset(options)
          : this.config.openai.imageProvider === "openai"
            ? await this.generateWithOpenAiNativeRetry({
              prompt: options.spec.prompt,
              referenceImagePaths: options.productImages.map((image) => image.path),
              referenceImageUrls: options.task.referenceImageUrls,
              aspectRatio: options.spec.aspectRatio,
              outputPath: options.outputPath
            })
            : await this.generateWithAiEchoRetry({
              prompt: options.spec.prompt,
              referenceImageUrls: options.task.referenceImageUrls,
              aspectRatio: options.spec.aspectRatio,
              outputPath: options.outputPath,
              maxAttempts: 1
            });

        totalAttempts += Math.max(1, generation.attempts);
        providerAttemptsCounted = true;
        const normalized = await this.normalizeNativeAsset(options.spec, options.outputPath);
        if (!normalized.quality.passed) {
          throw new Error(`generated image validation failed: ${normalized.quality.warnings.join("; ")}`);
        }

        return {
          ...generation,
          attempts: totalAttempts,
          width: normalized.width,
          height: normalized.height,
          quality: normalized.quality
        };
      } catch (error) {
        lastError = error;
        if (!providerAttemptsCounted) {
          totalAttempts += Math.max(1, attemptedCountFromError(error));
        }
        if (isRetryableNativeValidationError(error)) {
          await moveInvalidNativeAsset(
            options.outputPath,
            options.invalidDir,
            options.spec,
            options.attemptNumber ?? validationAttempt
          );
          if (validationAttempt < maxValidationAttempts) {
            await sleep(1800 * validationAttempt);
            continue;
          }
        }
        throw attachAttemptCount(error, Math.max(totalAttempts, validationAttempt));
      }
    }

    throw attachAttemptCount(lastError, Math.max(totalAttempts, maxValidationAttempts));
  }

  private async normalizeNativeAsset(spec: NativeImageSpec, outputPath: string): Promise<{
    width: number;
    height: number;
    quality: ImageQualityResult;
  }> {
    const expectedWidth = nativeResolutionPixels(this.config.openai.aiEchoResolution);
    const expectedHeight = spec.role === "main" ? expectedWidth : nativeDetailHeight(this.config.openai.aiEchoResolution);
    const minBytes = spec.role === "main" ? 200_000 : 250_000;
    const metadata = await sharp(outputPath).metadata();
    const actualWidth = metadata.width ?? 0;
    const actualHeight = metadata.height ?? 0;
    const expectedRatio = expectedWidth / expectedHeight;
    const actualRatio = actualWidth && actualHeight ? actualWidth / actualHeight : 0;
    const canStandardizeOpenAiImage =
      this.config.openai.imageProvider === "openai" &&
      actualWidth >= 512 &&
      actualHeight >= 512 &&
      Math.abs(expectedRatio - actualRatio) < (spec.role === "main" ? 0.03 : 0.16);
    const canStandardizeSameRatioImage = Math.abs(expectedRatio - actualRatio) < 0.012;
    if (
      actualWidth &&
      actualHeight &&
      (actualWidth !== expectedWidth || actualHeight !== expectedHeight) &&
      (canStandardizeSameRatioImage || canStandardizeOpenAiImage)
    ) {
      const resized = await sharp(outputPath)
        .resize(expectedWidth, expectedHeight, { fit: "cover" })
        .png()
        .toBuffer();
      await fs.writeFile(outputPath, resized);
    }
    const quality = await checkGeneratedImage({
      filePath: outputPath,
      expectedWidth,
      expectedHeight,
      brandApplied: true,
      safeArea: true,
      minBytes
    });
    return { width: expectedWidth, height: expectedHeight, quality };
  }

  private async generateLocalTestNativeAsset(options: {
    spec: NativeImageSpec;
    outputPath: string;
    productImages: LocalProductImage[];
    task: ProductTask;
  }): Promise<AiEchoGenerationResult> {
    const width = nativeResolutionPixels(this.config.openai.aiEchoResolution);
    const height = options.spec.role === "main" ? width : nativeDetailHeight(this.config.openai.aiEchoResolution);
    const productPath = options.productImages[0]?.path;
    const productWidth = Math.round(width * (options.spec.role === "main" ? 0.58 : 0.72));
    const productHeight = Math.round(height * (options.spec.role === "main" ? 0.62 : 0.50));
    const productBuffer = productPath
      ? await prepareLocalTestProductBuffer(productPath, productWidth, productHeight)
      : undefined;
    const productMeta = productBuffer ? await sharp(productBuffer).metadata() : undefined;
    const renderedProductWidth = productMeta?.width ?? productWidth;
    const productLeft = Math.max(0, Math.round((width - renderedProductWidth) / 2));
    const productTop = options.spec.role === "main"
      ? Math.round(height * 0.26)
      : Math.round(height * 0.22);
    const composites: sharp.OverlayOptions[] = [
      { input: Buffer.from(localTestBackgroundSvg(width, height, options.spec, options.task)), top: 0, left: 0 },
      { input: Buffer.from(localTestCopySvg(width, height, options.spec, options.task)), top: 0, left: 0 }
    ];
    if (productBuffer) {
      composites.splice(1, 0, { input: productBuffer, top: productTop, left: productLeft });
    }
    await ensureDir(path.dirname(options.outputPath));
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: "#f7f3ed"
      }
    })
      .composite(composites)
      .png({ compressionLevel: 0 })
      .toFile(options.outputPath);
    return {
      taskId: `local-test-${options.spec.role}-${pad(options.spec.index)}`,
      submittedAt: new Date().toISOString(),
      attempts: 1
    };
  }

  private async generateDetailModules(
    task: ProductTask,
    brand: BrandProfile,
    productPath: string,
    detailDir: string,
    mainImages: GeneratedAsset[],
    failures: AssetFailure[]
  ): Promise<GeneratedAsset[]> {
    const modules = buildDetailSpecs(task, brand);
    const assets: GeneratedAsset[] = [];
    for (const module of modules) {
      const backgroundPath = mainImages[(module.index - 1) % mainImages.length]?.path ?? productPath;
      const outputPath = path.join(detailDir, `${pad(module.index)}.jpg`);
      try {
        const attempts = await retry(3, async () => {
          await renderDetailModule({
            backgroundPath,
            productImagePath: productPath,
            outputPath,
            brand,
            moduleIndex: module.index,
            eyebrow: module.eyebrow,
            title: module.title,
            bodyLines: module.bodyLines
          });
          const quality = await checkGeneratedImage({
            filePath: outputPath,
            expectedWidth: 750,
            expectedHeight: 1000,
            brandApplied: true,
            safeArea: true,
            minBytes: 25_000
          });
          if (!quality.passed) throw new Error(quality.warnings.join("；"));
        });
        const quality = await checkGeneratedImage({
          filePath: outputPath,
          expectedWidth: 750,
          expectedHeight: 1000,
          brandApplied: true,
          safeArea: true
        });
        const stat = await fs.stat(outputPath);
        assets.push({
          role: "detail",
          index: module.index,
          title: module.title,
          prompt: "本地品牌模板渲染",
          path: outputPath,
          width: 750,
          height: 1000,
          bytes: stat.size,
          attempts,
          quality
        });
      } catch (error) {
        failures.push(failure("detail", module.index, module.title, error, 3));
      }
    }
    return assets;
  }

  private async generateImage(options: {
    prompt: string;
    referenceImagePaths: string[];
    referenceImageUrls: string[];
    outputPath: string;
    aspectRatio?: "1:1" | "3:4" | "9:16";
  }): Promise<void> {
    if (this.config.openai.imageProvider === "aiecho") {
      await this.generateWithAiEcho(options);
      return;
    }
    const form = new FormData();
    form.set("model", this.config.openai.imageModel);
    form.set("prompt", options.prompt);
    form.set("size", openAiImageSize(options.aspectRatio));
    form.set("quality", "high");
    form.set("input_fidelity", "high");
    form.set("output_format", "png");
    for (const [index, imagePath] of options.referenceImagePaths.entries()) {
      form.append("image", await openAsBlob(imagePath, { type: imageMimeType(imagePath) }), `reference-${index + 1}${path.extname(imagePath)}`);
    }
    const timeoutMs = openAiImageTimeoutMs();
    const response = await fetchWithTimeout(`${this.config.openai.baseUrl}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.openai.apiKey}` },
      body: form
    }, timeoutMs);
    const data = await parseOpenAiResponse(response);
    const base64 = extractImageBase64(data);
    if (!base64) throw new Error("OpenAI 响应中没有图片数据。");
    await fs.writeFile(options.outputPath, Buffer.from(base64, "base64"));
  }

  private async generateWithOpenAiResponsesImage(options: {
    prompt: string;
    referenceImagePaths: string[];
    referenceImageUrls: string[];
    outputPath: string;
    aspectRatio?: "1:1" | "3:4" | "9:16";
  }): Promise<void> {
    const imageContent = await Promise.all(options.referenceImagePaths.slice(0, 5).map(async (imagePath) => ({
      type: "input_image",
      image_url: await imagePathDataUrl(imagePath),
      detail: "high"
    })));
    if (!imageContent.length) {
      throw new Error("OpenAI Responses image generation requires at least one reference image.");
    }
    const timeoutMs = openAiImageTimeoutMs();
    const response = await fetchWithTimeout(`${this.config.openai.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.openai.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.openai.textModel || this.config.openai.imageModel,
        stream: true,
        tools: [{
          type: "image_generation",
          size: openAiImageSize(options.aspectRatio),
          quality: "high",
          output_format: "png"
        }],
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildOpenAiResponsesImagePrompt(options.prompt, options.aspectRatio)
            },
            ...imageContent
          ]
        }]
      })
    }, timeoutMs);
    const data = await parseOpenAiResponseOrStream(response);
    const base64 = extractImageBase64(data);
    if (!base64) {
      const text = extractOpenAiText(data);
      throw new Error(`OpenAI Responses image response did not include image data: ${text.slice(0, 300) || "empty response"}`);
    }
    await fs.writeFile(options.outputPath, Buffer.from(base64, "base64"));
  }

  private async generateWithOpenAiNativeRetry(options: {
    prompt: string;
    referenceImagePaths: string[];
    referenceImageUrls: string[];
    outputPath: string;
    aspectRatio?: "1:1" | "3:4" | "9:16";
  }): Promise<AiEchoGenerationResult> {
    const maxAttempts = openAiImageMaxAttempts();
    const submittedAt = new Date().toISOString();
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.generateImage(options);
        return { taskId: `openai-native-${Date.now()}`, submittedAt, attempts: attempt };
      } catch (error) {
        let currentError: unknown = error;
        if (isUnsupportedOpenAiImagesEndpointError(error)) {
          try {
            await this.generateWithOpenAiResponsesImage(options);
            return { taskId: `openai-responses-image-${Date.now()}`, submittedAt, attempts: attempt };
          } catch (fallbackError) {
            currentError = fallbackError;
          }
        }
        lastError = currentError;
        if (isNativeImageBackpressureError("openai", currentError)) {
          throw attachAttemptCount(currentError, attempt);
        }
        if (attempt < maxAttempts) {
          if (!isRetryableOpenAiImageError(currentError)) {
            throw attachAttemptCount(currentError, attempt);
          }
          await sleep(openAiImageRetryDelayMs(currentError, attempt));
          continue;
        }
        throw attachAttemptCount(lastError, attempt);
      }
    }
    throw attachAttemptCount(lastError, maxAttempts);
  }

  private async generateWithAiEcho(options: {
    prompt: string;
    referenceImagePaths: string[];
    referenceImageUrls: string[];
    outputPath: string;
    aspectRatio?: "1:1" | "3:4" | "9:16";
  }): Promise<void> {
    await this.generateWithAiEchoRetry({
      prompt: options.prompt,
      referenceImageUrls: options.referenceImageUrls,
      aspectRatio: options.aspectRatio,
      outputPath: options.outputPath
    });
  }

  private async generateWithAiEchoRetry(options: {
    prompt: string;
    referenceImageUrls: string[];
    outputPath: string;
    aspectRatio?: "1:1" | "3:4" | "9:16";
    maxAttempts?: number;
  }): Promise<AiEchoGenerationResult> {
    const maxAttempts = Math.max(1, Math.min(3, options.maxAttempts ?? 3));
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const submission = await this.submitAiEchoImage({
          prompt: options.prompt,
          referenceImageUrls: options.referenceImageUrls,
          aspectRatio: options.aspectRatio
        });
        await this.waitForAiEchoResult(submission.taskId, options.outputPath);
        return { ...submission, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && isRetryableAiEchoError(error)) {
          await sleep(2500 * attempt);
          continue;
        }
        throw attachAttemptCount(error, attempt);
      }
    }
    throw attachAttemptCount(lastError, maxAttempts);
  }

  private async submitAiEchoImage(options: {
    prompt: string;
    referenceImageUrls: string[];
    aspectRatio?: "1:1" | "3:4" | "9:16";
  }): Promise<AiEchoSubmission> {
    const referenceUrls = options.referenceImageUrls;
    const submittedAt = new Date().toISOString();
    const submit = await postAiEcho(this.config.openai.aiEchoBaseUrl, "/api/v1/ai/speed/image", {
      prompt: options.prompt,
      model: "gpt-2.0",
      aspectRatio: options.aspectRatio ?? "1:1",
      imageSize: this.config.openai.aiEchoResolution.toUpperCase(),
      resolution: this.config.openai.aiEchoResolution,
      image_urls: referenceUrls.length ? [referenceUrls.join("\n")] : [],
      activationCode: this.config.openai.aiEchoActivationCode
    });
    const taskId = nestedString(submit, ["data", "local_task_id"]);
    if (!taskId) {
      throw new Error(`aiEcho 提交成功但未返回 local_task_id：${JSON.stringify(submit).slice(0, 500)}`);
    }
    return { taskId, submittedAt };
  }

  private async waitForAiEchoResult(taskId: string, outputPath: string): Promise<void> {
    const deadline = Date.now() + aiEchoResultTimeoutMs();
    while (Date.now() < deadline) {
      await sleep(aiEchoPollIntervalMs());
      const result = await postAiEcho(this.config.openai.aiEchoBaseUrl, "/api/v1/ai/speed/image/result", {
        task_id: taskId
      });
      const status = nestedString(result, ["data", "status"]);
      if (status === "completed") {
        const imageUrl = nestedString(result, ["data", "image_url"]);
        if (!imageUrl) throw new Error("aiEcho 任务已完成但没有返回 image_url。");
        const response = await fetchWithTimeout(imageUrl, {}, 90_000);
        if (!response.ok) throw new Error(`aiEcho 成品下载失败：HTTP ${response.status}`);
        await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (status === "failed") {
        const message = nestedString(result, ["data", "error_msg"]) || "未知错误";
        const returned = nestedValue(result, ["data", "is_return"]) === 1 ? "，积分已退回" : "";
        throw new Error(`aiEcho 生图失败：${message}${returned}`);
      }
      if (status && !["pending", "processing"].includes(status)) {
        throw new Error(`aiEcho 返回未知状态：${status}`);
      }
    }
    throw new Error(`aiEcho 生图超时：${taskId}`);
  }
}

async function postAiEcho(baseUrl: string, endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${baseUrl}${endpoint}`;
  let response: Response;
  try {
    response = await retryFetch(3, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`aiEcho 请求失败：${describeFetchError(error)}`);
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`aiEcho 响应不是 JSON：HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  const code = nestedValue(data, ["code"]);
  if (!response.ok || (typeof code === "number" && code !== 200)) {
    const message = nestedString(data, ["msg"]) || text.slice(0, 500);
    throw new Error(`aiEcho API 错误：${message}`);
  }
  return data;
}

function localImageTestMode(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LOCAL_IMAGE_TEST_MODE?.trim() ?? "");
}

async function prepareLocalTestProductBuffer(productPath: string, width: number, height: number): Promise<Buffer> {
  const source = await sharp(productPath)
    .trim({ background: "#ffffff", threshold: 18 })
    .resize(width, height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const data = Buffer.from(source.data);
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const nearWhite = red > 246 && green > 246 && blue > 246;
    const softWhite = red > 234 && green > 234 && blue > 234 && Math.max(red, green, blue) - Math.min(red, green, blue) < 9;
    if (nearWhite) {
      data[index + 3] = 0;
    } else if (softWhite) {
      data[index + 3] = Math.min(data[index + 3], 80);
    }
  }
  return sharp(data, {
    raw: {
      width: source.info.width,
      height: source.info.height,
      channels: 4
    }
  }).png().toBuffer();
}

function localTestBackgroundSvg(width: number, height: number, spec: NativeImageSpec, task: ProductTask): string {
  const role = spec.role;
  const bandHeight = Math.round(height * (role === "main" ? 0.18 : 0.13));
  const circle = Math.round(width * 0.32);
  const scene = localTestSceneSpec(spec.index, role, task);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${scene.start}"/><stop offset="0.52" stop-color="${scene.mid}"/><stop offset="1" stop-color="${scene.end}"/></linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="url(#bg)"/>`,
    `<rect x="0" y="0" width="${width}" height="${bandHeight}" fill="${scene.header}" opacity="0.94"/>`,
    ...localTestSceneShapes(width, height, scene, role),
    `<circle cx="${Math.round(width * 0.86)}" cy="${Math.round(height * 0.18)}" r="${circle}" fill="${scene.accent}" opacity="0.20"/>`,
    `<circle cx="${Math.round(width * 0.16)}" cy="${Math.round(height * 0.82)}" r="${Math.round(circle * 0.66)}" fill="${scene.warm}" opacity="0.26"/>`,
    `<path d="M ${Math.round(width * 0.08)} ${Math.round(height * 0.70)} C ${Math.round(width * 0.36)} ${Math.round(height * 0.62)}, ${Math.round(width * 0.64)} ${Math.round(height * 0.82)}, ${Math.round(width * 0.93)} ${Math.round(height * 0.70)}" fill="none" stroke="${scene.header}" stroke-width="${Math.max(4, Math.round(width * 0.004))}" opacity="0.16"/>`,
    `</svg>`
  ].join("");
}

function localTestSceneSpec(index: number, role: NativeImageSpec["role"], task: ProductTask) {
  const scenes = [
    { start: "#fff5d8", mid: "#eef7ff", end: "#f8fbff", header: "#18324f", accent: "#44b7ff", warm: "#ffd84a", kind: "techDesk" },
    { start: "#fff7e7", mid: "#f3ffe9", end: "#fffdf4", header: "#355b30", accent: "#ffe16a", warm: "#8bd6ff", kind: "studyDesk" },
    { start: "#f8efe7", mid: "#eef5ff", end: "#fffaf4", header: "#5a3f2b", accent: "#ffd45c", warm: "#bfe3ff", kind: "livingRoom" },
    { start: "#f4f7ff", mid: "#fff6dd", end: "#f7fbf5", header: "#303547", accent: "#86d7ff", warm: "#ffe07a", kind: "giftShelf" },
    { start: "#fff8e1", mid: "#ecf9ff", end: "#fbf2e8", header: "#4c2f18", accent: "#ffcc3d", warm: "#75c7ff", kind: "detailMacro" },
    { start: "#edf8ff", mid: "#fff6dc", end: "#f3fbf0", header: "#254b62", accent: "#48c8ff", warm: "#f6cf45", kind: "learningBoard" },
    { start: "#fff4ef", mid: "#eef8ff", end: "#fffcec", header: "#6a3c42", accent: "#f7cf56", warm: "#a4dcff", kind: "parentChild" },
    { start: "#f2f6ff", mid: "#fff8e6", end: "#f7fff4", header: "#26345c", accent: "#7dd8ff", warm: "#ffd34e", kind: "desktopToy" }
  ];
  const offset = role === "detail" ? 2 : 0;
  const scene = scenes[(index + offset - 1) % scenes.length];
  return { ...scene, productName: task.productName || "商品" };
}

function localTestSceneShapes(width: number, height: number, scene: ReturnType<typeof localTestSceneSpec>, role: NativeImageSpec["role"]): string[] {
  const floorY = Math.round(height * (role === "main" ? 0.78 : 0.74));
  const deskY = Math.round(height * (role === "main" ? 0.72 : 0.66));
  const unit = Math.round(width * 0.05);
  const base = [
    `<ellipse cx="${Math.round(width * 0.50)}" cy="${Math.round(height * 0.82)}" rx="${Math.round(width * 0.25)}" ry="${Math.round(height * 0.035)}" fill="#1f2a34" opacity="0.13"/>`,
    `<rect x="0" y="${floorY}" width="${width}" height="${height - floorY}" fill="#ffffff" opacity="0.28"/>`
  ];
  if (scene.kind === "techDesk") {
    return [
      ...base,
      `<rect x="${Math.round(width * 0.10)}" y="${deskY}" width="${Math.round(width * 0.80)}" height="${Math.round(height * 0.035)}" rx="${unit}" fill="#263648" opacity="0.22"/>`,
      `<rect x="${Math.round(width * 0.13)}" y="${Math.round(height * 0.24)}" width="${Math.round(width * 0.22)}" height="${Math.round(height * 0.12)}" rx="${unit}" fill="#ffffff" opacity="0.38"/>`,
      `<circle cx="${Math.round(width * 0.78)}" cy="${Math.round(height * 0.38)}" r="${Math.round(unit * 1.5)}" fill="#44b7ff" opacity="0.30"/>`,
      `<path d="M ${Math.round(width * 0.15)} ${Math.round(height * 0.44)} H ${Math.round(width * 0.34)} V ${Math.round(height * 0.50)} H ${Math.round(width * 0.48)}" fill="none" stroke="#44b7ff" stroke-width="${Math.max(3, Math.round(width * 0.003))}" opacity="0.28"/>`
    ];
  }
  if (scene.kind === "studyDesk" || scene.kind === "learningBoard") {
    return [
      ...base,
      `<rect x="${Math.round(width * 0.09)}" y="${deskY}" width="${Math.round(width * 0.82)}" height="${Math.round(height * 0.045)}" rx="${unit}" fill="#b58a55" opacity="0.25"/>`,
      `<rect x="${Math.round(width * 0.11)}" y="${Math.round(height * 0.37)}" width="${Math.round(width * 0.16)}" height="${Math.round(height * 0.08)}" rx="${Math.round(unit * 0.35)}" fill="#f6cf45" opacity="0.42"/>`,
      `<rect x="${Math.round(width * 0.74)}" y="${Math.round(height * 0.32)}" width="${Math.round(width * 0.13)}" height="${Math.round(height * 0.11)}" rx="${Math.round(unit * 0.35)}" fill="#ffffff" opacity="0.42"/>`,
      `<path d="M ${Math.round(width * 0.72)} ${Math.round(height * 0.49)} q ${Math.round(width * 0.08)} ${-Math.round(height * 0.06)} ${Math.round(width * 0.16)} 0" fill="none" stroke="${scene.header}" stroke-width="${Math.max(4, Math.round(width * 0.004))}" opacity="0.20"/>`
    ];
  }
  if (scene.kind === "livingRoom" || scene.kind === "parentChild") {
    return [
      ...base,
      `<rect x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.61)}" width="${Math.round(width * 0.32)}" height="${Math.round(height * 0.13)}" rx="${unit}" fill="#e8c7aa" opacity="0.36"/>`,
      `<rect x="${Math.round(width * 0.66)}" y="${Math.round(height * 0.33)}" width="${Math.round(width * 0.20)}" height="${Math.round(height * 0.26)}" rx="${Math.round(unit * 0.5)}" fill="#ffffff" opacity="0.32"/>`,
      `<circle cx="${Math.round(width * 0.22)}" cy="${Math.round(height * 0.53)}" r="${Math.round(unit * 1.2)}" fill="#ffd45c" opacity="0.32"/>`,
      `<circle cx="${Math.round(width * 0.76)}" cy="${Math.round(height * 0.62)}" r="${Math.round(unit * 0.9)}" fill="#a4dcff" opacity="0.34"/>`
    ];
  }
  if (scene.kind === "giftShelf") {
    return [
      ...base,
      `<rect x="${Math.round(width * 0.11)}" y="${Math.round(height * 0.34)}" width="${Math.round(width * 0.78)}" height="${Math.round(height * 0.025)}" rx="${Math.round(unit * 0.25)}" fill="#303547" opacity="0.18"/>`,
      `<rect x="${Math.round(width * 0.15)}" y="${Math.round(height * 0.42)}" width="${Math.round(width * 0.16)}" height="${Math.round(height * 0.16)}" rx="${Math.round(unit * 0.25)}" fill="#ffd34e" opacity="0.42"/>`,
      `<rect x="${Math.round(width * 0.72)}" y="${Math.round(height * 0.39)}" width="${Math.round(width * 0.13)}" height="${Math.round(height * 0.19)}" rx="${Math.round(unit * 0.25)}" fill="#86d7ff" opacity="0.34"/>`,
      `<path d="M ${Math.round(width * 0.15)} ${Math.round(height * 0.49)} H ${Math.round(width * 0.31)} M ${Math.round(width * 0.23)} ${Math.round(height * 0.42)} V ${Math.round(height * 0.58)}" stroke="#ffffff" stroke-width="${Math.max(3, Math.round(width * 0.004))}" opacity="0.52"/>`
    ];
  }
  return [
    ...base,
    `<rect x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.34)}" width="${Math.round(width * 0.22)}" height="${Math.round(height * 0.22)}" rx="${unit}" fill="#ffffff" opacity="0.34"/>`,
    `<circle cx="${Math.round(width * 0.80)}" cy="${Math.round(height * 0.48)}" r="${Math.round(unit * 2.1)}" fill="#ffcc3d" opacity="0.32"/>`,
    `<path d="M ${Math.round(width * 0.68)} ${Math.round(height * 0.60)} L ${Math.round(width * 0.85)} ${Math.round(height * 0.43)}" stroke="#4c2f18" stroke-width="${Math.max(5, Math.round(width * 0.006))}" opacity="0.20"/>`
  ];
}

function localTestCopySvg(width: number, height: number, spec: NativeImageSpec, task: ProductTask): string {
  const titleFont = spec.role === "main" ? Math.round(width * 0.07) : Math.round(width * 0.062);
  const subtitleFont = Math.round(width * 0.032);
  const smallFont = Math.round(width * 0.022);
  const titleLines = wrapSvgText(spec.copy[0] || spec.title || task.productName, spec.role === "main" ? 10 : 13).slice(0, 2);
  const subLines = [
    ...(spec.copy.slice(1, 3).length ? spec.copy.slice(1, 3) : [task.category, task.targetAudience])
  ].filter(Boolean).flatMap((line) => wrapSvgText(line, spec.role === "main" ? 16 : 20)).slice(0, 4);
  const top = spec.role === "main" ? Math.round(height * 0.06) : Math.round(height * 0.045);
  const left = Math.round(width * 0.08);
  const bottomCopy = spec.role === "main" ? "本地测试模式生成，验证流程与文件结构" : `详情页测试 ${pad(spec.index)} / 保持商品外观优先`;
  const titleTspans = titleLines.map((line, index) =>
    `<tspan x="${left}" dy="${index === 0 ? 0 : Math.round(titleFont * 1.18)}">${escapeXml(line)}</tspan>`
  ).join("");
  const subTspans = subLines.map((line, index) =>
    `<tspan x="${left}" dy="${index === 0 ? Math.round(titleFont * 1.55) : Math.round(subtitleFont * 1.45)}">${escapeXml(line)}</tspan>`
  ).join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<text x="${left}" y="${top}" font-family="Arial, 'Microsoft YaHei', sans-serif" font-size="${titleFont}" font-weight="800" fill="#ffffff">${titleTspans}</text>`,
    `<text x="${left}" y="${top + Math.round(titleFont * 0.2)}" font-family="Arial, 'Microsoft YaHei', sans-serif" font-size="${subtitleFont}" font-weight="500" fill="#244536">${subTspans}</text>`,
    `<rect x="${left}" y="${height - Math.round(height * 0.10)}" width="${Math.round(width * 0.56)}" height="${Math.round(smallFont * 2.4)}" rx="${Math.round(smallFont * 1.2)}" fill="#244536" opacity="0.88"/>`,
    `<text x="${left + Math.round(smallFont * 1.1)}" y="${height - Math.round(height * 0.10) + Math.round(smallFont * 1.58)}" font-family="Arial, 'Microsoft YaHei', sans-serif" font-size="${smallFont}" font-weight="600" fill="#ffffff">${escapeXml(bottomCopy)}</text>`,
    `</svg>`
  ].join("");
}

function wrapSvgText(value: string, maxChars: number): string[] {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    const next = current + char;
    if (countDisplayChars(next) > maxChars && current) {
      lines.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function countDisplayChars(value: string): number {
  let count = 0;
  for (const char of value) {
    count += /[\u0000-\u00ff]/.test(char) ? 0.55 : 1;
  }
  return count;
}

function buildPromptLayerProductVisualInsight(
  task: ProductTask,
  productImages: LocalProductImage[],
  analysis: ReferenceAnalysis
): ProductVisualInsight {
  const context = productContext(task);
  const candidatePoints = inferSellingPoints(task, analysis).slice(0, 12);
  const imageNames = productImages.map((image) => image.sourceName || path.basename(image.path)).filter(Boolean);
  const facts = [
    imageNames.length ? `本次商品图文件：${imageNames.join("、")}` : "",
    task.productName ? `产品名称：${task.productName}` : "",
    task.category ? `类目：${task.category}` : "",
    task.targetAudience ? `目标人群：${task.targetAudience}` : "",
    task.specs && !isPlaceholderCopy(task.specs) && !specConflictsWithProduct(task.specs, context) ? `需求规格：${task.specs}` : "",
    context.isApparel ? "服装类必须观察真实版型、腰头、裤脚/袖口、垂感、颜色和上身关系" : "",
    context.isBabyCare ? "母婴护理类必须观察真实包装外形、印花、腰围/边缘/层次细节和使用场景逻辑" : "",
    context.isCuttingBoard ? "厨具类必须观察真实板面形状、厚度、边角、纹理、把手/挂孔和冲洗摆放逻辑" : "",
    context.isStudentBackpack ? "学生包类必须观察真实包型、肩带、前袋、拉链、图案、挂件和容量结构" : "",
    context.isBikeBasket ? "骑行车篮类必须观察真实篮筐形状、防水盖/罩、固定扣/连接结构、车把安装关系、开合和装载状态" : ""
  ].filter(Boolean);
  return {
    source: "prompt-layer",
    summary: [
      "未配置 OpenAI 视觉预分析时，使用提示词内视觉分析层。",
      "生图模型必须先观察当前商品图，再把可见事实反哺到卖点、构图和文案。"
    ].join(""),
    productFacts: facts,
    visualSellingPoints: candidatePoints,
    promptDirectives: [
      "先观察当前商品图的颜色、形状、结构、材质、图案、产品本体文字、标签、配件和包装，不允许沿用旧商品描述。",
      "需求文档卖点为空或写请自行分析时，根据商品图可见特征、产品名称、人群和类目补充成消费者能感知的卖点。",
      "每屏文案必须讲商品本身的购买理由，避免页面模块名、空泛情绪词或与画面不匹配的句子。",
      "每屏画面都要让卖点有可见证据：动作、近景、结构放大、真实场景或多角度组合。",
      "商品本体原有文字、Logo、图案、标签和包装信息必须保持，不得抹掉、改字或换成无关品牌。",
      "如果当前商品图与历史提示词、参考案例或类目模板冲突，以当前商品图为准。"
    ],
    warnings: ["未填写 OPENAI_API_KEY，已启用不依赖 OpenAI 的提示词内商品视觉分析。"]
  };
}

async function requestOpenAiProductVisualInsight(
  config: AppConfig,
  task: ProductTask,
  productImages: LocalProductImage[],
  analysis: ReferenceAnalysis,
  fallback: ProductVisualInsight
): Promise<ProductVisualInsight> {
  const imageContent = await Promise.all(productImages.slice(0, 4).map(async (image) => ({
    type: "input_image",
    image_url: await productImageDataUrl(image),
    detail: "high"
  })));
  if (!imageContent.length) return fallback;
  const response = await fetchWithTimeout(`${config.openai.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.openai.textModel || "gpt-5-mini",
      stream: true,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildOpenAiProductVisualPrompt(task, analysis)
            },
            ...imageContent
          ]
        }
      ]
    })
  }, 120_000);
  const data = await parseOpenAiResponseOrStream(response);
  const text = extractOpenAiText(data);
  if (!text) throw new Error("OpenAI 视觉分析响应中没有文本。");
  const parsed = parseJsonObject(text);
  return normalizeProductVisualInsight(parsed, fallback);
}

async function requestOpenAiCreativePlan(
  config: AppConfig,
  task: ProductTask,
  insight: ProductVisualInsight,
  fallback: CreativePlan
): Promise<CreativePlan> {
  const response = await fetchWithTimeout(`${config.openai.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.openai.textModel || "gpt-5-mini",
      stream: true,
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: buildCreativeDirectorRequestPrompt(task, insight, fallback)
        }]
      }]
    })
  }, 120_000);
  const data = await parseOpenAiResponseOrStream(response);
  const text = extractOpenAiText(data);
  if (!text) throw new Error("创意导演响应中没有文本。");
  return normalizeCreativeDirectorResult(parseJsonObject(text), fallback);
}

export async function requestOpenAiGeneratedVisualAudit(
  config: AppConfig,
  task: ProductTask,
  productImages: LocalProductImage[],
  specs: NativeImageSpec[],
  assets: GeneratedAsset[]
): Promise<GeneratedVisualAuditReport> {
  const expected: GeneratedVisualAuditExpected[] = specs.map(({ role, index, title }) => ({ role, index, title }));
  const content: Array<Record<string, unknown>> = [{
    type: "input_text",
    text: buildGeneratedVisualAuditPrompt(task, specs, assets)
  }];
  const referenceImages = await Promise.all(productImages.slice(0, 2).map((image) => auditImageDataUrl(image.path)));
  for (const [index, imageUrl] of referenceImages.entries()) {
    content.push({ type: "input_text", text: `PRODUCT REFERENCE IMAGE ${index + 1}. Use this as the identity source of truth.` });
    content.push({ type: "input_image", image_url: imageUrl, detail: "high" });
  }
  for (const asset of [...assets].sort(assetSort)) {
    content.push({
      type: "input_text",
      text: `GENERATED OUTPUT ${asset.role.toUpperCase()} ${asset.index}: ${asset.title}. Compare this image with the planned selling point and the references.`
    });
    content.push({ type: "input_image", image_url: await auditImageDataUrl(asset.path), detail: "high" });
  }
  const response = await fetchWithTimeout(`${config.openai.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.openai.textModel || "gpt-5-mini",
      stream: true,
      input: [{ role: "user", content }]
    })
  }, outputVisualAuditTimeoutMs());
  const data = await parseOpenAiResponseOrStream(response);
  const text = extractOpenAiText(data);
  if (!text) throw new Error("Output visual audit returned no text.");
  return normalizeGeneratedVisualAudit(parseJsonObject(text), expected);
}

function buildGeneratedVisualAuditPrompt(task: ProductTask, specs: NativeImageSpec[], assets: GeneratedAsset[]): string {
  const plan = specs
    .map((spec) => {
      const asset = assets.find((candidate) => candidate.role === spec.role && candidate.index === spec.index);
      return [
        `${spec.role} ${spec.index}: ${spec.title}`,
        `planned selling point: ${spec.copy.join(" | ")}`,
        `planned scene and proof contract:\n${spec.auditSummary || spec.prompt.slice(0, 1_800)}`,
        `output exists: ${asset ? "yes" : "no"}`
      ].join("\n");
    })
    .join("\n\n");
  return [
    "You are the final visual quality auditor for an ecommerce image set.",
    "Return JSON only. Do not use Markdown.",
    "Use exactly this root shape: {\"items\":[{\"role\":\"main\",\"index\":1,\"passed\":true,\"identityMatch\":true,\"sellingPointShown\":true,\"noForbiddenObjects\":true,\"sceneDistinct\":true,\"artDirectionMatch\":true,\"copyLanguageCorrect\":true,\"reasons\":[]}],\"warnings\":[]}.",
    "Return exactly one items entry for every expected role/index pair. Keep role as main or detail and index as an integer.",
    "The first reference images are the product identity source of truth. Generated outputs are labelled after them.",
    "Judge the actual generated pixels, not just the planned prompt.",
    "For each expected output, return: role, index, passed, identityMatch, sellingPointShown, noForbiddenObjects, sceneDistinct, artDirectionMatch, copyLanguageCorrect, reasons.",
    "identityMatch: the product remains the same product, with its key shape, color, proportions and details preserved. If the planned scene explicitly permits an evidence-only frame where the product is absent, absence alone is not an identity failure.",
    "sellingPointShown: the main visual composition proves the specific selling point with a concrete scene, object, action, close-up or visual metaphor; text alone is not proof.",
    "noForbiddenObjects: no unrelated product category, stale example, watermark, price, fake certification or unsupported claim is introduced.",
    "sceneDistinct: this output has a materially different composition, action or visual evidence from the other outputs, not only a changed caption or background.",
    "artDirectionMatch: the actual output follows the selected platform's visual intent, hierarchy, restraint/richness and material finish rather than looking like a generic poster.",
    "copyLanguageCorrect: all newly rendered marketing copy uses the selected output language consistently; original product/packaging/logo text is exempt.",
    "A product may be a small supporting element when the selling point is better proved by a battery, language classroom, storage diagram, material close-up or other relevant evidence. Do not require the product to appear in every frame.",
    `product name: ${task.productName || "not provided"}`,
    `user selling points: ${promptSellingPoints(task) || "not provided"}`,
    `target platform: ${task.targetPlatform || "default domestic"}`,
    `output language: ${task.outputLanguage || "Simplified Chinese"}`,
    "Expected output plan:",
    plan,
    `Expected count: ${specs.length}`
  ].join("\n");
}

function buildOpenAiProductVisualPrompt(task: ProductTask, analysis: ReferenceAnalysis): string {
  return [
    "你是国内电商提示词总控台的商品视觉分析员。请只分析本次上传的商品图，输出严格 JSON，不要 Markdown。",
    "目标：提取商品真实可见事实，并把产品名称、人群、类目、简短卖点拓展成能进入淘宝/天猫主图和详情页的卖点。",
    "必须遵守：如果需求文档或参考案例与商品图冲突，以商品图为准；不要虚构不可见/未提供的材质、认证、功效、数据；商品本体文字、Logo、图案、标签必须提醒后续生图保留。",
    `产品名称：${task.productName || ""}`,
    `目标人群：${task.targetAudience || ""}`,
    `类目：${task.category || ""}`,
    `用户填写卖点：${promptSellingPoints(task)}`,
    `规格参数：${task.specs || ""}`,
    `特殊要求：${task.notes || ""}`,
    `参考案例抽象结论：${[
      analysis.summary,
      ...analysis.visualPatterns.slice(0, 4),
      ...analysis.sellingPointPatterns.slice(0, 4),
      ...analysis.detailPagePatterns.slice(0, 4)
    ].filter(Boolean).join("；")}`,
    "返回 JSON 字段：summary 字符串；productFacts 字符串数组；visualSellingPoints 字符串数组；promptDirectives 字符串数组；warnings 字符串数组。",
    "productFacts 写商品图真实可见事实，包含颜色、结构、材质观感、图案/文字/标签、配件、包装、使用状态。",
    "visualSellingPoints 写可用于画面和文案的消费者卖点，不写模块名。",
    "promptDirectives 写后续每张图必须执行的画面/文案/一致性规则。"
  ].join("\n");
}

async function productImageDataUrl(image: LocalProductImage): Promise<string> {
  const buffer = await sharp(image.path)
    .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer();
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

async function imagePathDataUrl(imagePath: string): Promise<string> {
  const buffer = await sharp(imagePath)
    .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer();
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

async function auditImageDataUrl(imagePath: string): Promise<string> {
  const buffer = await sharp(imagePath)
    .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 72, progressive: true })
    .toBuffer();
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

function imageMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/jpeg";
}

function openAiImageSize(aspectRatio?: "1:1" | "3:4" | "9:16"): string {
  if (aspectRatio === "3:4" || aspectRatio === "9:16") return "1024x1536";
  return "1024x1024";
}

function buildOpenAiResponsesImagePrompt(prompt: string, aspectRatio?: "1:1" | "3:4" | "9:16"): string {
  const ratioInstruction = aspectRatio === "3:4" || aspectRatio === "9:16"
    ? "Output a vertical ecommerce image in 1024x1536 / 9:16 style."
    : "Output a square ecommerce image in 1024x1024 / 1:1 style.";
  return [
    "You are generating an ecommerce product image with the OpenAI Responses image_generation tool.",
    ratioInstruction,
    "Use the uploaded product reference images as the strict source of truth. Preserve the product identity, shape, color, proportions, material feel, packaging/body text, logos, visible labels, pattern, accessories, and distinctive details.",
    "Do not create a different product. Do not replace the product with a generic object. Supporting people, hands, props, environments, callouts, and close-ups are allowed only when they prove the selling point and do not obscure the product.",
    "All visible marketing text must follow the user's prompt language and must not contain random text, watermark, platform UI, QR code, price, fake certification, or unsupported data.",
    "Return the final image only.",
    "",
    prompt
  ].join("\n");
}

function normalizeProductVisualInsight(value: unknown, fallback: ProductVisualInsight): ProductVisualInsight {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const summary = typeof object.summary === "string" && object.summary.trim()
    ? object.summary.trim()
    : fallback.summary;
  const productFacts = cleanBusinessPhrases([...fallback.productFacts, ...stringArray(object.productFacts)]).slice(0, 12);
  const visualSellingPoints = cleanBusinessPhrases([...stringArray(object.visualSellingPoints), ...fallback.visualSellingPoints]).slice(0, 12);
  const promptDirectives = cleanBusinessPhrases([...stringArray(object.promptDirectives), ...fallback.promptDirectives]).slice(0, 10);
  const warnings = cleanBusinessPhrases(stringArray(object.warnings)).slice(0, 5);
  return {
    source: "openai-vision",
    summary,
    productFacts,
    visualSellingPoints,
    promptDirectives,
    warnings
  };
}

function mergeProductVisualInsight(analysis: ReferenceAnalysis, insight: ProductVisualInsight): ReferenceAnalysis {
  const visualPatterns = [...analysis.visualPatterns];
  addUnique(visualPatterns, insight.productFacts.map((item) => `商品视觉事实：${item}`));
  addUnique(visualPatterns, insight.promptDirectives.map((item) => `商品图执行指令：${item}`));
  const sellingPointPatterns = [...analysis.sellingPointPatterns];
  addUnique(sellingPointPatterns, insight.visualSellingPoints);
  const brandVisualLogic = [...(analysis.brandVisualLogic ?? [])];
  addUnique(brandVisualLogic, [
    "先基于当前商品图提取商品事实，再拆文案、定画面和安排详情页节奏。",
    "所有参考案例只学习版式、镜头和销售动线，不覆盖当前商品外观。"
  ]);
  const designReviewRules = [...(analysis.designReviewRules ?? [])];
  addUnique(designReviewRules, [
    "审核首图商品是否为第一视觉主体。",
    "审核套图是否统一视觉系统。",
    "审核每屏是否有明确转化目标和画面证据。",
    "审核提示词是否包含当前商品图视觉分析层。",
    "审核卖点文案是否来自商品图、产品名、人群和类目，而不是通用模块名。"
  ]);
  return {
    ...analysis,
    summary: [analysis.summary, `商品视觉分析：${insight.summary}`].filter(Boolean).join("\n"),
    visualPatterns,
    sellingPointPatterns,
    brandVisualLogic,
    designReviewRules
  };
}

function looksLikeUsableOpenAiKey(value: string): boolean {
  const key = value.trim();
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key) || /^key-[A-Za-z0-9_-]{20,}$/.test(key);
}

function extractOpenAiText(data: unknown): string {
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>).output_text === "string") {
    return (data as Record<string, unknown>).output_text as string;
  }
  const chunks: string[] = [];
  const stack: unknown[] = [data];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const object = current as Record<string, unknown>;
    for (const key of ["text", "content"]) {
      if (typeof object[key] === "string") chunks.push(object[key] as string);
    }
    stack.push(...Object.values(object));
  }
  return chunks.join("\n").trim();
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`视觉分析 JSON 解析失败：${trimmed.slice(0, 200)}`);
  }
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return splitList(value);
  return [];
}

async function retryFetch(maxAttempts: number, url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchWithTimeout(url, init, 60_000);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(1200 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function openAiImageTimeoutMs(): number {
  return readPositiveIntegerEnv("OPENAI_IMAGE_TIMEOUT_MS", 300_000, 60_000, 300_000);
}

function outputVisualAuditEnabled(): boolean {
  return !/^(0|false|no)$/i.test(process.env.IMAGE_OUTPUT_VISION_AUDIT?.trim() ?? "true");
}

function outputVisualAuditRetryEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.IMAGE_OUTPUT_VISION_AUDIT_RETRY?.trim() ?? "false");
}

function outputVisualAuditStrict(): boolean {
  return /^(1|true|yes)$/i.test(process.env.IMAGE_OUTPUT_VISION_AUDIT_STRICT?.trim() ?? "false");
}

function outputVisualAuditTimeoutMs(): number {
  return readPositiveIntegerEnv("IMAGE_OUTPUT_VISION_AUDIT_TIMEOUT_MS", 120_000, 30_000, 300_000);
}

function assetSort(left: GeneratedAsset, right: GeneratedAsset): number {
  if (left.role !== right.role) return left.role === "main" ? -1 : 1;
  return left.index - right.index;
}

function aiEchoResultTimeoutMs(): number {
  return readPositiveIntegerEnv("AIECHO_IMAGE_TIMEOUT_MS", 300_000, 60_000, 300_000);
}

function aiEchoPollIntervalMs(): number {
  return readPositiveIntegerEnv("AIECHO_IMAGE_POLL_INTERVAL_MS", 3_000, 250, 30_000);
}

function openAiImageMaxAttempts(): number {
  return readPositiveIntegerEnv("OPENAI_IMAGE_MAX_RETRIES", 1, 1, 8);
}

function nativeImageJobConcurrency(provider: string): number {
  const shared = process.env.IMAGE_JOB_CONCURRENCY;
  if (shared && shared.trim()) return readPositiveIntegerEnv("IMAGE_JOB_CONCURRENCY", 5, 1, 8);
  return provider === "openai"
    ? readPositiveIntegerEnv("OPENAI_IMAGE_CONCURRENCY", 5, 1, 8)
    : readPositiveIntegerEnv("AIECHO_IMAGE_CONCURRENCY", 5, 1, 8);
}

function nativeImageJobCooldownMs(provider: string): number {
  const shared = process.env.IMAGE_JOB_COOLDOWN_MS;
  if (shared && shared.trim()) return readNonNegativeIntegerEnv("IMAGE_JOB_COOLDOWN_MS", 0, 0, 300_000);
  return provider === "openai"
    ? readNonNegativeIntegerEnv("OPENAI_IMAGE_COOLDOWN_MS", 0, 0, 300_000)
    : readNonNegativeIntegerEnv("AIECHO_IMAGE_COOLDOWN_MS", 0, 0, 300_000);
}

function openAiImageRetryDelayMs(error: unknown, attempt: number): number {
  const base = isOpenAiRateLimitError(error)
    ? readPositiveIntegerEnv("OPENAI_IMAGE_429_RETRY_AFTER_MS", 15_000, 1_000, 300_000)
    : readPositiveIntegerEnv("OPENAI_IMAGE_RETRY_DELAY_MS", 5_000, 500, 120_000);
  const max = readPositiveIntegerEnv("OPENAI_IMAGE_MAX_RETRY_DELAY_MS", 180_000, base, 600_000);
  return Math.min(max, base * Math.max(1, attempt));
}

function isRetryableOpenAiImageError(error: unknown): boolean {
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  if (typeof status === "number" && [408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const message = errorMessage(error);
  return /429|rate\s*limit|concurrency\s*limit|retry\s+later|too\s+many\s+requests|timed?\s*out|timeout|temporarily|temporary|overloaded|terminated|upstream\s+request\s+failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|AbortError|HTTP\s+50[234]/i.test(message);
}

function isOpenAiRateLimitError(error: unknown): boolean {
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return status === 429 || /429|rate\s*limit|concurrency\s*limit|too\s+many\s+requests/i.test(errorMessage(error));
}

function readPositiveIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function readNonNegativeIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isRetryableAiEchoError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /任务执行超时|请重试|生图超时|timed?\s*out|timeout|please\s+retry|busy|overloaded|rate\s*limit|temporarily|temporary|排队|繁忙|服务器忙|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP\s+50[234]/i.test(message);
}

function attachAttemptCount(error: unknown, attempts: number): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  (normalized as Error & { attempts?: number }).attempts = attempts;
  return normalized;
}

function attemptedCountFromError(error: unknown): number {
  const attempts = error && typeof error === "object" ? (error as { attempts?: unknown }).attempts : undefined;
  return typeof attempts === "number" && Number.isFinite(attempts) && attempts > 0 ? attempts : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableNativeValidationError(error: unknown): boolean {
  return /dimension|ratio|expected|validation|2048x|1024x|1536|3642|尺寸|比例|不符合/i.test(errorMessage(error));
}

function nativeImageJobLabel(spec: NativeImageSpec): string {
  const role = spec.role === "main" ? "main" : "detail";
  return `${role}-${String(spec.index).padStart(2, "0")}-${spec.title}`;
}

export function prioritizeNativeImageJobs<T extends { spec: Pick<NativeImageSpec, "role" | "index"> }>(jobs: T[]): T[] {
  return [...jobs].sort((left, right) => {
    if (left.spec.role !== right.spec.role) return left.spec.role === "main" ? -1 : 1;
    return left.spec.index - right.spec.index;
  });
}

function nativeImageJobMaxAttempts(provider: string): number {
  const specific = provider === "openai" ? "OPENAI_IMAGE_JOB_MAX_ATTEMPTS" : "AIECHO_IMAGE_JOB_MAX_ATTEMPTS";
  if (process.env[specific]?.trim()) return readPositiveIntegerEnv(specific, 4, 1, 8);
  if (process.env.IMAGE_JOB_MAX_ATTEMPTS?.trim()) return readPositiveIntegerEnv("IMAGE_JOB_MAX_ATTEMPTS", 4, 1, 8);
  return provider === "openai" ? 4 : 3;
}

function nativeImageJobTotalTimeoutMs(): number {
  // This is the whole batch deadline, not the per-request timeout. A 5+8 set
  // can legitimately exceed five minutes after 429 backoff, so honor the
  // configured one-hour budget while keeping a finite safety ceiling.
  return readPositiveIntegerEnv("IMAGE_JOB_TOTAL_TIMEOUT_MS", 3_600_000, 300_000, 7_200_000);
}

function nativeImageConcurrencyLadder(provider: string): number[] {
  const specific = provider === "openai" ? "OPENAI_IMAGE_CONCURRENCY_LADDER" : "AIECHO_IMAGE_CONCURRENCY_LADDER";
  const raw = process.env[specific]?.trim() || process.env.IMAGE_JOB_CONCURRENCY_LADDER?.trim();
  const values = raw
    ? raw.split(/[,\s]+/).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 1)
    : [5, 3, 2, 1];
  const uniqueDescending = Array.from(new Set(values.map((value) => Math.max(1, Math.min(8, Math.floor(value))))));
  uniqueDescending.sort((a, b) => b - a);
  return uniqueDescending.length ? uniqueDescending : [1];
}

function nextNativeImageBackpressureConcurrency(provider: string, currentConcurrency: number): number {
  const ladder = nativeImageConcurrencyLadder(provider);
  const next = ladder.find((value) => value < currentConcurrency);
  return next ?? 1;
}

function nativeImageJobRetryDelayMs(provider: string, error: unknown, schedulerAttempt: number): number {
  if (isNativeImageBackpressureError(provider, error)) {
    const specific = provider === "openai" ? "OPENAI_IMAGE_BACKPRESSURE_DELAY_MS" : "AIECHO_IMAGE_BACKPRESSURE_DELAY_MS";
    const value = process.env[specific]?.trim()
      ? readPositiveIntegerEnv(specific, 15_000, 5_000, 300_000)
      : readPositiveIntegerEnv("IMAGE_JOB_BACKPRESSURE_DELAY_MS", 15_000, 5_000, 300_000);
    return value;
  }
  const specific = provider === "openai" ? "OPENAI_IMAGE_TRANSIENT_RETRY_DELAY_MS" : "AIECHO_IMAGE_TRANSIENT_RETRY_DELAY_MS";
  const base = process.env[specific]?.trim()
    ? readPositiveIntegerEnv(specific, 5_000, 1_000, 120_000)
    : readPositiveIntegerEnv("IMAGE_JOB_TRANSIENT_RETRY_DELAY_MS", 5_000, 1_000, 120_000);
  const max = readPositiveIntegerEnv("IMAGE_JOB_MAX_RETRY_DELAY_MS", 90_000, base, 300_000);
  return Math.min(max, base * Math.max(1, schedulerAttempt));
}

function nativeImageRecoveryConcurrency(): number {
  return readPositiveIntegerEnv("IMAGE_RECOVERY_CONCURRENCY", 2, 1, 4);
}

function nativeImageVisualRetryConcurrency(): number {
  return readPositiveIntegerEnv("IMAGE_OUTPUT_VISION_AUDIT_RETRY_CONCURRENCY", 2, 1, 4);
}

function isNativeImageBackpressureError(provider: string, error: unknown): boolean {
  if (provider === "openai" && isOpenAiRateLimitError(error)) return true;
  return /429|rate\s*limit|concurrency\s*limit|too\s+many\s+requests|retry\s+later|terminated|排队|繁忙|限流/i.test(errorMessage(error));
}

function isRetryableNativeImageJobError(provider: string, error: unknown): boolean {
  if (provider === "openai") return isRetryableOpenAiImageError(error) || isRetryableNativeValidationError(error);
  return isRetryableAiEchoError(error) || isRetryableNativeValidationError(error);
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause && typeof error.cause === "object" ? error.cause as { code?: string; message?: string } : null;
  return [
    error.message,
    cause?.code,
    cause?.message
  ].filter(Boolean).join("；");
}

function nestedValue(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function nestedString(value: unknown, keys: string[]): string {
  const result = nestedValue(value, keys);
  return typeof result === "string" ? result : "";
}

function createImageJobStartGate(cooldownMs: number): () => Promise<void> {
  let lastStartedAt = 0;
  let chain = Promise.resolve();
  return async () => {
    let release: () => void = () => undefined;
    const previous = chain;
    chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, lastStartedAt + cooldownMs - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      lastStartedAt = Date.now();
    } finally {
      release();
    }
  };
}

interface AdaptiveNativeImageJobOptions<T, R> {
  provider: string;
  items: T[];
  initialConcurrency: number;
  cooldownMs: number;
  label: (item: T) => string;
  mapper: (item: T, index: number, schedulerAttempt: number) => Promise<R>;
  onSettled: (item: T, result: PromiseSettledResult<R>, index: number, attempt: number) => Promise<void> | void;
  onRetry?: (detail: { item: T; index: number; attempt: number; delayMs: number; concurrency: number; backpressure: boolean; error: unknown }) => void;
  onBackpressure?: (detail: { item: T; index: number; concurrency: number; error: unknown }) => void;
}

type NativeProgressStage = "planning" | "generating-main" | "generating-detail" | "recovering" | "quality-review" | "quality-retry" | "packaging" | "complete";

interface NativeGenerationProgress {
  stage: NativeProgressStage;
  message: string;
  total: number;
  completed: number;
  mainCompleted: number;
  detailCompleted: number;
  retries: number;
  backpressureCount: number;
  concurrency: number;
  qualityRetryTotal?: number;
  qualityRetryCompleted?: number;
  nextRetryDelayMs?: number;
  firstPreviewAt?: string;
  firstPreviewElapsedMs?: number;
  updatedAt: string;
}

function createNativeProgress(total: number, mainImages: GeneratedAsset[], detailImages: GeneratedAsset[]): NativeGenerationProgress {
  return {
    stage: mainImages.length ? "generating-detail" : "planning",
    message: "正在准备图片生成任务。",
    total,
    completed: mainImages.length + detailImages.length,
    mainCompleted: mainImages.length,
    detailCompleted: detailImages.length,
    retries: 0,
    backpressureCount: 0,
    concurrency: 0,
    updatedAt: new Date().toISOString()
  };
}

function emitNativeProgress(progress: NativeGenerationProgress): void {
  console.log(`[native-progress] ${JSON.stringify(progress)}`);
}

interface AdaptiveNativeImageQueueItem<T> {
  item: T;
  index: number;
  attempt: number;
  notBefore: number;
}

async function mapAdaptiveNativeImageJobs<T, R>(options: AdaptiveNativeImageJobOptions<T, R>): Promise<void> {
  if (!options.items.length) return;
  const provider = options.provider.toLowerCase();
  const initialConcurrency = Math.max(1, Math.min(options.initialConcurrency, options.items.length));
  const maxAttempts = nativeImageJobMaxAttempts(provider);
  const totalTimeoutMs = nativeImageJobTotalTimeoutMs();
  const deadline = Date.now() + totalTimeoutMs;
  const startGate = createImageJobStartGate(options.cooldownMs);
  const ladder = nativeImageConcurrencyLadder(provider);
  const queue: AdaptiveNativeImageQueueItem<T>[] = options.items.map((item, index) => ({
    item,
    index,
    attempt: 1,
    notBefore: Date.now()
  }));
  const inflight = new Set<Promise<void>>();
  let currentConcurrency = initialConcurrency;
  let settledCount = 0;
  let failedCount = 0;
  let lastBackpressureDowngradeAttempt = 0;

  console.log(
    `[native-image] scheduler start total=${options.items.length} initialConcurrency=${initialConcurrency} ladder=${ladder.join(">")} cooldownMs=${options.cooldownMs} totalTimeoutMs=${totalTimeoutMs}`
  );

  const settleRejected = async (queueItem: AdaptiveNativeImageQueueItem<T>, error: unknown) => {
    const attempts = Math.max(queueItem.attempt, attemptedCountFromError(error));
    failedCount += 1;
    settledCount += 1;
    console.warn(
      `[native-image] failed ${options.label(queueItem.item)} progress=${settledCount}/${options.items.length} attempts=${attempts} reason=${errorMessage(error).slice(0, 220)}`
    );
    await options.onSettled(queueItem.item, {
      status: "rejected",
      reason: attachAttemptCount(error, attempts)
    }, queueItem.index, queueItem.attempt);
  };

  const runQueueItem = async (queueItem: AdaptiveNativeImageQueueItem<T>) => {
    const label = options.label(queueItem.item);
    try {
      await startGate();
      const value = await options.mapper(queueItem.item, queueItem.index, queueItem.attempt);
      settledCount += 1;
      console.log(`[native-image] completed ${label} progress=${settledCount}/${options.items.length} attempt=${queueItem.attempt}`);
      await options.onSettled(queueItem.item, { status: "fulfilled", value }, queueItem.index, queueItem.attempt);
    } catch (error) {
      const retryable = isRetryableNativeImageJobError(provider, error);
      const canRetry = retryable && queueItem.attempt < maxAttempts && Date.now() < deadline;
      if (!canRetry) {
        await settleRejected(queueItem, error);
        return;
      }
      const delayMs = nativeImageJobRetryDelayMs(provider, error, queueItem.attempt);
      if (isNativeImageBackpressureError(provider, error)) {
        if (queueItem.attempt > lastBackpressureDowngradeAttempt) {
          const reducedConcurrency = nextNativeImageBackpressureConcurrency(provider, currentConcurrency);
          lastBackpressureDowngradeAttempt = queueItem.attempt;
          if (currentConcurrency !== reducedConcurrency) {
            console.warn(`[native-image] backpressure detected; concurrency ${currentConcurrency} -> ${reducedConcurrency}`);
          } else {
            console.warn(`[native-image] backpressure detected; concurrency stays at ${currentConcurrency}`);
          }
          currentConcurrency = reducedConcurrency;
          options.onBackpressure?.({
            item: queueItem.item,
            index: queueItem.index,
            concurrency: currentConcurrency,
            error
          });
        }
      }
      console.warn(
        `[native-image] retry ${label} attempt=${queueItem.attempt + 1}/${maxAttempts} concurrency=${currentConcurrency} delayMs=${delayMs} reason=${errorMessage(error).slice(0, 220)}`
      );
      options.onRetry?.({
        item: queueItem.item,
        index: queueItem.index,
        attempt: queueItem.attempt + 1,
        delayMs,
        concurrency: currentConcurrency,
        backpressure: isNativeImageBackpressureError(provider, error),
        error
      });
      queue.push({
        item: queueItem.item,
        index: queueItem.index,
        attempt: queueItem.attempt + 1,
        notBefore: Date.now() + delayMs
      });
    }
  };

  while (queue.length || inflight.size) {
    queue.sort((a, b) => a.notBefore - b.notBefore || a.index - b.index);
    if (queue.length && Date.now() > deadline) {
      const timeoutError = new Error(`生图总时长超过 ${Math.round(totalTimeoutMs / 60_000)} 分钟，已停止等待。`);
      while (queue.length) {
        const queueItem = queue.shift();
        if (queueItem) await settleRejected(queueItem, timeoutError);
      }
      continue;
    }

    while (queue.length && inflight.size < currentConcurrency && queue[0].notBefore <= Date.now()) {
      const queueItem = queue.shift();
      if (!queueItem) break;
      const promise = runQueueItem(queueItem).finally(() => {
        inflight.delete(promise);
      });
      inflight.add(promise);
    }

    if (!queue.length && !inflight.size) break;
    const nextDelayMs = queue.length ? Math.max(0, queue[0].notBefore - Date.now()) : Number.POSITIVE_INFINITY;
    if (inflight.size) {
      const waiters = Array.from(inflight);
      if (Number.isFinite(nextDelayMs)) waiters.push(sleep(Math.min(nextDelayMs, 1_000)));
      await Promise.race(waiters);
    } else if (queue.length) {
      await sleep(Math.min(nextDelayMs, 1_000));
    }
  }
  console.log(`[native-image] scheduler finished total=${options.items.length} success=${settledCount - failedCount} failed=${failedCount}`);
}

export async function mapLimitedSettled<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  onSettled: (item: T, result: PromiseSettledResult<R>, index: number) => Promise<void> | void
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      let result: PromiseSettledResult<R>;
      try {
        result = { status: "fulfilled", value: await mapper(item, index) };
      } catch (reason) {
        result = { status: "rejected", reason };
      }
      await onSettled(item, result, index);
    }
  });
  await Promise.all(workers);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildImageSpecs(task: ProductTask, brand: BrandProfile, analysis: ReferenceAnalysis): ImageSpec[] {
  const points = inferSellingPoints(task, analysis);
  const shared = [
    `商品：${task.productName}`,
    task.targetAudience ? `目标人群：${task.targetAudience}` : "",
    `类目：${task.category}`,
    `品牌定位：${brand.positioning}`,
    `品牌视觉：${brand.visualKeywords.join("、")}`,
    `商品卖点：${promptSellingPoints(task)}`,
    `竞品结构观察：${analysis.visualPatterns.join("；")}`,
    `禁止内容：${[brand.bannedElements, task.bannedElements].filter(Boolean).join("；")}`,
    task.notes ? `特殊要求：${task.notes}` : "",
    "保持输入商品的造型、颜色、材质、比例和关键细节一致。",
    "只生成无字电商摄影底图，不生成任何文字、Logo、水印、平台标识或竞品元素。",
    "为后续本地品牌排版保留清晰留白，真实摄影质感，商业级光影。"
  ].filter(Boolean).join("\n");
  return [
    { index: 1, title: task.productName, subtitle: brand.slogan || brand.positioning, prompt: `${shared}\n生成干净浅色商品主图，商品居中，占画面约 75%，背景简洁。` },
    { index: 2, title: points[0] || "核心卖点", subtitle: points.slice(1, 3).join(" · ") || brand.slogan, prompt: `${shared}\n用高级品牌场景表达第一核心卖点，商品为绝对视觉焦点，右下区域保留排版空间。` },
    { index: 3, title: "自然融入每个使用场景", subtitle: points[1] || brand.positioning, prompt: `${shared}\n生成真实自然的目标用户使用场景，不出现可识别人脸，商品外观必须准确。` },
    { index: 4, title: "细节经得起靠近看", subtitle: points[2] || task.specs, prompt: `${shared}\n生成材质与关键结构特写，表现纹理、工艺和品质，构图克制。` },
    { index: 5, title: "规格清晰 选择简单", subtitle: task.specs, prompt: `${shared}\n生成简洁参数图底图，商品放在左下或中央偏下，上半区与右侧保留大面积留白。` }
  ];
}

function buildDetailSpecs(task: ProductTask, brand: BrandProfile) {
  const points = inferSellingPoints(task, {
    query: "",
    references: [],
    summary: "",
    visualPatterns: [],
    sellingPointPatterns: [],
    detailPagePatterns: []
  });
  const specs = splitList(task.specs);
  return [
    { index: 1, eyebrow: brand.name, title: task.productName, bodyLines: [brand.slogan || brand.positioning] },
    { index: 2, eyebrow: "核心优势", title: "为什么值得选择", bodyLines: points.slice(0, 4) },
    { index: 3, eyebrow: "使用场景", title: "自然融入你的日常", bodyLines: [task.category, brand.positioning].filter(Boolean) },
    { index: 4, eyebrow: "卖点 01", title: points[0] || "核心体验更进一步", bodyLines: points.slice(0, 2) },
    { index: 5, eyebrow: "卖点 02", title: points[1] || points[0] || "细节带来安心体验", bodyLines: points.slice(1, 3) },
    { index: 6, eyebrow: "材质细节", title: "看得见的品质与工艺", bodyLines: [points[2], ...specs.slice(0, 2)].filter(Boolean) },
    { index: 7, eyebrow: "规格参数", title: "产品信息一目了然", bodyLines: specs.slice(0, 5) },
    { index: 8, eyebrow: brand.name, title: brand.slogan || "让好产品成为日常", bodyLines: [brand.positioning] }
  ];
}

function inferSellingPoints(task: ProductTask, analysis: ReferenceAnalysis): string[] {
  const explicit = filterCategoryCompatibleSellingPoints(task, cleanBusinessPhrases(splitList(task.sellingPoints)));
  const context = productContext(task);
  if (explicit.length) {
    return expandSeedSellingPoints(task, analysis, explicit, context);
  }

  const identityText = [
    task.productName,
    task.category,
    task.targetAudience,
    task.referenceKeywords
  ].join(" ");
  const text = [
    identityText,
    task.notes
  ].join(" ");
  const points: string[] = [];
  addUnique(points, filterCategoryCompatibleSellingPoints(task, cleanBusinessPhrases(analysis.sellingPointPatterns.slice(0, 2))));
  addUnique(points, inferCategorySellingPoints(task, context));

  addUnique(points, ["真实场景可感知", "细节清晰可见", "选择信息更明确"]);
  return points.slice(0, 6);
}

function normalizeSellingPointKey(value: string): string {
  return value
    .replace(/^(?:[-*•]\s*|\d+[.)、）]\s*)/, "")
    .replace(/[，。；：、,.!?！？\s]/g, "")
    .toLowerCase();
}

function extractExplicitSellingPoints(task: ProductTask): string[] {
  return filterCategoryCompatibleSellingPoints(task, cleanBusinessPhrases(splitList(task.sellingPoints)))
    .filter((point) => point.length <= 120)
    .filter((point) => !isPlaceholderCopy(point))
    .filter((point) => !/请(?:结合|根据)?.*(?:商品图|产品图|产品名称|用户重点|自行分析|自行补充|自行提炼)/.test(point))
    .slice(0, 12);
}

function storyboardInput(task: ProductTask, points: string[]) {
  const explicitSellingPoints = extractExplicitSellingPoints(task);
  const explicitKeys = new Set(explicitSellingPoints.map(normalizeSellingPointKey));
  const identity = classifyProductIdentity(task);
  return {
    productName: productDisplayName(task, "精选商品"),
    sellingPoints: points,
    explicitSellingPoints,
    derivedSellingPoints: points.filter((point) => !explicitKeys.has(normalizeSellingPointKey(point))),
    isAiRobot: productContext(task).isAiRobot,
    productKind: identity.id,
    isEnglishMarketplace: productContext(task).isEnglishMarketplace,
    generateDetail: task.generateDetail
  };
}

function expandSeedSellingPoints(
  task: ProductTask,
  analysis: ReferenceAnalysis,
  seeds: string[],
  context: ProductContext
): string[] {
  const points: string[] = [];
  // Explicit user points must remain ahead of category defaults so the storyboard cannot silently replace them.
  addUnique(points, seeds);
  if (context.isAiRobot) {
    addUnique(points, expandAiRobotSeeds(seeds));
  } else if (context.isIntimateApparel) {
    addUnique(points, expandIntimateApparelSeeds(seeds));
  } else if (context.isKitchenTextile) {
    addUnique(points, expandKitchenTextileSeeds(seeds));
  } else if (context.isSkincare) {
    addUnique(points, expandSkincareSeeds(seeds));
  } else if (context.isChildProduct && context.isCup) {
    addUnique(points, expandChildCupSeeds(seeds));
  } else if (context.isCup) {
    addUnique(points, expandCupSeeds(seeds));
  } else if (context.isStudentBackpack) {
    addUnique(points, expandStudentBackpackSeeds(seeds));
  } else if (context.isBabyCare) {
    addUnique(points, expandBabyCareSeeds(seeds));
  } else if (context.isCuttingBoard) {
    addUnique(points, expandCuttingBoardSeeds(seeds));
  } else if (context.isMagneticLifter) {
    addUnique(points, expandMagneticLifterSeeds(seeds));
  } else if (context.isTissue) {
    addUnique(points, expandTissueSeeds(seeds));
  } else if (context.isPortableFan) {
    addUnique(points, expandPortableFanSeeds(seeds));
  } else if (context.isPillow) {
    addUnique(points, expandPillowSeeds(seeds));
  } else if (context.isLaundryDetergent) {
    addUnique(points, expandLaundryDetergentSeeds(seeds));
  } else if (context.isSneaker) {
    addUnique(points, expandSneakerSeeds(seeds));
  } else if (context.isPants) {
    addUnique(points, expandPantsSeeds(seeds));
  } else if (context.isApparel) {
    addUnique(points, expandApparelSeeds(seeds));
  } else {
    addUnique(points, seeds);
  }
  addUnique(points, filterCategoryCompatibleSellingPoints(task, cleanBusinessPhrases(analysis.sellingPointPatterns.slice(0, 2))));
  if (context.isIntimateApparel) {
    addUnique(points, ["杯型轮廓更自然", "肩带下围细节清楚", "适合日常内搭"]);
  }
  if (context.isKitchenTextile) {
    addUnique(points, ["台面水渍随手擦", "多色分区更好认", "挂放收纳更顺手"]);
  }
  if (context.isSkincare) {
    addUnique(points, ["水润质地看得见", "真人上脸更直观", "黑银包装更有品质感"]);
  }
  if (context.isChildProduct && context.isCup) {
    addUnique(points, ["可爱萌趣孩子爱用", "耐热饮用更安心", "环保材质更放心", "双把手小手好握"]);
  }
  if (context.isPortableFan) {
    addUnique(points, ["小巧出门好携带", "户外随手吹清凉", "充电补能更方便", "高颜值萌趣外观"]);
  }
  if (context.isPillow) {
    addUnique(points, ["柔软睡感更舒服", "颈部承托更贴合", "透气孔细节清楚", "卧室睡眠场景更有代入感"]);
  }
  if (context.isLaundryDetergent) {
    addUnique(points, ["温和洗护不刺激", "清洁力强更省心", "洗后淡淡花香", "室内洗衣场景更真实"]);
  }
  if (context.isSneaker) {
    addUnique(points, ["高颜值日常好搭", "脚感舒适更轻松", "鞋面透气更清爽", "户外穿搭更有型"]);
  }
  if (context.isPants) {
    addUnique(points, ["宽松版型不拘束", "垂顺裤型修饰腿型", "腰头抽绳细节清楚", "两色日常好搭", "居家通勤都能穿"]);
  } else if (context.isApparel) {
    addUnique(points, ["版型轮廓更清楚", "面料质感看得见", "日常穿搭更省心", "衣橱搭配更好理解"]);
  }
  if (context.isStudentBackpack) {
    addUnique(points, ["轻便肩负上学更轻松", "外观颜值更高", "分区收纳课本更清楚", "肩带前袋细节清楚"]);
  }
  if (context.isBabyCare) {
    addUnique(points, ["温和触感更安心", "吸收表现看得见", "父母日常护理更省心", "育儿台收纳更清楚"]);
  }
  if (context.isCuttingBoard) {
    addUnique(points, ["乌檀木质感看得见", "高硬度日常切配更稳", "冲洗方便更省心", "抗菌率99.9%"]);
  }
  if (context.isMagneticLifter) {
    addUnique(points, ["3倍吸力吊装更稳", "无需用电现场更省心", "多种起重场景适用", "钢板搬运更直接"]);
  }
  if (context.isTissue) {
    addUnique(points, ["原生木浆更安心", "柔软触感不粗糙", "抽取顺手不费劲", "家庭日常清洁更省心"]);
  }
  if (context.isAiRobot) {
    addUnique(points, ["萌趣桌面潮玩摆件", "多语言与方言互动", "趣味语音交互", "讲故事与成语接龙", "学习答疑", "玩法丰富", "孩子贴心玩伴", "联网智能聊天", "长续航", "多关节可动", "LED表情屏互动"]);
  }
  if (context.isCup) {
    addUnique(points, inferCupNoteSellingPoints(task));
  }
  addUnique(points, inferCategorySellingPoints(task, context));
  return points.slice(0, 12);
}

function expandAiRobotSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/外观|造型|颜值|萌|可爱|黄色|黑银|潮玩|摆件/.test(text)) {
    addUnique(points, ["萌趣机器人造型", "黄黑银撞色更吸睛", "桌面摆件也好看"]);
  }
  if (/关节|手臂|腿部|姿势|可动|把玩|互动/.test(text)) {
    addUnique(points, ["可动关节更好玩", "姿态随手摆出互动感"]);
  }
  if (/LED|表情|屏|灯光|情绪|科幻/.test(text)) {
    addUnique(points, ["LED表情互动更生动", "蓝色表情屏更有科技感"]);
  }
  if (/AI|模型|豆包|DeepSeek|对话|聊天|讲故事|问答/.test(text)) {
    addUnique(points, ["趣味语音交互", "联网智能聊天"]);
  }
  if (/多语言|方言|双语|中文|英文|英语|日语|粤语|闽南语|语言/.test(text)) {
    addUnique(points, ["多语言与方言互动", "语言课堂互动场景"]);
  }
  if (/早教|学习|知识|百科|英语|国学|儿歌|故事|答疑/.test(text)) {
    addUnique(points, ["学习答疑", "讲故事与成语接龙"]);
  }
  if (/玩法丰富|玩法|游戏|跳舞/.test(text)) {
    addUnique(points, ["玩法丰富", "多种互动姿态"]);
  }
  if (/陪伴|情感|角色|声音|昵称|记住|懂你/.test(text)) {
    addUnique(points, ["越聊越懂的陪伴感", "孩子开口更轻松"]);
  }
  if (/WiFi|联网|APP|智能聊天/.test(text)) {
    addUnique(points, ["联网智能聊天"]);
  }
  if (/续航|电池|电量/.test(text)) {
    addUnique(points, ["长续航"]);
  }
  if (/安全|环保|无尖锐|低龄|材质|省心/.test(text)) {
    addUnique(points, ["圆润机身更适合孩子", "家长选择更省心"]);
  }
  if (/礼物|桌面|办公|家庭|亲子|高性价比/.test(text)) {
    addUnique(points, ["亲子学习桌上就能陪", "送礼桌搭都合适"]);
  }
  addUnique(points, seeds);
  return points;
}

function expandMagneticLifterSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/3倍|吸力|磁力|强力|吸附|稳/.test(text)) {
    addUnique(points, ["3倍吸力吊装更稳"]);
  }
  if (/无需用电|不用电|免电|无电|永磁/.test(text)) {
    addUnique(points, ["无需用电现场更省心"]);
  }
  if (/各种|多种|起重|吊装|搬运|户外|工地|车间|钢板|钢材/.test(text)) {
    addUnique(points, ["多种起重场景适用", "钢板搬运更直接"]);
  }
  addUnique(points, seeds);
  return points;
}

function expandTissueSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/环保|材质|木浆|原生|纤维|纸浆/.test(text)) {
    addUnique(points, ["原生木浆更安心", "日常接触更放心"]);
  }
  if (/无异味|异味|气味|无味/.test(text)) {
    addUnique(points, ["抽取无异味", "擦拭入口也安心"]);
  }
  if (/柔软|亲肤|细腻|不粗糙|舒服/.test(text)) {
    addUnique(points, ["柔软触感不粗糙", "轻擦也舒服"]);
  }
  if (/家庭|主妇|家用|客厅|餐桌|厨房|使用|纸巾/.test(text)) {
    addUnique(points, ["家庭日常清洁更省心", "餐桌客厅随手可取", "抽取顺手不费劲"]);
  }
  addUnique(points, seeds.map((seed) => seed
    .replace(/^环保材质$/g, "原生木浆更安心")
    .replace(/^无异味$/g, "抽取无异味")
    .replace(/^柔软$/g, "柔软触感不粗糙")
  ));
  return points;
}

function expandCuttingBoardSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/乌檀|木|木纹|材质/.test(text)) {
    addUnique(points, ["乌檀木质感看得见", "木纹细节更有品质感"]);
  }
  if (/高硬度|硬度|耐切|不易/.test(text)) {
    addUnique(points, ["高硬度日常切配更稳"]);
  }
  if (/冲洗|好洗|易洗|清洗|方便/.test(text)) {
    addUnique(points, ["冲洗方便更省心"]);
  }
  if (/抗菌|99\\.9|99.9/.test(text)) {
    addUnique(points, ["抗菌率99.9%"]);
  }
  addUnique(points, seeds);
  return points;
}

function expandBabyCareSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/温和|刺激|不刺激|柔软|亲肤/.test(text)) {
    addUnique(points, ["温和触感更安心", "柔软接触少负担"]);
  }
  if (/吸水|吸收|干爽|尿湿/.test(text)) {
    addUnique(points, ["吸收表现看得见", "日常护理更省心"]);
  }
  if (/宝妈|妈妈|父母|婴儿|宝宝|带娃|护理/.test(text)) {
    addUnique(points, ["父母日常护理更省心", "育儿台收纳更清楚"]);
  }
  addUnique(points, seeds.map((seed) => seed
    .replace(/温和不刺激皮肤/g, "温和触感更安心")
    .replace(/不刺激皮肤/g, "触感更温和")
    .replace(/吸水性强/g, "吸收表现看得见")
  ));
  return points;
}

function expandPillowSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/舒适|舒服|睡|柔软|棉花/.test(text)) {
    addUnique(points, ["柔软睡感更舒服", "像云感一样轻柔贴合", "卧室睡眠场景更有代入感"]);
  }
  if (/支撑|脖子|颈|承托/.test(text)) {
    addUnique(points, ["颈部承托更贴合", "仰睡侧睡都更放松"]);
  }
  if (/透气|孔|清爽|闷/.test(text)) {
    addUnique(points, ["透气孔细节清楚", "整夜睡感更清爽"]);
  }
  if (/室内|卧室|睡眠|床/.test(text)) {
    addUnique(points, ["卧室睡眠场景更有代入感"]);
  }
  addUnique(points, seeds.map((seed) => seed.replace(/失眠/g, "睡前放松")));
  return points;
}

function expandLaundryDetergentSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/温和|刺激|不刺激|亲肤/.test(text)) {
    addUnique(points, ["温和洗护不刺激"]);
  }
  if (/清洁|干净|污|洗净|强/.test(text)) {
    addUnique(points, ["清洁力强更省心", "日常污渍洗得更干净"]);
  }
  if (/香|留香|花香|玫瑰|蔷薇/.test(text)) {
    addUnique(points, ["洗后淡淡花香", "蔷薇花香更好闻"]);
  }
  if (/室内|洗衣|家庭|家务/.test(text)) {
    addUnique(points, ["室内洗衣场景更真实"]);
  }
  addUnique(points, seeds);
  return points;
}

function expandSneakerSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/颜值|好看|高颜值|穿搭|男生/.test(text)) {
    addUnique(points, ["高颜值日常好搭", "户外穿搭更有型", "男生日常穿搭更有型"]);
  }
  if (/舒适|舒服|脚感|轻松/.test(text)) {
    addUnique(points, ["脚感舒适更轻松"]);
  }
  if (/透气|清爽|鞋面/.test(text)) {
    addUnique(points, ["鞋面透气更清爽"]);
  }
  if (/户外|出街|通勤|日常/.test(text)) {
    addUnique(points, ["户外日常都好搭"]);
  }
  addUnique(points, seeds);
  return points;
}

function expandPantsSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/宽松|阔腿|版型|显瘦|腿型|不勒|不拘束|松紧/.test(text)) {
    addUnique(points, ["宽松版型不拘束", "垂顺裤型修饰腿型"]);
  }
  if (/垂感|垂顺|面料|软|柔软|针织|毛呢|雪尼尔|质感/.test(text)) {
    addUnique(points, ["垂感面料看得见", "软糯纹理有质感"]);
  }
  if (/腰|抽绳|松紧|裤脚|走线|细节|口袋/.test(text)) {
    addUnique(points, ["腰头抽绳细节清楚", "裤脚走线看得见"]);
  }
  if (/两色|双色|灰|黑|颜色|百搭|好搭|搭配/.test(text)) {
    addUnique(points, ["两色日常好搭", "衣橱搭配更省心"]);
  }
  if (/居家|通勤|出门|日常|咖啡|逛街|穿搭/.test(text)) {
    addUnique(points, ["居家通勤都能穿"]);
  }
  addUnique(points, seeds.map((seed) => seed
    .replace(/质量好/g, "做工细节看得见")
    .replace(/穿着舒服/g, "日常穿着更自在")
    .replace(/百搭/g, "日常好搭不费心")
  ));
  return points;
}

function expandApparelSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/版型|轮廓|显瘦|修身|宽松|合身/.test(text)) {
    addUnique(points, ["版型轮廓更清楚"]);
  }
  if (/面料|材质|质感|柔软|棉|针织|纹理/.test(text)) {
    addUnique(points, ["面料质感看得见"]);
  }
  if (/穿搭|百搭|搭配|日常|通勤|居家/.test(text)) {
    addUnique(points, ["日常穿搭更省心", "衣橱搭配更好理解"]);
  }
  if (/细节|走线|纽扣|领口|袖口|腰头/.test(text)) {
    addUnique(points, ["做工细节看得见"]);
  }
  addUnique(points, seeds);
  return points;
}

function expandChildCupSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/可爱|萌|萌趣|图案|卡通|喜欢|颜值/.test(text)) {
    addUnique(points, ["可爱萌趣孩子爱用", "卡通图案更有记忆点"]);
  }
  if (/耐高温|高温|耐热|热水/.test(text)) {
    addUnique(points, ["耐热饮用更安心"]);
  }
  if (/环保|材料|材质/.test(text)) {
    addUnique(points, ["环保材质更放心"]);
  }
  if (/儿童|孩子|小朋友|妈妈|家庭|上学|书包|餐桌/.test(text)) {
    addUnique(points, ["儿童日常喝水更省心", "家里上学都适合"]);
  }
  addUnique(points, seeds);
  return points;
}

function expandCupSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/颜值|好看|高颜值|潮流|设计|图案|出片/.test(text)) {
    addUnique(points, ["高颜值杯身更出片", "杯身图案更有记忆点"]);
  }
  if (/环保|材质|材料|PPSU|异味|无异味|放心/.test(text)) {
    addUnique(points, ["环保材质更放心", "日常喝水无异味"]);
  }
  if (/隔热|不烫|烫手|热水|握持/.test(text)) {
    addUnique(points, ["隔热握持不烫手", "打开饮用更安心"]);
  }
  if (/户外|出门|随身|携带|通勤|挂环|挂带|顺手/.test(text)) {
    addUnique(points, ["户外随手喝更方便", "握持携带更顺手"]);
  }
  addUnique(points, seeds.map((seed) => seed
    .replace(/^颜值高$/g, "高颜值杯身更出片")
    .replace(/^环保材质$/g, "环保材质更放心")
    .replace(/^无异味$/g, "日常喝水无异味")
    .replace(/^隔热不烫手$/g, "隔热握持不烫手")
  ));
  return points;
}

function inferCupNoteSellingPoints(task: ProductTask): string[] {
  const text = [task.notes, task.referenceKeywords, task.targetAudience].join(" ");
  const points: string[] = [];
  if (/户外|出门|随身|携带|通勤|露营|咖啡|公园/.test(text)) {
    addUnique(points, ["户外随手喝更方便", "出门携带更顺手"]);
  }
  if (/喝水|饮水|吸管|直饮|打开/.test(text)) {
    addUnique(points, ["打开饮用更顺畅"]);
  }
  return points;
}

function expandStudentBackpackSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/轻便|轻|肩负|背负|肩带|背着|舒服|轻松/.test(text)) {
    addUnique(points, ["轻便肩负上学更轻松", "肩带贴合肩背"]);
  }
  if (/颜值|好看|星|印花|外观|可爱|搭配/.test(text)) {
    addUnique(points, ["外观颜值更高", "上学日常更好搭"]);
  }
  if (/质量|做工|细节|耐用|结实|品质/.test(text)) {
    addUnique(points, ["做工细节看得见", "肩带前袋细节清楚"]);
  }
  if (/收纳|分区|课本|书本|水杯|侧袋|前袋|小包|挂包/.test(text)) {
    addUnique(points, ["分区收纳课本更清楚", "前袋侧袋拿取更顺手"]);
  }
  if (/上学|校园|学生|孩子|书包/.test(text)) {
    addUnique(points, ["上学场景更有代入感"]);
  }
  addUnique(points, seeds.map((seed) => seed
    .replace(/质量好/g, "做工细节看得见")
    .replace(/轻便肩负/g, "轻便肩负上学更轻松")
    .replace(/颜值高/g, "外观颜值更高")
  ));
  return points;
}

function expandPortableFanSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/小|便携|携带|口袋|包|手持|出门/.test(text)) {
    addUnique(points, ["小巧出门好携带", "包里一放不占地"]);
  }
  if (/持续|续航|1个小时|1小时|一小时|吹风|风/.test(text)) {
    addUnique(points, ["可持续吹风约1小时", "户外随手吹清凉"]);
  }
  if (/充电|充点|快充|快|补能/.test(text)) {
    addUnique(points, ["充电补能更方便"]);
  }
  if (/颜值|好看|可爱|萌|外观|猫|爱心/.test(text)) {
    addUnique(points, ["高颜值萌趣外观"]);
  }
  addUnique(points, seeds.map((seed) => seed.replace(/充点/g, "充电")));
  return points;
}

function expandSkincareSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/温和|不刺激|刺激|舒缓|安心/.test(text)) {
    addUnique(points, ["温和不刺激", "日常护肤少负担"]);
  }
  if (/保湿|补水|水润|滋润|干/.test(text)) {
    addUnique(points, ["水润保湿感", "干燥时更需要"]);
  }
  if (/高端|品质|高级|质感|黑|银|包装/.test(text)) {
    addUnique(points, ["黑银高级瓶身", "高端品质感"]);
  }
  if (/模特|露脸|上脸|真人|女生|女性/.test(text)) {
    addUnique(points, ["真人上脸更直观", "自然透亮好状态"]);
  }
  addUnique(points, seeds);
  return points;
}

function expandKitchenTextileSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/擦|猜|清洁|干净|污|水渍|油渍/.test(text)) {
    addUnique(points, ["轻轻一擦就干净", "台面水渍随手擦"]);
  }
  if (/好洗|易洗|清洗|冲洗|洗/.test(text)) {
    addUnique(points, ["一冲一洗更省心"]);
  }
  if (/多色|颜色|彩色|可选|区分/.test(text)) {
    addUnique(points, ["多色可选好区分"]);
  }
  if (/毛巾|绒|柔软|吸水|擦手/.test(text)) {
    addUnique(points, ["细密绒感看得见"]);
  }
  addUnique(points, seeds.map((seed) => seed.replace(/轻轻一猜/g, "轻轻一擦").replace(/一猜/g, "一擦")));
  return points;
}

function expandIntimateApparelSeeds(seeds: string[]): string[] {
  const text = seeds.join(" ");
  const points: string[] = [];
  if (/性感|红|气色|好看/.test(text)) {
    addUnique(points, ["优雅红色好气色"]);
  }
  if (/纯棉|棉|材料|材质|面料/.test(text)) {
    addUnique(points, ["棉感纹理看得见"]);
  }
  if (/轻松|舒服|舒适|自在|不紧|不勒/.test(text)) {
    addUnique(points, ["轻松贴身不紧绷"]);
  }
  if (/模特|上身|实穿|真人|穿着/.test(text)) {
    addUnique(points, ["成年模特实穿证明"]);
  }
  if (/性感|红|气色|好看/.test(text)) {
    addUnique(points, ["成熟女性也能穿得有状态"]);
  }
  if (/纯棉|棉|材料|材质|面料/.test(text)) {
    addUnique(points, ["贴身日常更安心"]);
  }
  if (/轻松|舒服|舒适|自在|不紧|不勒/.test(text)) {
    addUnique(points, ["日常穿着更自在"]);
  }
  if (/模特|上身|实穿|真人|穿着/.test(text)) {
    addUnique(points, ["上身轮廓更直观"]);
  }
  addUnique(points, seeds);
  return points;
}

function inferCategorySellingPoints(task: ProductTask, context: ProductContext): string[] {
  const identityText = [
    task.productName,
    task.category,
    task.targetAudience,
    task.referenceKeywords
  ].join(" ");
  const text = [
    identityText,
    task.notes
  ].join(" ");
  const points: string[] = [];

  if (context.isAiRobot) {
    addUnique(points, [
      "萌趣机器人造型",
      "多模型AI对话陪伴",
      "早教学习随口问",
      "LED表情互动更生动",
      "可动关节更好玩",
      "亲子学习桌上就能陪",
      "送礼桌搭都合适"
    ]);
  }

  if (context.isCup) {
    if (/(电子|智能|温显|温度|数显)/.test(text)) {
      addUnique(points, ["温度显示更直观", "喝前看一眼水温"]);
    }
    if ((context.isChildProduct || /学生|上学|课桌|书包|儿童|孩子/.test(text)) && !/(年轻人|通勤|潮流|户外|咖啡|露营)/.test(text)) {
      addUnique(points, ["上学日常带着走", "课桌书包都适合", "孩子自己也好识别"]);
    }
    if (context.isChildProduct && !context.isTemperatureDisplay) {
      addUnique(points, ["可爱萌趣孩子爱用", "耐热饮用更安心", "环保材质更放心", "双把手小手好握", "家里上学都适合"]);
    }
    if (/颜值|好看|潮流|设计|图案/.test(text)) {
      addUnique(points, ["高颜值杯身更出片", "杯身图案更有记忆点"]);
    }
    if (/环保|材质|PPSU|无异味|异味/.test(text)) {
      addUnique(points, ["环保材质更放心", "日常喝水无异味"]);
    }
    if (/隔热|不烫|烫手|热水/.test(text)) {
      addUnique(points, ["隔热握持不烫手", "打开饮用更安心"]);
    }
    addUnique(points, ["日常饮水更方便", "杯身图案更有记忆点", "握持携带更顺手"]);
  }
  if (context.isSneaker) {
    addUnique(points, ["高颜值日常好搭", "脚感舒适更轻松", "鞋面透气更清爽", "户外穿搭更有型"]);
  } else if (context.isFootwear) {
    addUnique(points, ["宽口好穿", "居家走动更轻松", "按实际脚长选择尺码"]);
  }
  if (context.isPants) {
    addUnique(points, ["宽松版型不拘束", "垂顺裤型修饰腿型", "垂感面料看得见", "腰头抽绳细节清楚", "两色日常好搭", "居家通勤都能穿"]);
  } else if (context.isApparel) {
    addUnique(points, ["版型轮廓更清楚", "面料质感看得见", "日常穿搭更省心", "衣橱搭配更好理解"]);
  }
  if (context.isChildProduct) {
    addUnique(points, ["适合儿童日常使用", "童趣外观更有记忆点"]);
  }
  if (context.isStudentBackpack || /(学生双肩背包|学生书包|双肩背包|书包)/.test(text)) {
    addUnique(points, ["轻便肩负上学更轻松", "外观颜值更高", "分区收纳课本更清楚", "做工细节看得见", "上学场景更有代入感"]);
  }
  if (context.isBikeBasket) {
    addUnique(points, ["防水收纳更安心", "头盔雨具都好放", "固定结构更稳", "通勤买菜随手装", "日常骑行更省心"]);
  }
  if (/(收纳|置物|整理|盒|架|柜)/.test(text)) {
    addUnique(points, ["分类收纳更清楚", "日常取放更顺手", "空间更整洁"]);
  }
  if (/(包|背包|通勤|旅行|收纳包)/.test(text)) {
    addUnique(points, ["出门携带更从容", "分区放置更清楚", "通勤出行都适合"]);
  }
  if (/(衣|裤|裙|服|穿搭|内衣|袜)/.test(text) && !context.isPants && !context.isApparel) {
    addUnique(points, ["日常穿搭更省心", "版型细节清晰", "多场景好搭配"]);
  }
  if (context.isIntimateApparel) {
    addUnique(points, ["优雅红色更有记忆点", "棉感材质看得见", "穿着轻松不紧绷", "杯型轮廓更自然", "肩带调节更方便"]);
  }
  if (context.isKitchenTextile) {
    addUnique(points, ["厨房擦拭更顺手", "台面水渍随手擦", "一冲一洗更省心", "多色分区更好认", "细密绒感看得见"]);
  }
  if (context.isSkincare) {
    addUnique(points, ["温和保湿", "水润质地看得见", "上脸肤感更直观", "高端包装有质感", "日常早晚护肤都适合"]);
  }
  if (context.isPortableFan || /(风扇|小风扇|手持风扇|随身风扇|电风扇)/.test(text)) {
    addUnique(points, ["小巧出门好携带", "户外随手吹清凉", "可持续吹风约1小时", "充电补能更方便", "高颜值萌趣外观"]);
  }
  if (context.isBabyCare || /(尿布湿|尿不湿|纸尿裤|拉拉裤|婴儿尿裤)/.test(text)) {
    addUnique(points, ["温和触感更安心", "吸收表现看得见", "父母日常护理更省心", "育儿台收纳更清楚"]);
  }
  if (context.isCuttingBoard || /(菜板|砧板|切菜板|案板|乌檀木)/.test(text)) {
    addUnique(points, ["乌檀木质感看得见", "高硬度日常切配更稳", "冲洗方便更省心", "抗菌率99.9%"]);
  }
  if (context.isMagneticLifter || /(永磁起重机|永磁起重器|磁力吊|永磁吊|磁力起重|起重磁铁)/.test(text)) {
    addUnique(points, ["3倍吸力吊装更稳", "无需用电现场更省心", "多种起重场景适用", "钢板搬运更直接"]);
  }
  if (context.isTissue || /(抽纸巾|抽纸|面巾纸|纸巾|纸抽|盒抽|软抽)/.test(text)) {
    addUnique(points, ["原生木浆更安心", "抽取无异味", "柔软触感不粗糙", "家庭日常清洁更省心", "餐桌客厅随手可取"]);
  }
  if (context.isPillow || /(枕头|睡眠枕|护颈枕|枕芯)/.test(text)) {
    addUnique(points, ["柔软睡感更舒服", "颈部承托更贴合", "透气孔细节清楚", "卧室睡眠场景更有代入感"]);
  }
  if (context.isLaundryDetergent || /(洗衣液|衣物洗护|衣物清洁)/.test(text)) {
    addUnique(points, ["温和洗护不刺激", "清洁力强更省心", "洗后淡淡花香", "室内洗衣场景更真实"]);
  }
  if (/(美妆|护肤|面霜|精华|口红|粉底|洗护)/.test(text)) {
    addUnique(points, ["使用步骤更简单", "质地观感清晰", "包装细节有质感"]);
  }
  if (/(食品|零食|茶|咖啡|饮品|坚果|水果)/.test(text)) {
    addUnique(points, ["日常享用更方便", "口味信息清晰", "包装看得见"]);
  }
  if (/(月饼|中秋|礼盒|送礼|团圆)/.test(text)) {
    addUnique(points, ["高端礼盒更体面", "中秋送礼更合适", "一家人分享更有仪式感"]);
  }
  if (/(蟑螂|杀蟑|灭蟑|蟑螂药|虫害)/.test(text)) {
    addUnique(points, ["灭蟑需求更直接", "家庭角落都能放", "按说明使用更安心"]);
  }
  return points;
}

function buildGenericCopyPlan(task: ProductTask, points: string[], specs: string[]): GenericCopyPlan {
  const context = productContext(task);
  if (context.isEnglishMarketplace) {
    return buildEnglishMarketplaceCopyPlan(task, points, specs, context);
  }
  if (context.isAiRobot) {
    return buildAiRobotCopyPlan(task, points);
  }
  const targetAudience = usefulTargetAudience(task);
  const identityText = [
    task.productName,
    task.category,
    targetAudience,
    task.sellingPoints,
    task.notes
  ].join(" ");
  if (/(月饼|中秋|礼盒|送礼|团圆)/.test(identityText)) {
    return buildMooncakeGiftCopyPlan(task, points);
  }
  if (/(袜|袜子|短袜|船袜|女袜)/.test(identityText)) {
    return buildSocksCopyPlan(task, points);
  }
  if (/(蟑螂|杀蟑|灭蟑|蟑螂药|虫害)/.test(identityText)) {
    return buildPestControlCopyPlan(task, points);
  }
  if (/(风扇|小风扇|手持风扇|随身风扇|电风扇|迷你风扇)/.test(identityText)) {
    return buildPortableFanCopyPlan(task, points);
  }
  if (context.isBabyCare) {
    return buildBabyCareCopyPlan(task, points);
  }
  if (context.isCuttingBoard) {
    return buildCuttingBoardCopyPlan(task, points);
  }
  if (context.isMagneticLifter) {
    return buildMagneticLifterCopyPlan(task, points);
  }
  if (context.isTissue) {
    return buildTissueCopyPlan(task, points);
  }
  if (/垃圾袋|trash bag/i.test(identityText)) {
    return buildTrashBagCopyPlan(task, points);
  }
  if (context.isBikeBasket) {
    return buildBikeBasketCopyPlan(task, points);
  }
  if (context.isStudentBackpack) {
    return buildStudentBackpackCopyPlan(task, points);
  }
  if (context.isChildProduct && context.isCup && !context.isTemperatureDisplay) {
    return buildChildCupCopyPlan(task, points);
  }
  if (context.isCup) {
    return buildCupCopyPlan(task, points);
  }
  if (context.isPillow) {
    return buildPillowCopyPlan(task, points);
  }
  if (context.isLaundryDetergent) {
    return buildLaundryDetergentCopyPlan(task, points);
  }
  if (context.isSneaker) {
    return buildSneakerCopyPlan(task, points);
  }
  if (context.isPants) {
    return buildPantsCopyPlan(task, points);
  }
  if (context.isApparel) {
    return buildApparelCopyPlan(task, points);
  }
  return buildDefaultGenericCopyPlan(task, points, specs, context);
}

function buildAiRobotCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "AI机器人");
  const select = (pattern: RegExp, fallback: string) => pickPoint(points, pattern, fallback);
  const desktopPoint = select(/潮玩|摆件|桌面|颜值|造型|外观/, "潮玩桌面摆件");
  const languagePoint = select(/多语言|方言|双语|中文|英文|英语|日语|粤语|闽南语|语言/, "多语言与方言互动");
  const storyPoint = select(/讲故事|故事|成语接龙|成语|儿歌/, "讲故事与成语接龙");
  const voicePoint = select(/趣味语音|语音|对话|问答|唤醒|多模型|模型/, "趣味语音交互");
  const learningPoint = select(/学习答疑|学习|答疑|早教|百科|课本/, "学习答疑");
  const jointPoint = select(/多关节|关节|可动|动作|姿势/, "多关节可动");
  const playPoint = select(/玩法丰富|玩法|游戏|跳舞/, "玩法丰富");
  const childPoint = select(/孩子|玩伴|陪伴|亲子/, "孩子贴心玩伴");
  const onlinePoint = select(/联网|WiFi|智能聊天|云端|网络/, "联网智能聊天");
  const batteryPoint = select(/长续航|续航|电池|电量/, "长续航");
  const screenPoint = select(/LED|表情|屏幕|科技/, "LED表情屏互动");
  return {
    primaryPoint: desktopPoint,
    secondaryPoint: languagePoint,
    tertiaryPoint: voicePoint,
    detailFocus: screenPoint,
    main: [
      [productName, desktopPoint, "萌趣桌面AI玩伴"],
      [languagePoint, "中文、English与方言语言卡", "机器人作为课堂小老师"],
      [storyPoint, "绘本、成语卡和亲子阅读", "故事互动不只靠文字"],
      [jointPoint, "抬手、弯腿、转身都不同", screenPoint],
      [batteryPoint, "电池能量图与全天时间线", "不编造具体续航数字"]
    ],
    detail: [
      [voicePoint, "麦克风、声波和回应表情", "开口就有互动"],
      [onlinePoint, "云端节点与聊天关系图", "机器人作为连接终端"],
      [learningPoint, "课本、问题卡和提问动作", "学习答疑更具体"],
      [childPoint, "亲子阅读和家庭陪伴", "孩子愿意主动交流"],
      [playPoint, "游戏板、动作轨迹和多种姿态", "聊天学习游戏都能参与"],
      [screenPoint, "蓝色LED表情与银色耳机细节", "屏幕表情更有生命感"],
      [jointPoint, "正侧背与关节局部多角度", "同一主体不同形态"],
      [desktopPoint, "书桌、展示架和礼物尺度", "摆件与陪伴自然融入日常"]
    ]
  };
}

function buildEnglishMarketplaceCopyPlan(
  task: ProductTask,
  points: string[],
  specs: string[],
  context: ProductContext
): GenericCopyPlan {
  const productName = englishProductLabel(task, context);
  const category = englishCategoryLabel(task, context);
  const pointBank = englishVisibleSellingPoints(task, points, context);
  const primaryPoint = pointBank[0];
  const secondaryPoint = pointBank[1];
  const tertiaryPoint = pointBank[2];
  const quaternaryPoint = pointBank[3];
  const targetScene = targetSceneLabel(task, context);
  const detailFocus = productDetailFocus(task, context);
  const specCopy = usefulSpecCopy(specs, context);
  const everydayUseLabel = context.isSneaker || context.isFootwear || context.isApparel || context.isPants
    ? "Everyday Wear"
    : "Everyday Use";
  const realLifeUseLabel = context.isSneaker || context.isFootwear || context.isApparel || context.isPants
    ? "Real-Life Wear"
    : "Real-Life Use";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, category],
      [primaryPoint, secondaryPoint, "Feature In Action"],
      [targetScene, tertiaryPoint, everydayUseLabel],
      [`${detailFocus} Details`, secondaryPoint, "Close-Up View"],
      specCopy
        ? ["Key Details", specCopy, productName]
        : ["Ready For Daily Use", quaternaryPoint, primaryPoint]
    ],
    detail: [
      [primaryPoint, secondaryPoint, productName],
      ["Before You Buy", secondaryPoint, primaryPoint],
      [primaryPoint, "Detail Close-Up", secondaryPoint],
      [targetScene, tertiaryPoint, realLifeUseLabel],
      [`${detailFocus} Close-Up`, secondaryPoint, "Close-Up Quality"],
      specCopy
        ? ["Key Information", specCopy, tertiaryPoint]
        : [`${category} Made Clear`, primaryPoint, quaternaryPoint],
      ["Why Choose It", tertiaryPoint, "Clear Use Benefits"],
      ["Ready For Daily Use", primaryPoint, productName]
    ]
  };
}

function englishProductLabel(task: ProductTask, context: ProductContext): string {
  const text = [task.visibleProductName, task.productName, task.category, task.sellingPoints, task.notes].join(" ");
  const candidates = [
    task.visibleProductName,
    firstEnglishVisibleLine([task.productName]),
    context.isSneaker || context.isFootwear || isEnglishFootwearText(text) ? "Breathable Walking Shoes" : "",
    context.isAiRobot ? "AI Companion Robot" : "",
    context.isUmbrella ? "Folding Umbrella" : "",
    context.isBikeBasket ? "Waterproof E-Bike Basket" : "",
    context.isCup ? "Everyday Water Bottle" : "",
    context.isApparel ? "Everyday Apparel" : "",
    task.category,
    "Featured Product"
  ];
  return firstEnglishVisibleLine(candidates) || "Featured Product";
}

function productDisplayName(task: ProductTask, fallback: string): string {
  const preferred = (task.visibleProductName || "").trim();
  if (preferred) return preferred;
  const original = (task.productName || "").trim();
  const languageText = [
    task.outputLanguage,
    task.languageRuleName,
    task.languageRuleText,
    task.generationRuleText
  ].join(" ");
  if (isEnglishMarketplaceTaskText(languageText)) {
    return firstEnglishVisibleLine([original]) || englishProductLabel(task, productContext(task));
  }
  if (original && !/^[A-Za-z0-9\s.,'&+/-]+$/.test(original)) return original;
  return fallback;
}

function englishCategoryLabel(task: ProductTask, context: ProductContext): string {
  const category = firstEnglishVisibleLine([task.category]);
  if (category && !/consumer product|not provided/i.test(category)) return category;
  if (context.isSneaker || context.isFootwear) return "Footwear";
  if (context.isUmbrella) return "Umbrella";
  if (context.isBikeBasket) return "Bike Basket";
  if (context.isCup) return "Drinkware";
  if (context.isPants || context.isApparel) return "Apparel";
  return "Product";
}

function isEnglishFootwearText(text: string): boolean {
  return /shoe|sneaker|footwear|mesh upper|outsole|walking/i.test(text);
}

function englishVisibleSellingPoints(task: ProductTask, points: string[], context: ProductContext): string[] {
  const cleaned = points
    .map((point) => cleanEnglishVisibleCopy(point))
    .filter(Boolean);
  const fallback = englishFallbackSellingPoints(task, context);
  return uniqueNonEmpty([...cleaned, ...fallback]).slice(0, 4);
}

function englishFallbackSellingPoints(task: ProductTask, context: ProductContext): string[] {
  const text = [task.productName, task.category, task.sellingPoints, task.notes].join(" ");
  if (/oregano\s*oil|dietary\s*supplement|supplement|softgels?|capsules?|牛至油|膳食补充剂|软胶囊|胶囊/i.test(text)) {
    return [
      "Clearly Presented Formula",
      "Convenient Capsule Format",
      "Easy Everyday Routine",
      "Clear Package Details"
    ];
  }
  if (context.isAiRobot || /robot|ai companion|ai toy|voice chat|story|learning/i.test(text)) {
    return [
      "AI Voice Chat",
      "Story Time Companion",
      "Movable Joint Play",
      "LED Expression Face"
    ];
  }
  if (context.isSneaker || context.isFootwear || /shoe|sneaker|footwear|mesh|outsole/i.test(text)) {
    return [
      "Breathable Mesh Comfort",
      "All-Black Everyday Style",
      "Textured Outsole Grip",
      "Low-Cut Lace-Up Fit"
    ];
  }
  if (context.isUmbrella) {
    return [
      "Weather-Ready Coverage",
      "Compact Folding Design",
      "Easy Carry Handle",
      "Daily Commute Ready"
    ];
  }
  if (context.isBikeBasket) {
    return [
      "Water-Resistant Storage",
      "Roomy Front Basket",
      "Stable Mounted Structure",
      "Commute And Grocery Ready"
    ];
  }
  if (context.isCup) {
    return [
      "Easy Everyday Hydration",
      "Portable Carry Design",
      "Clean Lid Details",
      "Desk And Travel Ready"
    ];
  }
  return [
    `${englishCategoryLabel(task, context)} Feature Close-Up`,
    `${englishCategoryLabel(task, context)} In Real Use`,
    "Simple Setup Scene",
    "Clean Detail View"
  ];
}

function buildTissueCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "抽取式面巾纸");
  const sourceText = points.join(" ");
  const primaryPoint = /木浆|环保|材质|安心|放心/.test(sourceText)
    ? pickPoint(points, /木浆|环保|材质|安心|放心/, "原生木浆更安心")
    : "原生木浆更安心";
  const secondaryPoint = /柔软|亲肤|细腻|舒服|不粗糙/.test(sourceText)
    ? pickPoint(points, /柔软|亲肤|细腻|舒服|不粗糙/, "柔软触感不粗糙")
    : "柔软触感不粗糙";
  const tertiaryPoint = /无异味|异味|无味|入口|抽取|顺手|家庭|餐桌|客厅/.test(sourceText)
    ? pickPoint(points, /无异味|异味|无味|入口|抽取|顺手|家庭|餐桌|客厅/, "抽取无异味")
    : "抽取无异味";
  const detailFocus = "纸张压纹与包装花纹细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, secondaryPoint],
      [secondaryPoint, "轻擦不粗糙", "日常接触更舒服"],
      ["抽取顺手不费劲", "餐桌客厅随手可取", tertiaryPoint],
      ["细节靠近看", "压纹清楚可见", "蓝白花纹有质感"],
      ["家庭日常清洁", "一盒放在手边", "用起来更省心"]
    ],
    detail: [
      [primaryPoint, secondaryPoint, "家里常备更安心"],
      ["家用纸巾更要放心", tertiaryPoint, "餐桌接触也安心"],
      [secondaryPoint, "轻擦不粗糙", "纸面触感看得见"],
      ["随手一抽就能用", "客厅餐桌都顺手", "家务小事更从容"],
      [detailFocus, "包装信息清楚", "花纹细节有质感"],
      ["抽取式更方便", "一张一张顺手拿", "桌面也整洁"],
      ["家庭主妇更省心", "擦手擦桌都顺手", "日常清洁少费力"],
      ["把安心柔软", "放进家庭日常", productName]
    ]
  };
}

function buildTrashBagCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "艾草祛味垃圾袋");
  const odorPoint = pickPoint(points, /艾草|祛味|防臭|除臭|异味/, "艾草祛味防臭");
  const drawstringPoint = pickPoint(points, /抽绳|收口|一拉|不脏手/, "抽绳一拉收口");
  const capacityPoint = pickPoint(points, /容量|能装|厨余|杂物/, "大容量袋身更能装");
  const durablePoint = pickPoint(points, /加厚|不易破|防破|结实|耐装|承重/, "加厚袋身不易破漏");
  const valuePoint = pickPoint(points, /500|囤货|数量|性价比|划算|大包装/, "500只囤货更省心");
  return {
    primaryPoint: odorPoint,
    secondaryPoint: drawstringPoint,
    tertiaryPoint: capacityPoint,
    detailFocus: "抽绳袋口、袋身边缘和袋底",
    main: [
      [productName, valuePoint, odorPoint],
      [drawstringPoint, "一拉打包不脏手", "袋口动作看得见"],
      [capacityPoint, "厨余杂物都能装", "套桶容量更直观"],
      [durablePoint, "袋身边缘看得见", "装满提起也安心"],
      [valuePoint, "日常换袋更省心", productName]
    ],
    detail: [
      [odorPoint, valuePoint, productName],
      ["少点厨房异味", odorPoint, "清新感看得见"],
      [drawstringPoint, "一拉封口拎走", "打包不脏手"],
      [capacityPoint, "满桶也不外溢", "日常厨余更能装"],
      [durablePoint, "边缘袋底细节清楚", "近看也安心"],
      ["装满提起也稳", durablePoint, "不写虚构KG数"],
      ["家里多处都适用", "厨房卫浴办公都能用", "同款袋身多处适配"],
      [valuePoint, "多卷囤货更耐用", productName]
    ]
  };
}

function buildBikeBasketCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "电动车防水篮筐");
  const waterproofPoint = pickPoint(points, /防水|防雨|雨天|雨/, "雨天放物也安心");
  const capacityPoint = pickPoint(points, /大容量|容量|头盔|雨具|买菜|杂物|能装/, "头盔雨具都好放");
  const stablePoint = pickPoint(points, /稳固|固定|承托|结实|不晃|承重/, "骑行路上稳稳放");
  const conveniencePoint = pickPoint(points, /通勤|买菜|取放|安装|轻便|省心|日常/, "日常出门随手装");
  const valuePoint = pickPoint(points, /性价比|划算|实用|便宜|省钱/, "实用高性价比");
  return {
    primaryPoint: waterproofPoint,
    secondaryPoint: capacityPoint,
    tertiaryPoint: stablePoint,
    detailFocus: "防水盖、固定扣和篮筐边缘细节",
    main: [
      [productName, waterproofPoint, capacityPoint],
      [capacityPoint, "打开装载更直观", "通勤杂物有处放"],
      [stablePoint, "固定结构看得见", "骑行收纳更安心"],
      ["防水盖细节清楚", waterproofPoint, "雨天取放更省心"],
      [conveniencePoint, valuePoint, productName]
    ],
    detail: [
      [waterproofPoint, capacityPoint, productName],
      ["骑行收纳更省心", capacityPoint, "头盔雨衣随手放"],
      [waterproofPoint, "盖上也清楚", "雨天通勤少担心"],
      [stablePoint, "固定扣靠近看", "连接处更清楚"],
      ["随手放 随手拿", conveniencePoint, "日常买菜更顺手"],
      ["多场景都能装", "通勤 买菜 接送", "同款篮筐稳定出现"],
      ["细节扎实更耐看", "篮筐边缘和盖面清楚", "不写虚构承重数"],
      [valuePoint, conveniencePoint, productName]
    ]
  };
}

function buildPillowCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "睡眠枕头");
  const sourceText = points.join(" ");
  const primaryPoint = /柔软|舒适|舒服|云感/.test(sourceText) ? "柔软睡感更舒服" : pickPoint(points, /柔软|舒适|舒服|云感/, "柔软睡感更舒服");
  const secondaryPoint = /颈|脖子|承托|支撑|贴合/.test(sourceText) ? "颈部承托更贴合" : pickPoint(points, /颈|脖子|承托|支撑|贴合/, "颈部承托更贴合");
  const tertiaryPoint = /透气|孔|清爽/.test(sourceText) ? "透气孔细节清楚" : pickPoint(points, /透气|孔|清爽/, "透气孔细节清楚");
  const detailFocus = "透气孔与曲线细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, "睡前更想躺下"],
      [secondaryPoint, "贴合颈肩曲线", "躺下更放松"],
      ["卧室睡眠场景更有代入感", "柔软承托看得见", "夜晚休息更从容"],
      [tertiaryPoint, "波浪曲线清楚", "细节近看有质感"],
      ["软而有承托", primaryPoint, secondaryPoint]
    ],
    detail: [
      ["睡前更想躺下", primaryPoint, "卧室柔软睡感"],
      ["躺下总不舒服？", "枕头承托要贴合", secondaryPoint],
      [primaryPoint, "手压回弹有柔感", "睡感更放松"],
      [secondaryPoint, "贴合颈肩曲线", "仰睡侧睡都自然"],
      [tertiaryPoint, "密集孔位清楚可见", "整夜睡感更清爽"],
      ["波浪曲线看得见", "高低分区更贴合", "不是普通平枕"],
      ["卧室睡眠场景更有代入感", "睡前放松更有代入", "休息氛围更安心"],
      ["把柔软承托", "带进每晚休息", productName]
    ]
  };
}

function buildLaundryDetergentCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "洗衣液");
  const sourceText = points.join(" ");
  const primaryPoint = /温和|刺激|不刺激/.test(sourceText) ? "温和洗护不刺激" : pickPoint(points, /温和|刺激|不刺激/, "温和洗护不刺激");
  const secondaryPoint = /清洁|干净|洗净|污/.test(sourceText) ? "清洁力强更省心" : pickPoint(points, /清洁|干净|洗净|污/, "清洁力强更省心");
  const tertiaryPoint = /香|花香|蔷薇|玫瑰|留香/.test(sourceText) ? "洗后淡淡花香" : pickPoint(points, /香|花香|蔷薇|玫瑰|留香/, "洗后淡淡花香");
  const detailFocus = "瓶身标签细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, secondaryPoint, tertiaryPoint],
      [primaryPoint, "家人衣物安心洗", "日常洗衣更放心"],
      [secondaryPoint, "领口袖口日常污渍", "洗后更清爽"],
      [tertiaryPoint, "蔷薇花香更好闻", "洗衣间也清新"],
      ["粉色大瓶装", "瓶身信息清楚", "家庭洗衣更省心"]
    ],
    detail: [
      ["衣物洗得干净", secondaryPoint, "家务洗护更省心"],
      ["衣服脏了别发愁", "领口袖口重点洗", "日常污渍更好处理"],
      [primaryPoint, "手洗机洗都从容", "温和洗护少负担"],
      [secondaryPoint, "泡沫细腻易冲洗", "衣物洗后更清爽"],
      [tertiaryPoint, "蔷薇花香更好闻", "晾晒后也清新"],
      [detailFocus, "薔薇花香看得见", "净含量信息清楚"],
      ["室内洗衣场景", "倒取用量更顺手", "家庭家务更省心"],
      ["把清新留在衣物上", tertiaryPoint, productName]
    ]
  };
}

function buildSneakerCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "运动鞋子");
  const sourceText = points.join(" ");
  const primaryPoint = /颜值|好看|穿搭|有型/.test(sourceText) ? "高颜值日常好搭" : pickPoint(points, /颜值|好看|穿搭|有型/, "高颜值日常好搭");
  const secondaryPoint = /舒适|舒服|脚感|轻松/.test(sourceText) ? "脚感舒适更轻松" : pickPoint(points, /舒适|舒服|脚感|轻松/, "脚感舒适更轻松");
  const tertiaryPoint = /透气|鞋面|清爽/.test(sourceText) ? "鞋面透气更清爽" : pickPoint(points, /透气|鞋面|清爽/, "鞋面透气更清爽");
  const detailFocus = "鞋面与鞋底细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, "男生日常穿搭"],
      [secondaryPoint, "走路更轻松", "出街通勤都适合"],
      [tertiaryPoint, "鞋面孔位清楚", "久穿也更清爽"],
      [detailFocus, "黑白线条有辨识度", "金色鞋舌清楚可见"],
      ["户外出街更有型", primaryPoint, secondaryPoint]
    ],
    detail: [
      ["出街一眼好看", primaryPoint, "男生日常出街"],
      ["好看也要好穿", secondaryPoint, "日常走路更轻松"],
      [tertiaryPoint, "鞋面孔位看得见", "脚感更清爽"],
      ["户外日常都好搭", "牛仔裤运动裤都自然", "穿搭更有型"],
      [detailFocus, "鞋头纹理清楚", "鞋带走线规整"],
      ["黑白金细节", "鞋舌标识保留", "侧面线条有记忆点"],
      ["上脚场景更直观", "男生日常出街", "轻松搭出干净感"],
      ["把高颜值", "穿进日常出街", productName]
    ]
  };
}

function buildPantsCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "宽松休闲裤");
  const sourceText = points.join(" ");
  const primaryPoint = /宽松|版型|显瘦|腿型|不拘束|松紧/.test(sourceText)
    ? pickPoint(points, /宽松|版型|显瘦|腿型|不拘束|松紧/, "宽松版型不拘束")
    : "宽松版型不拘束";
  const secondaryPoint = /垂感|垂顺|面料|柔软|软糯|质感|针织/.test(sourceText)
    ? pickPoint(points, /垂感|垂顺|面料|柔软|软糯|质感|针织/, "垂感面料看得见")
    : "垂感面料看得见";
  const tertiaryPoint = /两色|双色|百搭|好搭|搭配|通勤|居家|日常/.test(sourceText)
    ? pickPoint(points, /两色|双色|百搭|好搭|搭配|通勤|居家|日常/, "两色日常好搭")
    : "两色日常好搭";
  const detailFocus = "腰头抽绳与面料纹理细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, secondaryPoint],
      [primaryPoint, "走动坐下都自在", "抽绳松紧更灵活"],
      ["居家通勤都能穿", tertiaryPoint, "一条裤子多场景"],
      ["细节看得见", "腰头抽绳清楚", secondaryPoint],
      [tertiaryPoint, "参考图配色更好搭", "日常穿搭更省心"]
    ],
    detail: [
      [primaryPoint, secondaryPoint, "日常穿着更自在"],
      ["怕勒腿不舒服？", primaryPoint, "宽松不拖沓"],
      [secondaryPoint, "软糯纹理看得见", "靠近看也有质感"],
      ["居家通勤都适合", "出门在家都自然", tertiaryPoint],
      ["腰头抽绳细节", "松紧调节更灵活", "走线清楚"],
      ["多角度看版型", "正面侧面都清楚", "裤脚线条更利落"],
      [tertiaryPoint, "衣橱搭配少纠结", "日常出门更省心"],
      ["把自在穿进日常", primaryPoint, productName]
    ]
  };
}

function buildApparelCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "日常服饰");
  const sourceText = points.join(" ");
  const primaryPoint = /版型|轮廓|显瘦|修身|宽松|合身/.test(sourceText)
    ? pickPoint(points, /版型|轮廓|显瘦|修身|宽松|合身/, "版型轮廓更清楚")
    : "版型轮廓更清楚";
  const secondaryPoint = /面料|材质|质感|柔软|棉|针织|纹理/.test(sourceText)
    ? pickPoint(points, /面料|材质|质感|柔软|棉|针织|纹理/, "面料质感看得见")
    : "面料质感看得见";
  const tertiaryPoint = /穿搭|百搭|搭配|日常|通勤|居家|衣橱/.test(sourceText)
    ? pickPoint(points, /穿搭|百搭|搭配|日常|通勤|居家|衣橱/, "日常穿搭更省心")
    : "日常穿搭更省心";
  const detailFocus = "版型面料与做工细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, secondaryPoint],
      [primaryPoint, "上身轮廓更直观", "日常穿着更自在"],
      [tertiaryPoint, "衣橱场景更好搭", "通勤居家都自然"],
      ["细节看得见", secondaryPoint, "靠近看也有质感"],
      [tertiaryPoint, "参考图配色更好搭", "日常选择更省心"]
    ],
    detail: [
      [primaryPoint, secondaryPoint, tertiaryPoint],
      ["日常穿搭怕不合适？", primaryPoint, "上身轮廓更直观"],
      [secondaryPoint, "面料纹理看得见", "近看也有质感"],
      [tertiaryPoint, "衣橱搭配更自然", "通勤居家都适合"],
      ["做工细节看得见", "边缘走线更清楚", secondaryPoint],
      ["多角度看款式", "正面侧面都清楚", primaryPoint],
      ["衣橱搭配少纠结", tertiaryPoint, "日常出门更省心"],
      ["把好版型", "穿进真实日常", productName]
    ]
  };
}

function buildStudentBackpackCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "学生双肩背包");
  const sourceText = points.join(" ");
  const primaryPoint = /轻便|肩负|背负|轻松/.test(sourceText)
    ? "轻便肩负上学更轻松"
    : pickPoint(points, /轻便|肩负|背负|轻松/, "轻便肩负上学更轻松");
  const secondaryPoint = /颜值|好看|搭|外观/.test(sourceText)
    ? "外观颜值更高"
    : pickPoint(points, /颜值|好看|搭|外观/, "外观颜值更高");
  const tertiaryPoint = /收纳|分区|课本|前袋|侧袋|拿取/.test(sourceText)
    ? "分区收纳课本更清楚"
    : pickPoint(points, /收纳|分区|课本|前袋|侧袋|拿取/, "分区收纳课本更清楚");
  const qualityPoint = /质量|做工|细节|肩带|前袋/.test(sourceText)
    ? pickPoint(points, /做工|细节|肩带|前袋/, "做工细节看得见")
    : "做工细节看得见";
  const detailFocus = "肩带前袋与外观细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, secondaryPoint],
      [primaryPoint, "肩带贴合肩背", "每天上学更轻松"],
      ["上学场景", tertiaryPoint, "课本水杯都能带"],
      [detailFocus, qualityPoint, "配件细节也清楚"],
      ["高颜值上学包", secondaryPoint, "日常搭配更省心"]
    ],
    detail: [
      [primaryPoint, secondaryPoint, "上学每天都想背"],
      ["孩子上学东西多", tertiaryPoint, "拿取更顺手"],
      ["肩带贴合肩背", primaryPoint, "背着走更轻松"],
      ["校园上学场景", "校门课桌都适合", "背上就有学生感"],
      [detailFocus, "图案结构看得清", "前袋侧袋更实用"],
      ["多角度展示", "正面侧面背面都清楚", "配件细节一起看"],
      ["课本水杯都能带", tertiaryPoint, "日常上学更从容"],
      ["高颜值上学包", "轻便好背更好看", productName]
    ]
  };
}

function buildChildCupCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "儿童保温杯");
  const sourceText = points.join(" ");
  const primaryPoint = /可爱|萌趣|卡通|图案|爱用/.test(sourceText) ? "可爱萌趣孩子爱用" : pickPoint(points, /可爱|萌趣|卡通|图案|爱用/, "可爱萌趣孩子爱用");
  const secondaryPoint = /耐热|耐高温|热水|高温/.test(sourceText) ? "耐热饮用更安心" : pickPoint(points, /耐热|耐高温|热水|高温/, "耐热饮用更安心");
  const tertiaryPoint = /环保|材质|材料|放心/.test(sourceText) ? "环保材质更放心" : pickPoint(points, /环保|材质|材料|放心/, "环保材质更放心");
  const detailFocus = "杯盖把手细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, "儿童日常喝水杯"],
      [secondaryPoint, "热水温水都从容", "妈妈选杯更放心"],
      ["家里上学都适合", "餐桌书桌都顺手", "儿童日常喝水更省心"],
      [detailFocus, "双把手小手好握", "卡通图案清楚可见"],
      [tertiaryPoint, "可爱外观更爱用", "每天喝水更省心"]
    ],
    detail: [
      ["让孩子爱上喝水", primaryPoint, "儿童日常喝水杯"],
      ["妈妈选杯更在意", secondaryPoint, tertiaryPoint],
      [secondaryPoint, "杯口杯盖看得清", "日常热水温水都从容"],
      ["儿童家庭场景", "餐桌书桌都适合", "孩子日常喝水更省心"],
      [detailFocus, "双把手小手好握", "卡通图案清楚可见"],
      [tertiaryPoint, "杯身结构更清楚", "妈妈看得更安心"],
      ["上学也能带", "书包课桌都顺手", "家里学校都适合"],
      ["每天喝水更省心", "可爱萌趣更爱用", productName]
    ]
  };
}

function buildCupCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "水杯");
  const appearancePoint = pickPoint(points, /颜值|图案|出片|潮流|好看|记忆点/, "高颜值杯身更出片");
  const materialPoint = pickConcretePoint(points, /环保材质更放心/, /环保|材质|异味|PPSU|放心/, "环保材质更放心");
  const insulationPoint = pickConcretePoint(points, /隔热握持不烫手/, /隔热|不烫|热水|安心/, "隔热握持不烫手");
  const carryPoint = pickPoint(points, /户外|携带|挂环|挂带|出门|随手|顺手/, "户外随手喝更方便");
  const detailFocus = "杯盖吸管与杯身图案";
  return {
    primaryPoint: appearancePoint,
    secondaryPoint: materialPoint,
    tertiaryPoint: insulationPoint,
    detailFocus,
    main: [
      [productName, appearancePoint, "年轻人日常饮水杯"],
      [materialPoint, "杯身清透看得见", "日常喝水无异味"],
      [insulationPoint, "打开就能喝", "户外饮水更安心"],
      [carryPoint, "随手带去户外", "出门喝水更方便"],
      ["杯盖吸管细节", "图案刻度清楚", "靠近看也有质感"]
    ],
    detail: [
      [appearancePoint, materialPoint, "日常饮水更有型"],
      ["出门喝水", "想要好看也顺手", carryPoint],
      [insulationPoint, "杯盖翻开再饮用", "吸管杯口看得见"],
      ["户外随手喝", "打开杯盖更顺畅", "年轻人日常都适合"],
      ["杯盖吸管细节", "黄色按钮清楚", "蓝色翻盖看得见"],
      ["透明杯身", "图案刻度清楚", "PPSU 材质信息保留"],
      [carryPoint, "挂带出门更方便", "包里手上都顺手"],
      ["把好看水杯", "带进每天出门", productName]
    ]
  };
}

function buildMooncakeGiftCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "礼盒月饼");
  const sourceText = points.join(" ");
  const primaryPoint = /高端|体面|外观|礼盒/.test(sourceText) ? "高端礼盒更体面" : pickPoint(points, /高端|体面|外观|礼盒|送礼/, "高端礼盒更体面");
  const secondaryPoint = /送礼|人情|拜访|中秋/.test(sourceText) ? "中秋送礼更合适" : pickPoint(points, /送礼|人情|拜访|中秋/, "中秋送礼更合适");
  const tertiaryPoint = /团圆|家人|分享|吃月饼/.test(sourceText) ? "一家人分享更有仪式感" : pickPoint(points, /团圆|家人|分享|吃月饼/, "一家人分享更有仪式感");
  const detailFocus = "礼盒包装细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, secondaryPoint],
      [primaryPoint, "打开就有仪式感", "送亲友更拿得出手"],
      ["中秋团圆桌", "一家人分享月饼", tertiaryPoint],
      ["礼盒细节显质感", "图案包装清楚可见", "送礼第一眼就体面"],
      ["中秋心意不失礼", secondaryPoint, tertiaryPoint]
    ],
    detail: [
      ["中秋送礼有面子", primaryPoint, "人情往来更体面"],
      ["送礼怕不够体面？", "礼盒质感先打动人", secondaryPoint],
      [primaryPoint, "开盒更有仪式感", "亲友收到更有心意"],
      ["团圆分享更有氛围", "茶桌餐桌都适合", tertiaryPoint],
      ["礼盒细节显质感", "包装图案清楚可见", "拿在手里更体面"],
      ["月饼礼盒更完整", "外观层次看得见", "送礼自用都合适"],
      ["节日拜访更省心", secondaryPoint, "中秋心意不失礼"],
      ["把团圆装进礼盒", "中秋送礼更体面", productName]
    ]
  };
}

function buildSocksCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "女士袜子");
  const sourceText = points.join(" ");
  const primaryPoint = /纯棉|棉|舒适|亲肤/.test(sourceText) ? "纯棉触感更舒服" : pickPoint(points, /纯棉|棉|舒适|亲肤/, "纯棉触感更舒服");
  const secondaryPoint = /好看|简约|高级|百搭|穿搭/.test(sourceText) ? "简约好看更百搭" : pickPoint(points, /好看|简约|高级|百搭|穿搭/, "简约好看更百搭");
  const tertiaryPoint = /女生|女士|日常|多场景|搭配/.test(sourceText) ? "女生日常穿搭更省心" : pickPoint(points, /女生|女士|日常|多场景|搭配/, "女生日常穿搭更省心");
  const detailFocus = "袜口织纹细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, "纯棉好穿也好看", tertiaryPoint],
      [primaryPoint, "贴近日常脚感", "上脚舒服不将就"],
      ["简约穿搭更好配", "裙装裤装都自然", secondaryPoint],
      ["袜口织纹看得见", "脚尖细节清楚", primaryPoint],
      ["女生衣橱常备", secondaryPoint, tertiaryPoint]
    ],
    detail: [
      ["纯棉好穿也好看", tertiaryPoint, "简约女生袜"],
      ["好看也要舒服", primaryPoint, "每天穿都不费心"],
      [primaryPoint, "袜口织纹看得见", "近看也有质感"],
      ["日常穿搭更好配", "裙装裤装都自然", secondaryPoint],
      ["袜口脚尖细节清楚", "织纹走线看得见", "上脚更显干净"],
      ["多场景日常穿", "通勤休闲都能搭", tertiaryPoint],
      ["女生衣橱常备", secondaryPoint, "每天搭配少纠结"],
      ["简约好看的日常袜", "穿出干净轻松感", productName]
    ]
  };
}

function buildPestControlCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "蟑螂药");
  const sourceText = points.join(" ");
  const primaryPoint = /杀蟑|灭蟑|蟑螂|效果/.test(sourceText) ? "灭蟑需求更直接" : pickPoint(points, /杀蟑|灭蟑|蟑螂|效果/, "灭蟑需求更直接");
  const secondaryPoint = /家庭|家里|居家|厨房|卫生间/.test(sourceText) ? "家庭角落都能放" : pickPoint(points, /家庭|家里|居家|厨房|卫生间/, "家庭角落都能放");
  const tertiaryPoint = /无毒|安全|安心|人体/.test(sourceText) ? "按说明使用更安心" : softenAbsoluteSafetyPoint(pickPoint(points, /无毒|安全|安心|人体/, "按说明使用更安心"));
  const detailFocus = "包装信息细节";
  return {
    primaryPoint: softenAbsoluteSafetyPoint(primaryPoint),
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, softenAbsoluteSafetyPoint(primaryPoint), "家庭场景适用"],
      [softenAbsoluteSafetyPoint(primaryPoint), "厨房角落重点处理", "灭蟑需求更清楚"],
      ["家里重点角落", "厨卫墙角都适合", secondaryPoint],
      ["包装信息清楚", "取用方式看得见", "摆放更直观"],
      ["按说明放置更省心", "远离儿童宠物接触", tertiaryPoint]
    ],
    detail: [
      ["家里灭蟑更省心", "厨房角落重点处理", "家庭场景适用"],
      ["看见蟑螂就烦？", "角落问题及时处理", "居家清爽更安心"],
      [softenAbsoluteSafetyPoint(primaryPoint), "重点角落好放置", "灭蟑需求更直接"],
      ["厨卫角落都能放", "墙边缝隙更适合", secondaryPoint],
      ["包装信息清楚", "开封取用更直观", "摆放位置看得见"],
      ["家庭环境更清爽", "厨房卫生间重点守护", "减少蟑螂打扰"],
      ["按说明摆放更省心", "远离儿童宠物接触", tertiaryPoint],
      ["把清爽留给家里", "灭蟑从角落开始", productName]
    ]
  };
}

function buildPortableFanCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "手持风扇");
  const sourceText = points.join(" ");
  const primaryPoint = /便携|携带|小巧|手持|出门/.test(sourceText) ? "小巧出门好携带" : pickPoint(points, /便携|携带|小巧|手持|出门/, "小巧出门好携带");
  const secondaryPoint = /持续|续航|1小时|1个小时|一小时|吹风|清凉/.test(sourceText) ? "可持续吹风约1小时" : pickPoint(points, /持续|续航|1小时|1个小时|一小时|吹风|清凉/, "可持续吹风约1小时");
  const tertiaryPoint = /充电|快充|补能|充点/.test(sourceText) ? "充电补能更方便" : pickPoint(points, /充电|快充|补能|充点/, "充电补能更方便");
  const detailFocus = "扇罩按键细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, "户外夏天随手吹"],
      ["户外热也不慌", "随手一开就有风", secondaryPoint],
      [primaryPoint, "包里一放不占地", "出门通勤都顺手"],
      ["萌趣猫脸外观", "薄荷绿清爽好看", "黄色爱心有记忆点"],
      [tertiaryPoint, secondaryPoint, "夏天出门更从容"]
    ],
    detail: [
      ["夏天出门随手吹", primaryPoint, "户外怕热也从容"],
      ["户外热得难受？", "拿在手里就能吹", "通勤排队都适合"],
      [secondaryPoint, "小风量陪你走一路", "户外清凉不断档"],
      [primaryPoint, "手持小巧不累手", "包里一放不占地"],
      ["扇罩按键细节", "猫脸表情看得清", "黄色爱心更可爱"],
      ["充电补能更方便", "出门前快速准备", "随手放包更安心"],
      ["高颜值萌趣外观", "薄荷绿清爽配色", "夏日拍照也好看"],
      ["把清凉装进口袋", "夏天出门更从容", productName]
    ]
  };
}

function buildBabyCareCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "婴儿护理用品");
  const sourceText = points.join(" ");
  const primaryPoint = /温和|柔软|亲肤|刺激/.test(sourceText) ? "温和触感更安心" : pickPoint(points, /温和|柔软|亲肤|刺激/, "温和触感更安心");
  const secondaryPoint = /吸收|吸水|干爽/.test(sourceText) ? "吸收表现看得见" : pickPoint(points, /吸收|吸水|干爽/, "吸收表现看得见");
  const tertiaryPoint = /护理|父母|妈妈|宝妈|收纳|育儿/.test(sourceText) ? "父母日常护理更省心" : pickPoint(points, /护理|父母|妈妈|宝妈|收纳|育儿/, "父母日常护理更省心");
  const detailFocus = "包装与吸收层细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, "婴儿日常护理"],
      [secondaryPoint, "干净样片直接看", primaryPoint],
      ["育儿台日常", tertiaryPoint, "拿取收纳更顺手"],
      ["包装细节清楚", secondaryPoint, "靠近看也有质感"],
      [tertiaryPoint, primaryPoint, "日常准备更从容"]
    ],
    detail: [
      [primaryPoint, secondaryPoint, tertiaryPoint],
      ["父母在意的护理细节", primaryPoint, "干净安心更重要"],
      [secondaryPoint, "用干净样片证明", primaryPoint],
      ["育儿台日常", tertiaryPoint, "护理用品摆放清楚"],
      ["吸收层细节看得见", secondaryPoint, "近看也有质感"],
      ["包装样片多角度", primaryPoint, secondaryPoint],
      [tertiaryPoint, "外出前准备更顺手", "日常护理不慌乱"],
      ["把温和护理", "放进每天日常", productName]
    ]
  };
}

function buildCuttingBoardCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "菜板");
  const sourceText = points.join(" ");
  const primaryPoint = /乌檀|木纹|木|质感/.test(sourceText) ? "乌檀木质感看得见" : pickPoint(points, /乌檀|木纹|木|质感/, "乌檀木质感看得见");
  const secondaryPoint = /高硬度|硬度|耐切|切配/.test(sourceText) ? "高硬度日常切配更稳" : pickPoint(points, /高硬度|硬度|耐切|切配/, "高硬度日常切配更稳");
  const tertiaryPoint = /冲洗|好洗|易洗|清洗|方便/.test(sourceText) ? "冲洗方便更省心" : pickPoint(points, /冲洗|好洗|易洗|清洗|方便/, "冲洗方便更省心");
  const proofPoint = /抗菌|99\\.9|99.9/.test(sourceText) ? "抗菌率99.9%" : pickPoint(points, /抗菌|99\\.9|99.9/, "抗菌率99.9%");
  const detailFocus = "乌檀木纹与边角细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, "厨房切配更有质感"],
      [secondaryPoint, "切菜剁肉更稳", primaryPoint],
      ["厨房做饭场景", tertiaryPoint, "日常用完一冲就好"],
      [detailFocus, proofPoint, "靠近看也有质感"],
      [proofPoint, tertiaryPoint, "家用菜板更省心"]
    ],
    detail: [
      [primaryPoint, secondaryPoint, "厨房切配更稳"],
      ["家庭厨房更常用", secondaryPoint, "日常切配不将就"],
      [secondaryPoint, "真实切菜动作证明", primaryPoint],
      ["厨房做饭场景", tertiaryPoint, "冲洗后更清爽"],
      [detailFocus, primaryPoint, "近看纹理更清楚"],
      ["整板多角度展示", proofPoint, tertiaryPoint],
      ["用完随手冲洗", tertiaryPoint, "挂放收纳更利落"],
      ["把乌檀木质感", "带进每日厨房", productName]
    ]
  };
}

function buildMagneticLifterCopyPlan(task: ProductTask, points: string[]): GenericCopyPlan {
  const productName = productDisplayName(task, "永磁起重机");
  const sourceText = points.join(" ");
  const primaryPoint = /3倍|吸力|磁力|稳/.test(sourceText) ? "3倍吸力吊装更稳" : pickPoint(points, /3倍|吸力|磁力|稳/, "3倍吸力吊装更稳");
  const secondaryPoint = /无需用电|不用电|免电|永磁/.test(sourceText) ? "无需用电现场更省心" : pickPoint(points, /无需用电|不用电|免电|永磁/, "无需用电现场更省心");
  const tertiaryPoint = /场景|起重|吊装|钢板|钢材|户外|车间/.test(sourceText) ? "多种起重场景适用" : pickPoint(points, /场景|起重|吊装|钢板|钢材|户外|车间/, "多种起重场景适用");
  const detailFocus = "吊环手柄与机身标签细节";
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, "钢板搬运更直接"],
      [primaryPoint, "吸附钢板看得见", "吊装过程更稳"],
      ["户外起重场景", tertiaryPoint, secondaryPoint],
      [detailFocus, "结构细节清楚", "靠近看更放心"],
      [secondaryPoint, tertiaryPoint, "现场作业更省心"]
    ],
    detail: [
      [primaryPoint, secondaryPoint, "钢板搬运更直接"],
      ["起重搬运更怕不稳", primaryPoint, "钢板吸附看得见"],
      [primaryPoint, "真实吊装动作证明", "钢材搬运更直接"],
      ["户外起重场景", tertiaryPoint, secondaryPoint],
      [detailFocus, "吊环手柄都清楚", "靠近看更放心"],
      ["200KG/400KG规格展示", "参数信息更清楚", "按实际工况选择"],
      [secondaryPoint, "无电源场地也能用", "现场作业更灵活"],
      ["让钢材搬运", "更稳更省心", productName]
    ]
  };
}

function buildDefaultGenericCopyPlan(
  task: ProductTask,
  points: string[],
  specs: string[],
  context: ProductContext
): GenericCopyPlan {
  const productName = productDisplayName(task, "精选商品");
  const category = task.category || "日常使用";
  const primaryPoint = cleanVisibleCopy(points[0]) || `${category}更省心`;
  const secondaryPoint = cleanVisibleCopy(points[1]) || "关键细节看得见";
  const tertiaryPoint = cleanVisibleCopy(points[2]) || `${productName}好看也好用`;
  const targetScene = targetSceneLabel(task, context);
  const detailFocus = productDetailFocus(task, context);
  const specCopy = usefulSpecCopy(specs);
  return {
    primaryPoint,
    secondaryPoint,
    tertiaryPoint,
    detailFocus,
    main: [
      [productName, primaryPoint, category],
      [primaryPoint, "重点一眼看清", secondaryPoint],
      [targetScene, tertiaryPoint, "拿取使用更直观"],
      [`${detailFocus}看得见`, secondaryPoint, "靠近看也有质感"],
      specCopy
        ? ["关键信息更清楚", specCopy, productName]
        : [`适合${targetScene}`, tertiaryPoint, primaryPoint]
    ],
    detail: [
      [primaryPoint, secondaryPoint, productName],
      [`买前在意的${category}`, secondaryPoint, primaryPoint],
      [primaryPoint, "看得见的细节", secondaryPoint],
      [targetScene, tertiaryPoint, "拿取使用更直观"],
      [`${detailFocus}看得见`, secondaryPoint, "靠近看也有质感"],
      specCopy
        ? ["关键信息更清楚", specCopy, tertiaryPoint]
        : [`${category}日常更清楚`, primaryPoint, tertiaryPoint],
      [`适合${targetScene}`, tertiaryPoint, "日常选择更省心"],
      [`把${primaryPoint}`, "变成日常好用", productName]
    ]
  };
}

function buildProductProofMatrix(task: ProductTask, context: ProductContext, plan: GenericCopyPlan): ProductProofMatrix {
  const text = [task.productName, task.category, task.targetAudience, task.sellingPoints, task.notes, task.referenceKeywords].join(" ");
  const point = (index: number, fallback: string) => cleanVisibleCopy(plan.main[index]?.[0]) || cleanVisibleCopy(plan.detail[index]?.[0]) || fallback;
  if (context.isAiRobot) {
    const robotPoints = filterCategoryCompatibleSellingPoints(task, cleanBusinessPhrases(splitList(task.sellingPoints)));
    const robotPoint = (pattern: RegExp, fallback: string) => pickPoint(robotPoints, pattern, fallback);
    const desktopPoint = robotPoint(/潮玩|摆件|桌面|颜值|造型|外观/, "潮玩桌面摆件");
    const languagePoint = robotPoint(/多语言|方言|双语|中文|英文|英语|日语|粤语|闽南语|语言/, "多语言与方言互动");
    const storyPoint = robotPoint(/讲故事|故事|成语接龙|成语|儿歌/, "讲故事与成语接龙");
    const voicePoint = robotPoint(/趣味语音|语音|对话|问答|唤醒|多模型|模型/, "趣味语音交互");
    const learningPoint = robotPoint(/学习答疑|学习|答疑|早教|百科|课本/, "学习答疑");
    const jointPoint = robotPoint(/多关节|关节|可动|动作|姿势/, "多关节可动");
    const playPoint = robotPoint(/玩法丰富|玩法|游戏|跳舞/, "玩法丰富");
    const childPoint = robotPoint(/孩子|玩伴|陪伴|亲子/, "孩子贴心玩伴");
    const onlinePoint = robotPoint(/联网|WiFi|智能聊天|云端|网络/, "联网智能聊天");
    const screenPoint = robotPoint(/LED|表情|屏幕|科技/, "LED表情屏互动");
    const main = normalizeProofScripts([
      {
        sellingPoint: desktopPoint,
        productForm: "同款黄黑银机器人以三分之四角度或坐姿放在书桌/展示架上，蓝色LED表情屏、银色耳机装饰和可动关节清楚。",
        proofMethod: "用桌面尺度、台灯、书本和展示架证明潮玩摆件价值，机器人是本张第一视觉主体。",
        interaction: "书本、台灯和无品牌礼盒只做尺度与生活感辅助，不遮挡屏幕和关节。",
        avoidRepeat: "后续不得继续使用同一桌面静物角度，必须转入课堂、信息图、动态或互动场景。"
      },
      {
        sellingPoint: languagePoint,
        productForm: "教室黑板、中文/English/方言语言卡、对话气泡和孩子提问手部占画面主要区域；机器人缩小为授课小老师。",
        proofMethod: "用语言卡、黑板和对话关系证明多语言/方言互动，不只在机器人旁边放卖点文字；语言示例不代表未经确认的支持数量。",
        interaction: "黑板、课本、语言卡和孩子手部是大场景元素，机器人用指向或回应姿势参与。",
        avoidRepeat: "本张场景主视觉不是机器人棚拍，不能复制主图的正面/三分之四静物构图。"
      },
      {
        sellingPoint: storyPoint,
        productForm: "打开的绘本、成语接龙卡、阅读灯和孩子翻页动作占前景，机器人侧身坐在书旁。",
        proofMethod: "用绘本、卡牌、翻页和机器人讲解姿态证明故事与成语玩法，不用空泛‘早教’替代。",
        interaction: "孩子手部和绘本提供互动证据，人物不能遮挡机器人屏幕。",
        avoidRepeat: "不使用语言课堂黑板，改用阅读角、卡牌和故事光线。"
      },
      {
        sellingPoint: jointPoint,
        productForm: "同款机器人抬手、弯腿或转身的动态姿势，辅以手臂与腿部关节局部放大。",
        proofMethod: "用动作轨迹、关节连接处和不同姿势证明可动，不能只写‘灵活’或复制原图站姿。",
        interaction: "动作小卡和细线标注只指向真实关节，不添加未提供的自由度或参数。",
        avoidRepeat: "本张不做语言/故事人物场景，必须让姿势和关节证据成为主视觉。"
      },
      {
        sellingPoint: robotPoint(/长续航|续航|电池|电量/, "长续航"),
        productForm: "大型电池能量图、从早到晚的时间线、学习与故事两个小场景，机器人只作为小型轮廓或LED屏插图。",
        proofMethod: "用全天陪伴时间线表达长续航，不写具体小时数、电池容量、百分比或检测数据。",
        interaction: "电池、日夜时间线和小型产品插图服务续航卖点，不要求完整机器人占画面中心。",
        avoidRepeat: "禁止回到完整机器人站立棚拍，不能用‘长续航’四字代替视觉证据。"
      }
    ]);
    const detail = normalizeProofScripts([
      {
        sellingPoint: voicePoint,
        productForm: "机器人前倾倾听或抬手回应，旁边有麦克风、声波和提问卡。",
        proofMethod: "用声波、倾听表情和回应动作证明语音互动。",
        interaction: "孩子侧脸/手部、麦克风和问题卡形成对话关系，不让文字承担全部证明。",
        avoidRepeat: "不复制语言课堂或桌面摆件构图。"
      },
      {
        sellingPoint: onlinePoint,
        productForm: "云端节点、WiFi连接线、家庭设备和聊天关系图占画面主区域，机器人作为小型连接终端。",
        proofMethod: "用网络连接关系和聊天气泡表达联网互动，不编造速度、协议或技术指标。",
        interaction: "家庭设备与云端图形是主元素，机器人保持清晰可辨但不必占中心。",
        avoidRepeat: "本张采用信息图式构图，不使用人物阅读桌面。"
      },
      {
        sellingPoint: learningPoint,
        productForm: "课本、问题卡、黑板和孩子提问动作占主要区域，机器人指向问题或做回应姿态。",
        proofMethod: "用具体问题、指向动作和回应表情证明答疑场景，不只写‘学习更方便’。",
        interaction: "孩子手部、课本和黑板服务问题关系，机器人仍需保留主体特征。",
        avoidRepeat: "不复制网络节点图，换成学习桌/课堂三层构图。"
      },
      {
        sellingPoint: childPoint,
        productForm: "机器人坐在孩子身边或朝向亲子阅读，家庭空间中完整可辨。",
        proofMethod: "用孩子主动靠近、亲子翻书或聊天动作证明陪伴感。",
        interaction: "孩子、家长手部、绘本和家庭灯光提供情绪与尺度，人物不抢主体。",
        avoidRepeat: "不使用课本答疑的近景，换成客厅/床边生活空间。"
      },
      {
        sellingPoint: playPoint,
        productForm: "游戏板、动作轨迹、故事卡和多个不同机器人姿势组成三宫格/四宫格。",
        proofMethod: "用跳舞、挥手、讲故事、思考等不同状态证明玩法变化。",
        interaction: "每格使用不同动作、LED表情、道具和视角，不能只替换背景。",
        avoidRepeat: "禁止所有格子使用同一正面站姿或同一屏幕表情。"
      },
      {
        sellingPoint: screenPoint,
        productForm: "蓝色LED表情屏、银色耳机装饰和黄黑圆润机身局部特写，辅以微笑/倾听/眨眼小窗。",
        proofMethod: "用屏幕表情和耳机细节建立生命感，不虚构内部元件。",
        interaction: "细线和放大圈只指向参考图中真实可见结构。",
        avoidRepeat: "本张是细节信任图，不做人物大场景。"
      },
      {
        sellingPoint: jointPoint,
        productForm: "正面、侧面、背面/顶部和关节局部四种视角，姿态与表情各不相同。",
        proofMethod: "用多角度结构板证明主体一致与形态变化。",
        interaction: "不需要人物，重点是同款黄黑银机器人在不同姿态中的结构一致性。",
        avoidRepeat: "禁止四格都正面站立，禁止新增未提供的按钮、接口或参数。"
      },
      {
        sellingPoint: desktopPoint,
        productForm: "机器人以生活化坐姿或邀请互动手势出现在书桌、展示架或无品牌礼盒旁。",
        proofMethod: "用桌面尺度、礼物开箱和家庭学习空间完成收尾购买理由。",
        interaction: "礼盒、台灯、绘本和双手只做辅助，不遮挡机器人屏幕、耳机和关节。",
        avoidRepeat: "不回到首图棚拍，不出现价格、销量或夸张促销贴。"
      }
    ]);
    return {
      archetype: "AI机器人：桌面摆件、语言场景、故事游戏、动态关节、电量信息图、联网关系图和亲子互动必须分屏呈现。",
      globalRule: "AI机器人全套图必须围绕用户卖点决定大视觉元素和机器人出场级别；机器人是识别锚点但不要求每张占中心，语言/联网/续航卖点允许场景或信息图成为主视觉。禁止13张重复同一正面站姿、同一LED表情和同一浅色背景。",
      main,
      detail
    };
  }
  if (context.isBikeBasket) {
    const main = normalizeProofScripts([
      {
        sellingPoint: point(0, "雨天放物也安心"),
        productForm: "同一款电动车/自行车篮筐安装在车头或车把前端，篮身、防水盖/罩、固定位置和整体比例清楚。",
        proofMethod: "用车上安装全貌、少量雨滴或湿润地面证明防水收纳用途；不写防水等级、检测认证或承重KG。",
        interaction: "车把、头盔、雨衣或通勤包只做辅助，篮筐始终是第一视觉主体。",
        avoidRepeat: "首图允许车上完整安装视角，后续必须切换为打开装载、闭合防水、固定近景或取放动作。"
      },
      {
        sellingPoint: point(1, "头盔雨具都好放"),
        productForm: "篮筐打开状态，内部放入头盔、雨衣、小型买菜袋、手套或通勤杂物，篮身边缘仍清楚。",
        proofMethod: "用真实物品比例证明容量，不写虚构升数；画面重点是装载状态，而不是静物堆叠。",
        interaction: "成年人手部正在把头盔/雨衣放入或整理篮筐。",
        avoidRepeat: "必须是打开装载和俯拍/侧俯视角，不能重复第1张车头全貌。"
      },
      {
        sellingPoint: point(2, "骑行路上稳稳放"),
        productForm: "固定扣、连接带、篮筐边缘、车把连接处或安装支架的近景，局部放大圈展示结构。",
        proofMethod: "用连接处和受力方向证明稳固安装，不写未提供承重数字或极限测试。",
        interaction: "手部可轻扶固定扣或调整连接处，动作克制真实。",
        avoidRepeat: "本张是结构近景，不拍完整远景装载篮筐。"
      },
      {
        sellingPoint: point(3, "防水盖细节清楚"),
        productForm: "防水盖/罩闭合状态，篮筐安装在车上或桌面近景，盖面、边缘贴合和水珠清楚。",
        proofMethod: "用闭合状态和水珠/雨后环境证明雨天遮挡，不表现浸泡、不写绝对防水。",
        interaction: "手部可拉上/盖上防水罩，车头或室外雨天背景辅助。",
        avoidRepeat: "必须区别第2张打开装载，重点换成闭合防护状态。"
      },
      {
        sellingPoint: point(4, "日常出门随手装"),
        productForm: "同一款篮筐在小区门口、菜市场门口、通勤停车点或取放场景中完整出现。",
        proofMethod: "用手部取出买菜袋、背包或雨衣的动作完成日常购买理由，不写价格和销量。",
        interaction: "成年人推车、停车取物或买菜返回，人物/道具服务收纳便利。",
        avoidRepeat: "收尾必须是生活使用远景或取放动作，不回到车上安装英雄视角。"
      }
    ]);
    const detail = normalizeProofScripts([
      main[0],
      main[1],
      main[3],
      main[2],
      main[4],
      {
        sellingPoint: "通勤买菜都能装",
        productForm: "通勤、买菜、接送或短途骑行三格/四格分区，均使用同一款车篮。",
        proofMethod: "用不同生活物品和场景证明适配范围，避免杂乱堆满。",
        interaction: "可出现手部放包、取头盔或整理雨衣。",
        avoidRepeat: "必须是多场景组合版，不能做单一车篮大图。"
      },
      {
        sellingPoint: "细节扎实更耐看",
        productForm: "篮筐边缘、盖面纹理、固定扣、连接带或支架的超近景组合。",
        proofMethod: "用材质肌理和结构细节建立信任，不写材质等级或测试报告。",
        interaction: "手部轻触边缘或固定扣即可，避免夸张拉扯。",
        avoidRepeat: "本张只做细节信任，不重复第4张固定结构近景的同一角度。"
      },
      main[4]
    ]);
    return {
      archetype: "骑行收纳配件：安装全貌、打开装载、闭合防水、固定结构、生活取放必须分屏呈现。",
      globalRule: "车篮/篮筐全套图必须围绕同一主体的不同使用形态证明卖点，禁止把其他不相关品类示例词或家清耗材类内容带入。禁止多张重复同一车头全貌或同一打开装载构图。",
      main,
      detail
    };
  }
  if (/垃圾袋|trash bag/i.test(text)) {
    const main = normalizeProofScripts([
      {
        sellingPoint: point(0, "500只囤货装"),
        productForm: "未展开卷装堆叠 + 包装主视觉；只展示卷装、包装和少量艾草/收纳道具，不出现右侧打开袋或套桶。",
        proofMethod: "用卷装数量、包装文字和整齐囤货陈列证明数量多、好收纳和艾草祛味第一印象。",
        interaction: "可加入手部从收纳盒拿起一卷，或艾草叶/浅绿气味线作为辅助。",
        avoidRepeat: "本张禁止使用“左边卷装 + 右边打开袋/垃圾桶”的双主体模板。"
      },
      {
        sellingPoint: point(1, "一拉收口不脏手"),
        productForm: "单只垃圾袋已经套入桶内，白色抽绳被手部拉起形成收口动作。",
        proofMethod: "用拉绳、袋口收紧和可提起的动作证明抽绳便利。",
        interaction: "成年人手部拉绳，干净厨房垃圾桶做支撑，可加三步小箭头。",
        avoidRepeat: "镜头必须贴近袋口动作，不能再做卷装堆叠英雄图。"
      },
      {
        sellingPoint: point(2, "厨余杂物更能装"),
        productForm: "单只袋身完整展开并套入大号厨房桶，袋内可见日常厨余和包装杂物。",
        proofMethod: "用展开袋身、桶内容量和不外溢的满桶状态证明大容量。",
        interaction: "可出现手部把厨余倒入袋内，但不要表现直接倒沸水。",
        avoidRepeat: "构图要从桶内/侧上方看容量，不能重复第2张拉绳动作。"
      },
      {
        sellingPoint: point(3, "加厚袋身不易破漏"),
        productForm: "袋口抽绳、袋身边缘、袋底承托三处近景；可辅以小图展示装满提起。",
        proofMethod: "用微距纹理、边缘厚实感、袋底受力和局部放大圈证明结实。",
        interaction: "手部轻拉袋边或提起装满袋，动作克制真实。",
        avoidRepeat: "本张必须是细节/微距证明，不做整桶远景或卷装陈列。"
      },
      {
        sellingPoint: point(4, "日常换袋更省心"),
        productForm: "家庭收纳柜/厨房抽屉内多卷未展开垃圾袋整齐囤放，手部取出一卷。",
        proofMethod: "用收纳状态和多卷数量证明大包装囤货、日常换袋更省心。",
        interaction: "收纳柜、抽屉、手部取用和干净厨房空间服务囤货卖点。",
        avoidRepeat: "收尾用收纳/取用状态，禁止回到第1张同角度卷装堆叠。"
      }
    ]);
    const detail = normalizeProofScripts([
      main[0],
      {
        sellingPoint: "艾草祛味防臭",
        productForm: "垃圾桶旁的抽绳垃圾袋 + 艾草叶/绿色气味线；产品清楚可见。",
        proofMethod: "用清新视觉符号表达祛味，不写杀菌、除菌率或医学功效。",
        interaction: "厨房台面或垃圾桶边，可有手部准备更换袋子。",
        avoidRepeat: "不要沿用首屏卷装陈列，重点换成气味顾虑。"
      },
      main[1],
      main[2],
      main[3],
      {
        sellingPoint: "装满提起也稳",
        productForm: "装满后的垃圾袋离开垃圾桶，底部完整下垂但不破漏。",
        proofMethod: "用手提满袋的受力动作证明耐装，不写具体KG数。",
        interaction: "成年人手部提袋，背景为厨房桶或卫生间桶。",
        avoidRepeat: "动作证据优先，不能只拍静物细节。"
      },
      {
        sellingPoint: "家里多处都适用",
        productForm: "厨房、卫生间、办公室三处小场景分区，均为同一款袋身状态。",
        proofMethod: "用不同垃圾桶和空间证明适配范围，商品保持主角。",
        interaction: "手部更换、取用或套袋动作任选其一，避免杂乱。",
        avoidRepeat: "必须使用多场景分区，不能做单一垃圾桶大图。"
      },
      main[4]
    ]);
    return {
      archetype: "消耗品/可展开产品：卷装、展开、套桶、收口、提起、收纳必须分屏呈现。",
      globalRule: "垃圾袋全套图必须按产品形态链拆分卖点证据，禁止多张重复“左卷装 + 右打开袋/垃圾桶”的双主体构图。",
      main,
      detail
    };
  }
  if (context.isUmbrella) {
    const main = normalizeProofScripts([
      {
        sellingPoint: point(0, "晴雨两用更安心"),
        productForm: "同一把伞完全撑开，伞面、包边、伞柄和整体比例清楚。",
        proofMethod: "用大伞面和雨滴/阳光环境证明防护感。",
        interaction: "可由手部撑伞，但商品占主画面。",
        avoidRepeat: "只允许首图使用大伞面英雄构图，后续不能重复同角度撑开伞。"
      },
      {
        sellingPoint: point(1, "折叠便携好收纳"),
        productForm: "伞折叠收起并带束带/挂绳，放在手中或包旁。",
        proofMethod: "用折叠体积和包内取放证明便携。",
        interaction: "手部从背包/托特包取出折叠伞。",
        avoidRepeat: "必须是折叠形态，不能出现完整撑开伞面。"
      },
      {
        sellingPoint: point(2, "出门挡雨更从容"),
        productForm: "伞撑开并被人手持在雨天通勤场景中。",
        proofMethod: "用真实挡雨动作证明使用价值。",
        interaction: "人物可只露手部/背影，伞和雨滴是证据。",
        avoidRepeat: "场景为动态通勤，区别首图棚拍英雄。"
      },
      {
        sellingPoint: point(3, "伞骨伞柄细节看得见"),
        productForm: "伞骨、伞柄、包边、束带或挂绳近景。",
        proofMethod: "用微距和局部放大圈证明结构细节。",
        interaction: "手部可轻扶伞骨或握柄。",
        avoidRepeat: "本张只做结构近景，不做完整伞远景。"
      },
      {
        sellingPoint: point(4, "随身携带更省心"),
        productForm: "折叠伞放入背包侧袋/车门储物格/玄关收纳。",
        proofMethod: "用收纳状态完成购买理由。",
        interaction: "手部取放，背包或玄关道具无品牌。",
        avoidRepeat: "收尾用收纳/携带状态，不回到撑开伞英雄构图。"
      }
    ]);
    return {
      archetype: "可展开/可折叠产品：折叠、撑开、手持、收纳和结构细节必须分屏。",
      globalRule: "雨伞全套必须在折叠态、打开态、手持挡雨、放包收纳、伞骨伞柄细节之间切换，禁止只换背景的同角度撑开伞。",
      main,
      detail: [
        ...main,
        {
          sellingPoint: "多角度结构证明",
          productForm: "撑开伞面、折叠侧面、伞柄、包边四宫格。",
          proofMethod: "用分区信息图展示同一把伞的多形态。",
          interaction: "不需要人物，重点是结构清楚。",
          avoidRepeat: "多宫格必须区别单张主视觉。"
        },
        main[2],
        main[4]
      ]
    };
  }
  if (/椅|凳|chair|stool/i.test(text)) {
    const main = normalizeProofScripts([
      {
        sellingPoint: point(0, "轻便小椅子"),
        productForm: "空椅完整静态，全貌、靠背、坐垫、椅腿和滚轮清楚。",
        proofMethod: "用产品全貌和空间比例证明小巧轻便。",
        interaction: "无人物或只用小比例手部辅助，商品占主画面。",
        avoidRepeat: "首图为完整全貌，后续不能只换房间摆同一把空椅。"
      },
      {
        sellingPoint: point(1, "坐下也舒服"),
        productForm: "真人坐在同一把椅子上，靠背和坐垫承托关系清楚。",
        proofMethod: "用坐姿和身体比例证明舒适。",
        interaction: "成年用户侧身或背影坐姿，人物服务椅子。",
        avoidRepeat: "必须有人体使用，不做空椅静物。"
      },
      {
        sellingPoint: point(2, "移动顺滑不费力"),
        productForm: "椅子在书桌/梳妆台旁被手部轻推，滚轮接触地面。",
        proofMethod: "用移动轨迹和滚轮方向证明轻便移动。",
        interaction: "手推椅背或坐姿微移，地面干净。",
        avoidRepeat: "镜头低角度突出滚轮，不重复坐姿大图。"
      },
      {
        sellingPoint: point(3, "靠背坐垫细节清楚"),
        productForm: "靠背弧线、坐垫缝线、滚轮局部近景。",
        proofMethod: "用微距和局部放大圈证明结构和做工。",
        interaction: "手部可轻按坐垫或扶靠背。",
        avoidRepeat: "本张是细节证明，不能拍完整房间空椅。"
      },
      {
        sellingPoint: point(4, "桌边使用更顺手"),
        productForm: "椅子放在书桌、梳妆台或儿童学习桌旁形成适配场景。",
        proofMethod: "用桌边高度和空间关系证明实用。",
        interaction: "可有用户拉开椅子准备坐下。",
        avoidRepeat: "收尾换成桌边场景，区别首图全貌。"
      }
    ]);
    return {
      archetype: "固定形态家具：静态全貌、真人使用、移动动作、结构细节、空间适配必须分屏。",
      globalRule: "固定形态商品不能只换背景摆拍，必须用静态优点和动态互动共同证明卖点。",
      main,
      detail: [
        ...main,
        main[3],
        main[2],
        main[4]
      ]
    };
  }
  if (context.isSneaker || context.isFootwear || context.isApparel || context.isPants) {
    const main = normalizeProofScripts([
      {
        sellingPoint: point(0, "外观清楚更好选"),
        productForm: "干净静物全貌，商品轮廓、颜色和关键结构清楚。",
        proofMethod: "用完整外观建立第一识别。",
        interaction: "不需要人物，或只用少量搭配道具。",
        avoidRepeat: "首图为静物全貌，后续必须进入穿着或动作。"
      },
      {
        sellingPoint: point(1, "穿着状态更直观"),
        productForm: "同一商品上身/上脚，人体比例和穿着关系清楚。",
        proofMethod: "用真实穿着证明版型、脚感或搭配。",
        interaction: "人物局部或全身服务商品。",
        avoidRepeat: "必须有人体穿着，不能重复静物摆放。"
      },
      {
        sellingPoint: point(2, "动起来也舒服"),
        productForm: "走动、跑步、坐下或伸展动作中的同一商品。",
        proofMethod: "用动态姿态证明舒适、轻便、灵活或稳定。",
        interaction: "身体动作是主要证据。",
        avoidRepeat: "动作画面区别第2张站立穿着。"
      },
      {
        sellingPoint: point(3, "材质细节看得见"),
        productForm: "面料、鞋面、鞋底、走线、腰头或边缘近景。",
        proofMethod: "用微距和局部放大圈证明材质/结构。",
        interaction: "手部可轻触或拉伸，但不夸张。",
        avoidRepeat: "本张为细节近景，不做全身穿搭。"
      },
      {
        sellingPoint: point(4, "日常搭配更省心"),
        productForm: "衣橱、玄关、街区或收纳场景中的同一商品。",
        proofMethod: "用搭配/收纳/出门状态完成购买理由。",
        interaction: "人物准备出门、拿取或搭配。",
        avoidRepeat: "收尾必须换空间和镜头距离。"
      }
    ]);
    return {
      archetype: "穿戴类产品：静物、穿着、动作、材质和搭配必须分屏。",
      globalRule: "穿戴类不能只拍产品静物，必须用人体穿着与动态动作证明卖点，同时保留商品细节。",
      main,
      detail: [
        ...main,
        main[3],
        main[2],
        main[4]
      ]
    };
  }
  const main = normalizeProofScripts([
    {
      sellingPoint: point(0, plan.primaryPoint),
      productForm: "商品完整全貌，真实颜色、结构、比例和关键识别点清楚。",
      proofMethod: "用大商品和干净背景建立品类与第一卖点。",
      interaction: "人物或道具只做小比例辅助。",
      avoidRepeat: "首图使用完整全貌，后续不能只换背景重复同一姿态。"
    },
    {
      sellingPoint: point(1, plan.secondaryPoint),
      productForm: "商品进入真实使用动作：打开、拿取、摆放、携带、穿戴、清洁、收纳或操作中选择符合物理逻辑的一种。",
      proofMethod: "用动作让卖点被看见，而不是只写文案。",
      interaction: "优先加入手部或目标用户局部动作。",
      avoidRepeat: "必须和首图在商品状态、镜头距离、背景上明显不同。"
    },
    {
      sellingPoint: point(2, plan.tertiaryPoint),
      productForm: "商品在目标人群生活空间中完整出现。",
      proofMethod: "用场景和道具证明使用理由。",
      interaction: "人物、手部或环境道具服务本卖点。",
      avoidRepeat: "不要复用第2张动作证据，改用空间代入。"
    },
    {
      sellingPoint: point(3, plan.detailFocus),
      productForm: "商品局部细节近景。",
      proofMethod: "用材质、结构、边缘、接口、包装或纹理证明信任。",
      interaction: "可用手部轻触或局部放大圈。",
      avoidRepeat: "本张必须是近景细节，不能拍完整大场景。"
    },
    {
      sellingPoint: point(4, plan.primaryPoint),
      productForm: "收纳、携带、搭配、摆放或使用后状态。",
      proofMethod: "用结束状态完成购买理由。",
      interaction: "可出现手部取放或环境结果。",
      avoidRepeat: "收尾构图必须区别首图，使用更远景/俯拍/留白。"
    }
  ]);
  return {
    archetype: "通用商品：全貌、动作、场景、细节、收尾状态必须分屏。",
    globalRule: "每张图都必须使用不同产品形态、不同证明方式和不同镜头距离，禁止同一构图换文案。",
    main,
    detail: [
      ...main,
      {
        sellingPoint: "多角度证明",
        productForm: "正面、侧面、背面/顶部和局部细节组合。",
        proofMethod: "用分区信息图补充理解商品结构。",
        interaction: "不需要人物，保持产品信息清楚。",
        avoidRepeat: "多角度组合必须区别单张静物。"
      },
      main[2],
      main[4]
    ]
  };
}

function normalizeProofScripts(scripts: ProofScreenScript[]): ProofScreenScript[] {
  return scripts.map((script) => ({
    sellingPoint: script.sellingPoint || "本屏核心卖点",
    productForm: script.productForm || "商品清楚可见的不同形态",
    proofMethod: script.proofMethod || "用可见动作、细节或场景证明卖点",
    interaction: script.interaction || "辅助元素只服务卖点",
    avoidRepeat: script.avoidRepeat || "和相邻图片在构图、状态和镜头距离上明显不同"
  }));
}

function proofScriptToPrompt(script: ProofScreenScript): string {
  return [
    `卖点证明矩阵：本张只证明“${script.sellingPoint}”。`,
    `产品形态：${script.productForm}`,
    `证明方式：${script.proofMethod}`,
    `互动/辅助元素：${script.interaction}`,
    `禁止重复：${script.avoidRepeat}`
  ].join(" ");
}

function buildProductFormDiversityRule(task: ProductTask, context: ProductContext): string {
  const pointSeeds = filterCategoryCompatibleSellingPoints(task, cleanBusinessPhrases(splitList(task.sellingPoints)));
  const specSeeds = cleanBusinessPhrases(splitList(task.specs));
  const plan = buildGenericCopyPlan(task, pointSeeds, specSeeds);
  const matrix = buildProductProofMatrix(task, context, plan);
  return [
    `卖点证明矩阵全局规则：${matrix.archetype}`,
    matrix.globalRule,
    "执行顺序：先确定本张卖点，再选择产品形态，再安排可见证据，最后检查和上一张/下一张是否重复。",
    "审核标准：如果多张图都是同一产品摆位、同一背景、同一打开/未打开状态、同一“左静物右使用”模板，即使文案不同也视为低质量。"
  ].join("\n");
}

function pickPoint(points: string[], pattern: RegExp, fallback: string): string {
  return cleanVisibleCopy(points.find((point) => pattern.test(point)) || "") || fallback;
}

function pickConcretePoint(
  points: string[],
  concretePattern: RegExp,
  broadPattern: RegExp,
  fallback: string
): string {
  const selected = points.find((point) => concretePattern.test(point))
    || points.find((point) => broadPattern.test(point))
    || "";
  return normalizeVisualSellingPoint(cleanVisibleCopy(selected)) || fallback;
}

function normalizeVisualSellingPoint(value: string): string {
  return value
    .replace(/^环保材质$/, "环保材质更放心")
    .replace(/^隔热不烫手$/, "隔热握持不烫手")
    .replace(/^纯棉(?:材料|材质)?$/, "棉感纹理看得见")
    .replace(/^多种颜色可选$/, "多色可选好区分");
}

function cleanVisibleCopy(value: string | undefined): string {
  const clean = (value ?? "").trim().replace(/[，,。；;、]+$/g, "");
  if (isPlaceholderCopy(clean)) return "";
  if (/场景|使用场景|睡眠场景|运动场景|洗衣场景|卧室睡眠|户外运动|衣橱场景|厨房场景|浴室场景|办公场景/.test(clean)) return "";
  return containsTemplateVisibleCopyTerm(clean) ? "" : clean;
}

function cleanEnglishVisibleCopy(value: string | undefined): string {
  const clean = (value ?? "")
    .trim()
    .replace(/[，,。；;、]+$/g, "")
    .replace(/\s+/g, " ");
  if (!clean) return "";
  if (clean.length > 64 || clean.includes("?")) return "";
  if (!isMostlyEnglishText(clean)) return "";
  if (containsCjk(clean)) return "";
  if (isEnglishVisibleCopyForbidden(clean)) return "";
  if (containsTemplateVisibleCopyTerm(clean)) return "";
  return clean;
}

function containsTemplateVisibleCopyTerm(value: string): boolean {
  const clean = value.toLowerCase();
  return TEMPLATE_VISIBLE_COPY_TERMS.some((term) => clean.includes(term.toLowerCase()));
}

function firstEnglishVisibleLine(values: Array<string | undefined>): string {
  for (const value of values) {
    const clean = cleanEnglishVisibleCopy(value);
    if (clean) return clean;
  }
  return "";
}

function uniqueNonEmpty(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const clean = value.trim();
    if (clean && !result.includes(clean)) result.push(clean);
  }
  return result;
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function isEnglishVisibleCopyForbidden(value: string): boolean {
  return [
    /not provided/i,
    /do not invent/i,
    /unsupported/i,
    /amazon shoppers/i,
    /practical everyday products/i,
    /target platform/i,
    /output language/i,
    /generate detail/i,
    /product name/i,
    /category/i,
    /brief/i,
    /prompt/i,
    /schema/i,
    /workflow/i,
    /user input/i,
    /reference image/i,
    /competitor logos/i,
    /platform watermarks/i,
    /fake certifications/i,
    /best seller/i,
    /sales volume/i,
    /performance claims?/i,
    /^or\s+/i
  ].some((pattern) => pattern.test(value));
}

function isEnglishSpecPlaceholderFragment(value: string): boolean {
  const normalized = value.trim().replace(/[.。；;，,]+$/g, "").replace(/^or\s+/i, "");
  return /^(dimensions?|test data|certifications?|materials?|price|sales volume|performance claims?|claims?|technical claims?|ratings?|reviews?)$/i.test(normalized);
}

function softenAbsoluteSafetyPoint(value: string): string {
  return value
    .replace(/对人体无毒/g, "按说明使用更安心")
    .replace(/人体无毒/g, "按说明使用更安心")
    .replace(/无毒/g, "按说明使用更安心");
}

function usefulSpecCopy(specs: string[], context?: ProductContext): string {
  const spec = cleanBusinessPhrases(specs).find((item) => {
    if (/^(无|暂无|没有|未提供)$/i.test(item)) return false;
    if (context?.isEnglishMarketplace) return Boolean(cleanEnglishVisibleCopy(item)) && !isEnglishSpecPlaceholderFragment(item);
    return true;
  });
  return spec || "";
}

function targetSceneLabel(task: ProductTask, context: ProductContext): string {
  if (context.isEnglishMarketplace) {
    const text = [task.productName, task.category, task.sellingPoints, task.notes].join(" ");
    if (context.isSneaker || context.isFootwear || isEnglishFootwearText(text)) return "Work And Casual Wear";
    if (context.isUmbrella) return "Commute And Travel";
    if (context.isBikeBasket) return "Commute And Grocery Runs";
    if (context.isCup) return "Desk And Travel";
    if (/oregano\s*oil|dietary\s*supplement|supplement|softgels?|capsules?/i.test(text)) return "Everyday Supplement Routine";
    if (context.isPants || context.isApparel) return "Daily Outfit";
    return "Everyday Use";
  }
  const identityText = [task.productName, task.category, task.sellingPoints, task.notes].join(" ");
  if (/垃圾袋|trash bag/i.test(identityText)) return "家庭清洁日常";
  if (context.isBikeBasket) return "骑行通勤日常";
  if (context.isAdultAudience) return "成人日常";
  const targetAudience = usefulTargetAudience(task);
  if (targetAudience) return targetAudience.replace(/[，,。；;、]+$/g, "").replace(/场景/g, "日常");
  if (task.category) return `${task.category}日常`;
  return "日常使用";
}

function productDetailFocus(task: ProductTask, context: ProductContext): string {
  const text = [task.productName, task.category, task.sellingPoints, task.notes].join(" ");
  if (context.isEnglishMarketplace) {
    if (context.isSneaker || context.isFootwear || isEnglishFootwearText(text)) return "Upper And Outsole";
    if (context.isUmbrella) return "Canopy And Handle";
    if (context.isBikeBasket) return "Cover And Mount";
    if (context.isCup) return "Lid And Body";
    if (context.isPants || context.isApparel) return "Fabric And Fit";
    if (context.isPillow) return "Support And Texture";
    if (/oregano\s*oil|dietary\s*supplement|supplement|softgels?|capsules?/i.test(text)) return "Capsule And Package";
    return "Product";
  }
  if (/垃圾袋|trash bag/i.test(text)) return "抽绳袋口与袋身细节";
  if (context.isBikeBasket) return "防水盖、固定扣和篮筐边缘细节";
  if (context.isPillow) return "透气孔与曲线细节";
  if (context.isLaundryDetergent) return "瓶身标签细节";
  if (context.isSneaker) return "鞋面与鞋底细节";
  if (context.isPants) return "腰头抽绳与面料纹理细节";
  if (context.isApparel) return "版型面料与做工细节";
  if (context.isStudentBackpack) return "肩带前袋与外观细节";
  if (context.isBabyCare) return "包装与吸收层细节";
  if (context.isCuttingBoard) return "乌檀木纹与边角细节";
  if (context.isMagneticLifter) return "吊环手柄与机身标签细节";
  if (/(包装|礼盒|月饼|食品|零食|茶|咖啡)/.test(text)) return "包装细节";
  if (/(袜|衣|裤|裙|布|巾|面料|织物|棉)/.test(text)) return "织纹细节";
  if (/(药|蟑螂|清洁|工具|电器|杯|瓶)/.test(text)) return "结构细节";
  return context.isAdultAudience ? "版型细节" : "商品细节";
}

function buildGenericDetailShotPrompts(task: ProductTask, plan: GenericCopyPlan): string[] {
  const context = productContext(task);
  if (context.isBikeBasket && context.isEnglishMarketplace) {
    return [
      "Hero opening: show the same e-bike/bicycle front basket mounted on the handlebar area, with cover, basket body, and mounting position clear. Clean marketplace composition, no fake ratings or test badges.",
      "Capacity proof: open the basket and place a helmet, raincoat, gloves, grocery bag, or commute essentials inside. Use hands for scale and keep the basket dominant.",
      "Rain-ready proof: show the cover closed with water beads or a rainy commute cue. Express water-resistant storage visually without inventing a waterproof rating.",
      "Mount detail: close up on buckle, strap, rim, support bracket, or handlebar connection. Use callout lines or magnifier details, not a generic product still life.",
      "Easy access: show a rider or hand placing items in and taking them out near a parking spot, grocery stop, or building entrance.",
      "Multi-use layout: create a clean split-grid for commute, grocery run, rain gear, and helmet storage, all using the same basket identity.",
      "Detail confidence: show rim texture, cover surface, connection details, and basket structure in macro views. Do not add unsupported material grades or load numbers.",
      "Closing hero: return to a stable bike-mounted basket image with helmet/raincoat nearby, using a different crop and distance from the first screen."
    ];
  }
  if (context.isEnglishMarketplace) {
    return [
      "Hero opening: place the product large and clear in a clean marketplace-style composition. Use a fresh camera angle and enough negative space for short English copy.",
      "Buyer concern scene: show the product solving a practical everyday use case. Add hands, a home/work/travel environment, or relevant props only when they help prove the benefit.",
      "Feature proof: use a close product angle, hand interaction, structure view, or callout magnifier to make the primary benefit visible. Do not invent data or certification badges.",
      "Lifestyle fit: show the product in a credible real-life setting for the target buyer. The product must stay complete, recognizable, and visually dominant.",
      "Detail confidence: use macro texture, edge, handle, surface, outsole, fabric, connector, or packaging details as appropriate. Keep labels minimal and English only.",
      "Multi-angle proof: show front, side, back, top, bottom, or component views in a clean grid or layered composition. Keep the same product identity across all views.",
      "Decision reason: summarize the practical reason to choose it with restrained English copy and a scene that differs from earlier screens.",
      "Closing hero: return to a stable product-first image with clean whitespace, but use a different crop, distance, or angle from the first screen."
    ];
  }
  const identityText = [
    task.productName,
    task.category,
    task.targetAudience,
    task.sellingPoints,
    task.notes
  ].join(" ");
  if (context.isBikeBasket) {
    return [
      "骑行收纳首屏：同一款电动车/自行车篮筐安装在车头或车把前端，篮身、防水盖/罩、固定位置和整体比例清楚；用干净骑行场景建立防水大容量第一印象。",
      "容量证明屏：篮筐打开，放入头盔、雨衣、小型买菜袋、手套或通勤杂物，手部正在整理；用真实物品比例证明能装，不写虚构升数。",
      "雨天防护屏：防水盖/罩闭合，盖面和边缘贴合清楚，有少量水珠或雨后路面；表达雨天放物安心，不写防水等级。",
      "固定结构屏：固定扣、连接带、篮筐边缘、车把连接处或支架近景，局部放大圈标注；证明骑行路上稳稳放，不写承重KG。",
      "取放便利屏：小区门口、菜市场门口或通勤停车点，手部从篮筐取出买菜袋、背包或雨衣；商品完整清楚。",
      "多场景适用屏：通勤、买菜、接送、短途骑行三到四个分区，同一款篮筐稳定出现，场景服务收纳用途。",
      "细节信任屏：篮筐边缘、防水盖面、固定扣和连接处微距组合，展示结构和材质观感，不新增材质等级或检测认证。",
      "收尾骑行英雄图：同一款篮筐安装完成，旁边有头盔和雨衣作为使用提示，构图更远更留白，区别第1屏。"
    ];
  }
  if (/垃圾袋|trash bag/i.test(identityText)) {
    return [
      "未展开卷装囤货首屏：多卷绿色垃圾袋和包装主视觉整齐陈列，强调 500只 与艾草祛味；只用卷装/包装/艾草叶，不出现右侧打开袋或套桶，和后续动作屏拉开差异。",
      "异味顾虑屏：垃圾桶旁的同款袋身和清新绿色气味线/艾草元素同框，表达祛味防臭；不写杀菌、除菌率或医学功效。",
      "抽绳动作屏：分步骤或近景展示手部拉起白色抽绳、袋口收紧、提走，重点是“一拉收口不脏手”。",
      "容量证明屏：单只袋身完整套入厨房垃圾桶，袋内有日常厨余和包装杂物，满桶但不外溢；不写虚构升数。",
      "加厚细节屏：袋口、袋身边缘、袋底和抽绳连接处微距，局部放大圈证明不易破漏；不写厚度数值。",
      "承重动作屏：手提装满后的垃圾袋离开桶，底部完整、袋身自然受力；不写具体KG数或检测认证。",
      "多处适用屏：厨房、卫生间、办公室三个小场景分区展示同款垃圾袋，商品清楚，不让环境抢主体。",
      "收尾囤货屏：家庭收纳柜/厨房抽屉中多卷未展开垃圾袋整齐囤放，手部取出一卷，表达日常换袋更省心。"
    ];
  }
  if (/(月饼|中秋|礼盒|送礼|团圆)/.test(identityText)) {
    return [
      "大号礼盒正面英雄图，三分之二画面给礼盒，前景只放一小盘月饼和茶盏，低平视角建立送礼体面感；不要和第2屏使用同一构图。",
      "送礼顾虑场景，成年人双手托起礼盒或礼盒放在拜访玄关/客厅茶几上，镜头从人物手部侧前方拍摄，表现“拿得出手”；不能只是礼盒正面站在桌上。",
      "开盒证明屏，45度俯拍打开礼盒，露出内部排列和月饼，手部正在开盒或轻扶盒盖，重点是开盒仪式感。",
      "团圆餐桌远景，家人围坐或亲友茶桌分享月饼，礼盒在桌面一侧清楚可见，镜头拉远，和前几屏静物近景区分。",
      "礼盒包装微距，超近景拍盒面图案、浮雕/印刷纹理、边角结构，可用两个圆形局部放大，不出现整盒同角度重复。",
      "多角度信息版，俯拍外盒、侧面厚度、打开后的内盒、小盘月饼四个分区组合，形成画册式信息屏。",
      "节日拜访场景，成年人手持礼盒走近门口/递给亲友/放到礼品桌，强调送礼动作，背景与团圆餐桌不同。",
      "收尾静物远景，礼盒置于中式窗格或茶席留白中，采用更远景或俯拍静物，构图区别第1屏。"
    ];
  }
  if (/(袜|袜子|短袜|船袜|女袜)/.test(identityText)) {
    return [
      "床面或衣橱浅色布景英雄图，三双袜子展开成扇形或前后层次，平视略俯拍，突出颜色和简约好看；不要出现上脚模特。",
      "用户顾虑场景，女生在床边/衣橱前挑袜子，手拿一双袜子准备搭配，镜头从肩后或手部侧拍，商品和穿搭衣物同框。",
      "材质证明屏，手指轻捏袜口或拉开袜身，超近距离展示纯棉织纹触感，必须有人手动作，不是静物平铺。",
      "上脚穿搭场景，女生腿部穿着袜子搭配裙装或休闲鞋，半身/腿部中景，袜子在脚上，和前面静物/手持屏明显不同。",
      "袜口脚尖微距，宏观近景展示袜口罗纹、脚尖走线和织纹，使用两个局部放大圈，背景极简。",
      "多场景组合版，使用三到四个小画面：通勤鞋、居家拖鞋、裙装、裤装搭配，外加一处袜子细节小图；不要单张大静物。",
      "衣橱收纳/搭配决策场景，袜子叠放在抽屉或衣橱格中，旁边有无品牌包和衣物，镜头俯拍，强调常备和好搭。",
      "收尾英雄静物，三双袜子在干净台面或床面排成稳定品牌画面，采用更远景和大留白，区别第1屏的扇形陈列。"
    ];
  }
  if (/(蟑螂|杀蟑|灭蟑|蟑螂药|虫害)/.test(identityText)) {
    return [
      "厨房台面英雄图，包装盒和药管正面清楚，占画面主体，背景是干净厨房，不出现蟑螂特写恐吓，平视角建立家庭适用。",
      "用户顾虑场景，低机位拍橱柜底部或墙角阴影，远处有包装盒作辅助，一处小圆形示意蟑螂问题即可，不能重复台面正面产品图。",
      "使用动作证明，成年人手部拿药管在墙角/柜脚缝隙点涂或摆放，镜头贴近手部动作，包装盒只做小比例辅助。",
      "厨卫角落场景，产品放在卫生间台盆下、厨房踢脚线或冰箱侧边，低角度展示真实摆放位置，和第3屏手部操作区别。",
      "包装信息微距，近景拍包装盒正面、药管口、净含量/标签区域，使用局部放大圈，背景干净，不出现新的功效数据。",
      "家庭重点区域组合版，三到四个小图分别展示厨房水槽下、橱柜角、卫生间墙角、门边缝隙，形成场景地图感。",
      "安全摆放决策场景，产品放在高处或远离儿童宠物活动区域的角落，画面出现门栏/收纳柜等空间关系，强调按说明使用。",
      "收尾清爽厨房远景，明亮整洁的厨房或客厅角落，产品在前景清楚但背景更开阔，区别第1屏台面英雄构图。"
    ];
  }
  if (/(风扇|小风扇|手持风扇|随身风扇|电风扇|迷你风扇)/.test(identityText)) {
    return [
      "户外夏日英雄图，薄荷绿手持风扇大号清晰呈现，蓝天或浅色户外背景，商品占主体，黄色爱心和猫脸表情必须可见。",
      "用户顾虑场景，炎热通勤/排队/公园步道中，成年模特手持风扇靠近脸侧吹风，镜头从手部和风扇侧前方拍摄，表现怕热时随手使用。",
      "续航卖点证明屏，风扇放在户外桌面或包旁，旁边用简洁时间感图形表达“约1小时”，不画复杂参数表，不虚构更长时间。",
      "便携场景屏，风扇放入小包、托特包或通勤包侧袋，手部正在取放，表现小巧不占地，和第2屏手持吹风动作区别。",
      "扇罩按键微距，超近景拍圆形扇罩、扇叶、开关键、猫脸表情和黄色爱心装饰，可用两个局部放大圈。",
      "多角度信息版，用俯拍、侧拍、手持大小对比、放包场景四个分区展示，形成品牌画册式信息屏。",
      "充电补能场景，风扇放在桌面用无品牌充电线连接，旁边有太阳镜/水杯等夏日道具，强调出门前准备，不出现虚构快充数值。",
      "收尾清爽夏日远景，薄荷绿风扇在浅蓝天空/户外长椅/野餐布前景清楚，构图更远更留白，区别第1屏大商品英雄。"
    ];
  }
  if (/(阔腿裤|宽腿裤|休闲裤|卫裤|运动裤|家居裤|女裤|裤子|长裤|裤装|拖地裤|九分裤|直筒裤|pants|trousers|wide leg)/i.test(identityText)) {
    return [
      "裤装英雄首屏，当前商品图里的真实裤型、颜色、腰头、抽绳、裤腿宽度、裤脚和面料纹理必须清楚；优先用模特全身实穿或衣架/平铺完整展示，产品占主画面，若参考图有两色可做主次双裤并列。",
      "用户顾虑场景，成年女性在家中镜前、衣橱旁或咖啡店外自然站立/走动，镜头展示裤腿宽松但不拖沓，回答怕勒腿、怕显臃肿、怕不好搭的购买顾虑；不能重复第1屏正面静物。",
      "版型证明屏，模特走动、坐下或侧身站立，裤腿垂顺线条和腰头松紧关系清楚；用真实身体动作证明宽松自在，不做夸张拉伸或虚构弹力测试。",
      "居家通勤场景屏，同一条裤子搭配简单上衣，在客厅、衣橱、街区或咖啡店门口自然出现，表现出门在家都能穿；商品必须在下半身视觉中心，背景不能比裤子抢眼。",
      "腰头抽绳与面料微距，超近景展示松紧腰头、抽绳绳头、面料纹理、裤脚走线和裤腿垂感，可用局部放大圈和细线；所有细节来自同一款裤子。",
      "多角度信息版，用正面全长、侧面裤腿、腰头抽绳、裤脚走线四个分区展示同一款裤子；若参考图有两色，展示两色对比但不得新增不存在颜色。",
      "衣橱搭配决策场景，裤子搭配无品牌上衣、包或鞋在衣橱/玄关/通勤出门前形成一套真实穿搭，强调好搭不费心；不做规格选择建议。",
      "收尾穿搭英雄图，模特或衣架远景留白展示同一款裤子，构图比第1屏更安静，统一暖白+浅木+炭黑/商品色系统，完成品牌收尾。"
    ];
  }
  if (/(衣服|服饰|女装|男装|上衣|外套|卫衣|针织衫|打底衫|T恤|t恤|裙|套装|穿搭|apparel|clothing|shirt)/i.test(identityText)) {
    return [
      "服装英雄首屏，当前商品图里的真实款式、颜色、版型、领口/袖口/下摆/图案和面料质感必须清楚；优先用完整实穿或平铺/衣架陈列，产品占主画面。",
      "用户顾虑场景，成年模特在衣橱、镜前或通勤出门前自然试穿，回答怕不好搭、怕版型不合适的购买顾虑；不能重复首屏静物角度。",
      "版型证明屏，用上身、侧身或动作展示轮廓和穿着关系，商品结构清楚，不做虚构科技参数。",
      "日常穿搭场景，商品搭配无品牌基础单品进入居家/通勤/街区空间，文案和画面都围绕日常好搭。",
      "面料做工微距，展示纹理、走线、边缘、纽扣/拉链/领口/袖口等当前商品真实细节，可用局部放大圈和细线。",
      "多角度信息版，用正面、侧面、背面/局部、面料四个分区展示同一款服饰，不新增不存在颜色或款式。",
      "衣橱搭配决策场景，服饰与无品牌衣架、上衣/裤装/包鞋合理同框，强调日常搭配更省心。",
      "收尾英雄远景，回到完整商品和稳定留白，构图区别第1屏，形成品牌系列结束感。"
    ];
  }
  if (/(尿布湿|尿不湿|纸尿裤|拉拉裤|婴儿尿裤|diaper)/i.test(identityText)) {
    return [
      "包装英雄图，尿布湿/纸尿裤外包装正面清楚，占画面主体，旁边只放一片干净折叠样片和浅色育儿台道具；不出现婴儿身体或换尿布动作。",
      "父母顾虑场景，成年父母手部在干净育儿台上整理包装和折叠样片，镜头从手部侧前方拍摄；婴儿可不出现，如出现只能穿完整衣物远景，不出现下半身特写。",
      "吸收表现证明屏，透明量杯或滴管把清水滴在干净样片表层，近景展示吸收过程和样片层次；不出现尿液、不出现婴儿身体、不做医疗或检测数据。",
      "育儿台收纳场景，包装和几片折叠样片放在收纳篮/抽屉旁，父母手部正在拿取，展示日常护理准备；背景是干净婴儿房或护理台。",
      "吸收层与包装细节微距，超近景展示样片表层纹理、折叠边缘、包装图案和原有文字，可用局部放大圈；不得改写包装文字。",
      "多角度信息版，用包装正面、侧面、折叠样片、样片表层四个分区展示，同一商品外观保持一致；不做参数表，不新增认证或数据。",
      "外出前准备场景，父母手部把包装或干净样片放入无品牌妈咪包/收纳袋，旁边是干净婴儿用品，表现日常准备更顺手。",
      "收尾育儿台远景，包装和干净样片在浅色育儿台上形成留白品牌画面，构图更远更安静，区别第1屏大商品近景。"
    ];
  }
  if (/(儿童保温杯|儿童水杯|儿童杯|保温杯|水杯)/.test(identityText) && /(儿童|孩子|小朋友|妈妈|上学|家庭)/.test(identityText)) {
    return [
      "大号儿童保温杯英雄图，黄盖、蓝色双把手、米色杯身、杯身卡通图案、JUMP 和 THERMOS 商品本体文字必须清楚；产品占主体，浅木餐桌或书桌背景只做辅助。",
      "妈妈选杯顾虑场景，家长手部在早餐餐桌或明亮厨房桌面旁拿起同一只儿童保温杯，8-10 岁儿童在旁边准备喝水，镜头从手部侧前方拍摄，表现放心选择；不能重复第1屏纯静物正面。",
      "耐热饮用证明屏，杯盖、杯口和打开动作近景，杯中可有温水蒸汽的轻微生活感，成人手部操作，商品文字和卡通图案仍保留；不写具体温度、保温时长或认证。",
      "儿童家庭场景屏，8-10 岁儿童在餐桌、书桌或作业本旁拿杯喝水/放杯；如果嘴巴靠近杯子或正在喝水，黄盖必须翻开并露出杯口/吸饮口，不能对着关闭的杯盖喝水；人物自然可露正脸但商品必须在前景清楚，和前面手部操作屏换空间换角度。",
      "杯盖把手细节微距，超近景展示黄色杯盖、蓝色双把手、杯身卡通图案和杯身文字，可用两个局部放大圈，不能把文字抹掉或改成乱码。",
      "多角度信息版，用俯拍、侧拍、杯盖开启、双把手握持四个分区展示同一只杯子，形成画册式信息屏；不做参数表，不新增无依据材质等级。",
      "上学携带场景，同一只杯子放在无品牌书包侧袋、课桌或学习区旁，8-10 岁儿童伸手取放，表现家里学校都适合；背景与餐桌场景不同。",
      "收尾生活英雄图，杯子放在干净书桌或早餐桌一角，旁边少量书本/餐盘/水壶道具无品牌，构图更远更留白，区别第1屏的大商品近景。"
    ];
  }
  if (/(水杯|杯子|杯壶|保温杯|PPSU|吸管杯)/i.test(identityText)) {
    return [
      "大号潮流水杯英雄图，透明杯身、浅蓝翻盖、白色吸管/直饮口、橙色防滑圈、黄色按钮、蓝色挂环/挂带、杯身彩色图案和刻度必须清楚；产品占主体，户外浅色背景只做辅助。",
      "年轻人出门喝水顾虑场景，手部把同一只水杯从无品牌帆布包、骑行包或户外桌面拿起，表现好看也顺手；不能重复第1屏纯静物正面。",
      "隔热饮用证明屏，杯盖翻开，白色吸管或杯口明确露出，年轻人手持水杯准备喝水或正在喝水；嘴巴只能靠近打开的吸管/杯口，禁止对着关闭杯盖喝水，不写具体温度、保温时长或检测数据。",
      "户外饮水场景屏，同一只水杯放在公园长椅、露营桌、城市步道或运动后休息场景中，盖子打开或半开，吸管/杯口可见；人物自然年轻，商品必须在前景清楚。",
      "杯盖吸管细节微距，超近景展示浅蓝翻盖、白色吸管/直饮口、黄色按钮、橙色防滑圈和开合结构；可用局部放大圈，不能把商品本体文字和图案改成乱码。",
      "多角度信息版，用正面杯身图案、侧面刻度、杯盖开启、挂环/挂带四个分区展示同一只水杯，形成品牌画册式信息屏；包装上的 Babycare、PPSU、500mL、36月+ 等本体文字如出现必须保持。",
      "出门携带决策场景，水杯与无品牌帆布包、运动毛巾、耳机盒或户外桌面合理同框，手部抓握挂环或杯身，表达随手带走；背景与前面喝水场景不同。",
      "收尾生活英雄图，水杯放在户外咖啡桌、公园台面或清爽窗边，构图更远更留白，区别第1屏大商品近景，统一年轻潮流配色。"
    ];
  }
  if (/(学生双肩背包|学生书包|双肩背包|书包|上学背包)/.test(identityText)) {
    return [
      "大号学生双肩背包英雄图，当前商品图里的真实包身颜色、图案、前袋、侧袋、肩带、拉链和挂件/配件如有必须清楚；产品占主体，浅木课桌或校园光影只做辅助。",
      "上学收纳顾虑场景，书包放在课桌或上学前玄关，拉链打开一部分，课本/作业本/无品牌水杯有序放入，表现孩子上学东西多但分区更清楚；不能重复第1屏纯静物正面。",
      "肩带轻便证明屏，同一名 8-13 岁学生背着书包走在校园步道或校门旁，参考图同款肩带自然受力，镜头从侧后方拍摄；不写护脊、减负科技或承重测试。",
      "校园上学场景屏，学生背着同一款书包在校门、教室座椅或课桌旁自然活动，书包完整清楚，和第3屏肩带近景换空间换角度。",
      "前袋侧袋细节微距，超近景展示当前商品图真实可见的前袋、侧袋、肩带、图案、拉链、织物和挂件/配件如有，可用两个局部放大圈，不能把图案改成其他样式。",
      "多角度信息版，用正面、侧面、背面肩带、前袋/配件细节四个分区展示同一款书包，形成画册式信息屏；不做容量参数表，不新增防水、防盗或护脊功能。",
      "上学收纳决策场景，课本、作业本、文具和无品牌水杯与书包合理同框，学生手部正在拿取前袋或侧袋，表现日常上学更从容；背景与第2屏不同。",
      "收尾校园远景，书包放在校园长椅/教室椅背/浅木课桌旁，构图更远更留白，统一暖白校园光线，区别第1屏大商品近景。"
    ];
  }
  if (/(枕头|睡眠枕|乳胶枕|护颈枕|颈椎枕|枕芯)/.test(identityText)) {
    return [
      "卧室床品英雄图，奶油白波浪曲线枕头完整清楚，占画面主体，密集透气孔和高低曲线能看见，浅色床单和自然晨光只做辅助。",
      "睡前顾虑场景，成年人躺下前调整枕头或坐在床边准备入睡，镜头从床侧低角度拍摄，表现枕头承托重要性；不要写治疗失眠或医学功效。",
      "手压柔软证明屏，成年手掌轻压枕头表面，枕头有轻微下陷和回弹感，近景突出柔软睡感，与前两屏静物/人物场景明显区分。",
      "颈部承托场景，成年模特侧躺或仰躺，枕头贴合颈肩曲线，人物表情放松可只露侧脸或下半脸，商品轮廓必须清楚。",
      "透气孔微距，超近景展示密集圆孔、枕面纹理和柔和材质，可用两个局部放大圈，不能把枕头变成普通平枕。",
      "多角度信息版，用侧面波浪曲线、俯拍孔位、手压柔软、床上完整摆放四个分区展示同一只枕头，形成画册式信息屏。",
      "卧室睡眠氛围场景，枕头放在床头，旁边有无品牌睡衣、书本或床头灯，强调睡前放松和真实卧室，不出现医疗器械或药品。",
      "收尾床品远景，枕头在干净卧室床面形成大留白品牌画面，构图比第1屏更远或更偏侧，统一暖白光线完成收尾。"
    ];
  }
  if (/(洗衣液|洗衣凝珠|洗衣粉|洗衣皂|衣物清洁|衣物洗护)/.test(identityText)) {
    return [
      "粉色洗衣液瓶英雄图，瓶身、把手、瓶盖、花朵标签和原有产品文字必须清楚，商品占主体，背景是干净洗衣房或洗衣机台面。",
      "日常污渍顾虑场景，成年人手部拿着有领口/袖口日常污渍的浅色衣物，粉色洗衣液在旁边清楚可见，镜头从手部侧前方拍摄，不做夸张脏污恐吓。",
      "倒取动作证明屏，成年人手部把同一瓶洗衣液倒入瓶盖、量杯或洗衣机投放盒，液体动作清楚，瓶身标签仍能识别，不能换成其他瓶型。",
      "清洁过程场景，洗衣机滚筒、洗衣盆或水槽中有衣物和细腻泡沫，粉色瓶在前景/侧边清楚出现，表现日常清洁，不虚构去污率或检测数据。",
      "花香衣物场景，干净衣物晾晒或叠放，旁边少量无品牌玫瑰/蔷薇花材呼应香味，粉色洗衣液瓶保持主体之一，不写留香时长。",
      "瓶身标签微距，近景拍 5A、洗衣液、薔薇花香、净含量等商品本体标签区域、瓶盖和把手，使用局部放大圈，不能抹掉或乱改标签文字。",
      "室内洗衣动线场景，家庭洗衣间中成年人手部把衣物放入洗衣机或从洗衣篮取衣，粉色瓶放在合理台面位置，空间和第1屏不同。",
      "收尾清新家务远景，粉色洗衣液瓶与整齐干净衣物、浅色洗衣房形成大留白品牌画面，构图区别第1屏的大瓶近景。"
    ];
  }
  if (/(永磁起重机|永磁起重器|磁力吊|永磁吊|磁力起重|起重磁铁|磁吸吊具|永磁吸盘)/.test(identityText)) {
    return [
      "黄色永磁起重机英雄图，大号 3/4 角度展示，U 型吊环、长手柄、机身铭牌和黄色矩形机身清楚，背景为深灰钢材或工业台面。",
      "起重安全顾虑场景，设备吸附在厚钢板上，吊钩连接吊环，钢板低高度离地，工人在安全距离侧后方观察，禁止站在悬吊物下方。",
      "吸力证明近景，磁吸底面与钢板接触关系清楚，吊链受力方向明确，用局部放大圈展示吸附接触面，不新增检测数据。",
      "户外钢材堆场或工地场景，设备在钢板/H 型钢搬运中使用，水泥地、安全围栏和钢材堆形成真实工况，不出现电源线。",
      "结构细节微距，展示 U 型吊环、长操作手柄、侧轴、黑色顶盖螺丝、铭牌/参数标签和警示图标，可用细线标注。",
      "规格参数组合版，用 200KG/400KG 设备对比、长宽高示意、钢板厚度/长度提示等分区呈现，只使用参考图可见参数。",
      "无需用电场景，户外或无电源车间中工人手部操作长手柄，旁边没有电线、电池包或电控箱，强调现场作业灵活。",
      "工业收尾远景，设备放在整齐钢材仓储区或深灰工业台面，旁边少量吊链和安全装备，构图更远更留白。"
    ];
  }
  if (/(运动鞋|运动鞋子|板鞋|休闲鞋|跑鞋|男鞋|鞋子|superstar|sneaker)/i.test(identityText)) {
    return [
      "白色运动鞋英雄图，双鞋完整清楚，占画面主体，保留黑色侧边三条纹、白色鞋头、白色鞋带、黑金鞋舌标、金色侧边文字和绿色细节，背景为干净户外街区或水泥台面。",
      "男生穿搭顾虑场景，年轻男生在户外台阶或街边坐下准备穿鞋/系鞋带，鞋子在前景清楚，表现好看也要好穿，不能只换成静物摆拍。",
      "透气鞋面证明屏，超近景展示鞋面孔位、鞋带、鞋头纹理和侧边线条，可用局部放大圈，强调鞋面清爽，不虚构科技材料。",
      "户外上脚场景，年轻男生穿同一双鞋走在城市步道、校园或街区，镜头拍下半身和鞋，牛仔裤或运动裤搭配，商品必须清楚。",
      "鞋头鞋底细节微距，低角度拍鞋头纹理、鞋带走线、鞋底边缘和鞋身材质，黑白金细节保留，和第3屏鞋面孔位区分。",
      "多角度信息版，用俯拍、侧拍、后跟、鞋舌标识四个分区展示同一双鞋，侧边金色文字和黑色三条纹必须可见。",
      "出街穿搭决策场景，年轻男生站在街头/公园步道/校园入口，鞋与裤装比例自然，突出干净高颜值日常搭配，不出现其他品牌道具。",
      "收尾街头静物远景，同一双鞋放在浅灰水泥台阶或干净户外长椅上，构图更远更留白，统一黑白金绿配色完成收尾。"
    ];
  }
  const detail = plan.detailFocus;
  const targetScene = usefulTargetAudience(task, task.category || "目标用户");
  return [
    "大商品英雄开场，平视或低角度，产品占主画面，背景简洁。",
    `真实顾虑场景，围绕${targetScene}展示使用前的选择或问题，和第1屏换背景换角度。`,
    `动作证明屏，用手部操作、打开、摆放、穿戴或取用动作证明“${plan.primaryPoint}”。`,
    `目标人群场景屏，拉开镜头展示${targetScene}真实生活空间，商品完整清楚。`,
    `${detail}超近景，微距展示纹理、结构、图案或包装细节，可用局部放大圈。`,
    "多角度信息版，用俯拍、侧拍和局部小图组合展示，不沿用单一静物镜头。",
    "决策理由场景，展示收纳、携带、搭配、摆放或使用后状态，和前后屏不同空间。",
    "收尾英雄图，用更远景或更大留白完成品牌收尾，区别第1屏构图。"
  ];
}

function addUnique(target: string[], values: string[]): void {
  for (const value of values) {
    const clean = value.trim();
    if (clean && !isPlaceholderCopy(clean) && !target.includes(clean)) target.push(clean);
  }
}

function cleanBusinessPhrases(values: string[]): string[] {
  return values
    .map((value) => normalizeSellingPointText(value))
    .filter((value) => value && !isPlaceholderCopy(value));
}

function normalizeSellingPointText(value: string): string {
  return value
    .trim()
    // Correct a common input typo before the phrase reaches shared visual rules.
    .replace(/轻轻一猜/g, "轻轻一擦")
    .replace(/一猜就/g, "一擦就");
}

function promptSellingPoints(task: ProductTask): string {
  return filterCategoryCompatibleSellingPoints(
    task,
    cleanBusinessPhrases(splitList(task.sellingPoints))
  ).join("；");
}

function isCategoryCompatibleSellingPoint(task: ProductTask, value: string): boolean {
  const identity = [
    task.productName,
    task.originalProductName,
    task.visibleProductName,
    task.category,
    task.referenceKeywords
  ].join(" ");
  const guards: Array<{ identity: RegExp; unrelated: RegExp }> = [
    {
      identity: /破壁机|搅拌机|榨汁机|blender|food\s*processor/i,
      unrelated: /垃圾袋|抽绳|囤货|袋身|袋口|垃圾桶|500只|垃圾清洁/
    },
    {
      identity: /垃圾袋|垃圾桶|抽绳垃圾袋|trash\s*bag/i,
      unrelated: /破壁机|搅拌杯|豆浆|刀头|榨汁|blend(?:er|ing)|英语学习|LED表情屏/
    },
    {
      identity: /电动车|自行车|车篮|篮筐|bike\s*basket|bicycle\s*basket/i,
      unrelated: /垃圾袋|抽绳|破壁机|搅拌杯|豆浆|刀头|鞋底|罩杯/
    },
    {
      identity: /AI机器人|智能机器人|陪伴机器人|豆包|deepseek|桌面机器人/i,
      unrelated: /垃圾袋|抽绳|破壁机|搅拌杯|豆浆|刀头|鞋底|罩杯|垃圾桶/
    }
  ];
  const guard = guards.find((candidate) => candidate.identity.test(identity));
  return !guard || !guard.unrelated.test(value);
}

function filterCategoryCompatibleSellingPoints(task: ProductTask, values: string[]): string[] {
  return values.filter((value) => isCategoryCompatibleSellingPoint(task, value));
}

function isPlaceholderCopy(value: string): boolean {
  const normalized = value.replace(/\s+/g, "");
  if (/请(?:结合|根据)?.*(?:商品图|产品图|用户重点|产品名称|文件名|图片|需求|卖点|信息).*(?:自行分析|自行补充|自行提炼|分析补充)/.test(normalized)) return true;
  if (/(?:请)?(?:你)?自行(?:分析|补充|提炼|判断)/.test(normalized)) return true;
  return /^(无|暂无|没有|未提供|请你自行分析|自行分析|你自行分析|请自行分析|待补充|空|N\/?A|null|undefined)$/i.test(normalized);
}

function usefulTargetAudience(task: ProductTask, fallback = ""): string {
  const audience = (task.targetAudience || "").trim();
  if (audience && !isPlaceholderCopy(audience)) return audience;
  return fallback;
}

function firstUsefulSpec(specs: string[], fallback: string): string {
  return cleanBusinessPhrases(specs)[0] || fallback;
}

function buildVisualSystem(
  task: ProductTask,
  brand: BrandProfile,
  points: string[],
  banned: string,
  analysis: ReferenceAnalysis,
  productVisualInsight?: ProductVisualInsight
): VisualSystem {
  const context = productContext(task);
  const palette = buildPalette(task, brand, context);
  const model = buildModelRule(task, context);
  const scene = buildSceneRule(task, context);
  const platform = buildPlatformRule(task);
  const productLock = buildProductLock(task, points, context);
  return {
    platform,
    generationRule: buildGenerationRulePrompt(task),
    productImageAuthority: buildProductImageAuthorityRule(task),
    productVisualInsight: buildProductVisualInsightRule(productVisualInsight),
    palette,
    scene,
    model,
    consistency: buildConsistencyRule(task, context),
    sceneSellingPointLock: buildSceneSellingPointLockRule(task, context),
    ecommerceLogic: buildEcommerceLogicRule(context),
    referenceLearning: [
      buildReferenceLearningRule(analysis, context),
      buildReferenceCaseLayoutRule(storyboardInput(task, points))
    ].join("\n"),
    brandVisualLogic: buildBrandVisualLogicRule(analysis, context),
    designReviewStandard: buildDesignReviewStandardRule(analysis, context),
    typography: buildTypographySystemRule(context),
    productLock,
    forbidden: [
      hasExternalReferenceLearning(task, analysis)
        ? "外部参考案例/截图/素材只用于学习构图、排版层级、场景质感和详情页节奏；商品身份、颜色、结构和文案必须以本地商品图与本任务信息为准。"
        : "",
      banned ? `禁止：${banned}` : "",
      "禁止在商品本体以外新增乱码、错别字、随机英文、水印、竞品商标、真实品牌露出、廉价促销爆炸贴。",
      "禁止虚构未提供的材质、认证、功效或测试数据。"
    ].filter(Boolean).join("\n")
  };
}

function visualSystemToPrompt(system: VisualSystem): string {
  const visualControl = isEnglishMarketplaceTaskText(system.platform)
    ? "全案视觉总控 / 语言总控：所有新增可见营销文案必须统一使用自然英文；平台风格只由下方平台规则控制。"
    : "全案视觉总控 / 语言总控：所有新增可见营销文案必须统一使用简体中文；平台风格只由下方平台规则控制。";
  return [
    visualControl,
    system.platform,
    system.generationRule,
    system.productImageAuthority,
    system.productVisualInsight,
    system.palette,
    system.scene,
    system.model,
    system.consistency,
    system.sceneSellingPointLock,
    system.ecommerceLogic,
    system.referenceLearning,
    system.brandVisualLogic,
    system.designReviewStandard,
    system.typography,
    system.productLock,
    system.forbidden
  ].join("\n");
}

function buildGenerationRulePrompt(task: ProductTask): string {
  const platformRuleText = sanitizeGenerationRuleTextForTask(task, task.platformRuleText?.trim() || "");
  const languageRuleText = sanitizeGenerationRuleTextForTask(task, task.languageRuleText?.trim() || "");
  const commonRuleText = sanitizeGenerationRuleTextForTask(task, task.commonRuleText?.trim() || "");
  const combinedRuleText = sanitizeGenerationRuleTextForTask(task, task.generationRuleText?.trim() || "");
  if (!commonRuleText && !platformRuleText && !languageRuleText && !combinedRuleText) {
    return [
      "生图规则库：本任务未读取到外部规则正文，使用内置兜底规则。",
      "兜底规则：保持商品主体特征不变；每张图独立场景、独立卖点；文案必须具体绑定商品功能和画面证据；禁止内部流程词、乱码、水印、虚假参数。"
    ].join("\n");
  }
  const ruleSections = [
    combinedRuleText
      ? `组合规则（公共核心 + 平台风格 + 语言统一）：${task.generationRuleName || ""}\n${combinedRuleText.slice(0, 9000)}`
      : [
          commonRuleText ? `公共核心规则：${task.commonRuleName || ""}\n${commonRuleText.slice(0, 4500)}` : "",
          platformRuleText ? `平台风格规则：${task.platformRuleName || ""}\n${platformRuleText.slice(0, 4500)}` : "",
          languageRuleText ? `语言统一规则：${task.languageRuleName || ""}\n${languageRuleText.slice(0, 3500)}` : "",
        ].filter(Boolean).join("\n\n"),
  ].filter(Boolean).join("\n\n");
  return [
    "生图规则库强制规则：以下规则来自本地“生图规则”文件夹，是本任务生成、文案、禁用项和审核的强制依据。",
    task.platformRuleName ? `平台规则：${task.platformRuleName}（${task.platformRuleFile || "未记录文件"}）` : "",
    task.languageRuleName ? `语言规则：${task.languageRuleName}（${task.languageRuleFile || "未记录文件"}）` : "",
    task.outputLanguage ? `输出语言：${task.outputLanguage}` : "",
    task.visibleProductName ? `可见展示名：${task.visibleProductName}` : "",
    task.generationRuleReason ? `组合判断：${task.generationRuleReason}` : "",
    "必须执行：公共核心规则控制生图质量、主体差异、卖点证明和构图去重；平台规则只控制画面风格；语言规则控制所有新增可见营销文案。不要把规则文件名、规则ID、判断过程或提示词字段画进图片。",
    ruleSections,
  ].filter(Boolean).join("\n");
}

function sanitizeGenerationRuleTextForTask(task: ProductTask, ruleText: string): string {
  if (!ruleText) return "";
  const context = productContext(task);
  const identity = classifyProductIdentity(task).id;
  const identityText = [task.productName, task.category, task.targetAudience, task.sellingPoints, task.notes, task.referenceKeywords].join(" ");
  const isTrashBag = /垃圾袋|trash bag|抽绳|艾草|除臭|防臭/i.test(identityText);
  return ruleText
    .split(/\r?\n/)
    .filter((line) => {
      const clean = line.trim();
      if (!clean) return true;
      if (!isTrashBag && /垃圾袋示例|垃圾袋|抽绳|厨余/.test(clean)) return false;
      if (!context.isUmbrella && /雨伞示例|晴雨伞|折叠伞|伞骨|伞柄/.test(clean)) return false;
      if (!context.isAiRobot && /机器人示例|LED 表情|LED表情/.test(clean)) return false;
      if (!(context.isFootwear || context.isApparel || context.isPants) && /鞋服示例|跑鞋|上脚|上身/.test(clean)) return false;
      if (!context.isBikeBasket && /电动车\/自行车篮筐示例|车篮|篮筐|防水罩/.test(clean)) return false;
      if (!context.isCup && /水壶\/杯子|杯盖杯口/.test(clean)) return false;
      if (isForeignCategoryExampleLineUnicode(clean, identity)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isForeignCategoryExampleLine(line: string, currentIdentity: ReturnType<typeof classifyProductIdentity>["id"]): boolean {
  if (!line) return false;
  const categoryExamples: Array<[Exclude<ReturnType<typeof classifyProductIdentity>["id"], "generic">, RegExp]> = [
    ["ai-robot", /机器人|AI companion robot|robot/i],
    ["footwear", /鞋服|鞋类|鞋子|拖鞋|跑鞋|上脚|穿搭|footwear|sneaker|shoe/i],
    ["trash-bag", /垃圾袋|垃圾桶|抽绳袋|trash bag/i],
    ["umbrella", /雨伞|折叠伞|晴雨伞|遮阳伞|umbrella/i],
    ["bike-basket", /电动车|自行车|车篮|篮筐|bike basket|bicycle basket/i],
    ["blender", /破壁机|搅拌机|料理机|豆浆机|blender/i],
    ["chair", /椅子|座椅|滚轮椅|chair|seat/i],
    ["drinkware", /水杯|水壶|保温杯|热水壶|drinkware|kettle|thermos/i]
  ];
  const isRuleExample = /示例|例如|只用于理解|品类示例|形态链/.test(line) || /^[-*]\s*/.test(line);
  if (!isRuleExample) return false;
  return categoryExamples.some(([identity, pattern]) => identity !== currentIdentity && pattern.test(line));
}

function isForeignCategoryExampleLineUnicode(line: string, currentIdentity: ReturnType<typeof classifyProductIdentity>["id"]): boolean {
  if (!line) return false;
  const rules: Array<[string, RegExp]> = [
    ["ai-robot", /\u673a\u5668\u4eba|AI companion robot|robot/i],
    ["footwear", /\u978b\u670d|\u978b\u7c7b|\u978b\u5b50|\u62d6\u978b|\u8dd1\u978b|\u4e0a\u811a|\u7a7f\u642d|footwear|sneaker|shoe/i],
    ["trash-bag", /\u5783\u573e\u888b|\u5783\u573e\u6876|\u62bd\u7ef3\u888b|trash bag/i],
    ["umbrella", /\u96e8\u4f1e|\u6298\u53e0\u4f1e|\u6674\u96e8\u4f1e|\u906e\u9633\u4f1e|umbrella/i],
    ["bike-basket", /\u7535\u52a8\u8f66|\u81ea\u884c\u8f66|\u8f66\u7bee|\u7bee\u7b50|bike basket|bicycle basket/i],
    ["blender", /\u7834\u58c1\u673a|\u6405\u62cc\u673a|\u6599\u7406\u673a|\u8c46\u6d46\u673a|blender/i],
    ["chair", /\u6905\u5b50|\u5ea7\u6905|\u6eda\u8f6e\u6905|chair|seat/i],
    ["drinkware", /\u6c34\u676f|\u6c34\u58f6|\u4fdd\u6e29\u676f|\u70ed\u6c34\u58f6|drinkware|kettle|thermos/i]
  ];
  const isRuleExample = /\u793a\u4f8b|\u4f8b\u5982|\u53ea\u7528\u4e8e\u7406\u89e3|\u54c1\u7c7b\u793a\u4f8b|\u5f62\u6001\u94fe/.test(line) || /^[-*]\s*/.test(line);
  return isRuleExample && rules.some(([identity, pattern]) => identity !== currentIdentity && pattern.test(line));
}

function buildProductVisualInsightRule(productVisualInsight?: ProductVisualInsight): string {
  if (!productVisualInsight) {
    return [
      "商品视觉分析层：生成前必须先读取当前上传商品图，先在模型内部完成商品事实复核，再决定卖点和画面。",
      "复核范围：真实颜色、主体形状、结构比例、材质肌理、图案、产品本体文字/Logo、标签、配件、包装和使用状态。",
      "卖点拓展必须从商品图可见事实、产品名称、人群和类目推导，不能只套用通用模板词。"
    ].join("\n");
  }
  const source = productVisualInsight.source === "openai-vision" ? "OpenAI 视觉预分析" : "提示词内视觉分析";
  const facts = productVisualInsight.productFacts.slice(0, 10);
  const points = productVisualInsight.visualSellingPoints.slice(0, 5);
  const directives = productVisualInsight.promptDirectives.slice(0, 8);
  const warnings = productVisualInsight.warnings.slice(0, 3);
  return [
    "商品视觉分析层（提示词总控台最高优先级）：每张图生成前必须以当前上传商品图为准，先完成商品事实复核，再输出画面。",
    `视觉分析来源：${source}`,
    productVisualInsight.summary ? `视觉摘要：${productVisualInsight.summary}` : "",
    facts.length ? `商品可见事实：${facts.join("；")}` : "",
    points.length ? `由商品图/产品信息补充的可用卖点：${points.join("；")}` : "",
    directives.length ? `每屏执行指令：${directives.join("；")}` : "",
    warnings.length ? `视觉分析备注：${warnings.join("；")}` : "",
    "如果后文脚本、类目模板或历史案例描述与以上商品事实冲突，必须立即以当前商品图事实修正。"
  ].filter(Boolean).join("\n");
}

function buildProductImageAuthorityRule(task: ProductTask): string {
  const identity = task.productName || task.sku || task.category || "本商品";
  return [
    `商品图优先硬规则（最高优先级）：本次随 API 一起提交的本地商品图/参考图，是“${identity}”外观的唯一依据。生成前必须先观察当前这次上传的商品图片，提取真实可见的颜色、结构、图案、文字/Logo、标签、配件、比例、材质、包装和使用状态。`,
    "如果需求文档、历史范本、类目模板、参考案例学习内容或后文画面脚本里的颜色、形状、图案、配件、文字、包装描述与当前商品图不一致，必须以当前商品图为准，并自动替换成当前商品图真实可见的元素；不得复用旧商品、旧文件夹、旧样例或旧模板里的外观描述。",
    "提示词中的“同款商品/参考图商品/本地商品图”都只指当前待作图文件夹里这一次新上传的商品图，不指历史生成结果。外部案例只学习构图、排版、光影和页面节奏，绝不能学习或替换商品本体。"
  ].join("\n");
}

function buildSceneSellingPointLockRule(task: ProductTask, context: ProductContext): string {
  const extra = context.isAiRobot
    ? "可动/互动产品额外要求：每张图必须改变姿势、表情屏/状态、头部朝向、手臂腿部动作或互动对象；语言、联网、续航等抽象卖点允许黑板、关系图、电池时间线或玩法道具成为大视觉元素，机器人作为识别锚点、辅助主体或小型插图出现。"
    : context.isApparel || context.isFootwear
      ? "穿戴类额外要求：可通过真人/局部身体、穿搭环境、衣橱、通勤或校园等元素证明卖点，但商品穿着状态、版型和关键细节必须清楚，人物不能抢主体。"
      : context.isCup
        ? "杯壶类额外要求：可通过手部取放、打开杯盖、书桌/户外/书包/餐桌等元素证明卖点；如表现饮用，杯盖或饮口状态必须符合真实物理逻辑。"
        : context.isBikeBasket
          ? "骑行车篮类额外要求：每张图必须在安装全貌、打开装载、防水闭合、固定结构近景、通勤买菜取放之间切换；不得只重复同一车头视角或同一打开篮筐构图。"
        : "";
  return [
    "主体锁定 + 独立场景卖点锁：整套图必须保持同一个当前商品主体特征不变，包括颜色、结构、比例、材质、图案、商品本体文字、包装和关键配件；禁止把商品换款、换色、换结构或沿用历史商品外观。",
    "每张图必须承担一个独立卖点和一个独立画面任务。禁止只复制同一个商品姿态后换背景、换文案或轻微平移；相邻图片必须在镜头距离、拍摄角度、商品姿态、使用动作、道具、人/手部参与、空间背景或证明方式上有明显变化。",
    "允许围绕卖点加入多元素证明，例如目标人群、手部动作、课本、食材、衣橱、礼盒、桌面、户外、收纳道具、局部放大圈、关系图和细线信息层；商品是识别锚点，但抽象卖点允许场景、道具或信息图成为大视觉元素，不能只在商品旁边加文字。",
    "每屏画面先问：这个卖点如何被看见？能用动作证明就用动作，能用场景证明就用场景，能用细节证明就用近景，能用多角度证明就用组合图；文案必须和本屏可见证据一致。",
    buildProductFormDiversityRule(task, context),
    extra
  ].filter(Boolean).join("\n");
}

function hasExternalReferenceLearning(task: ProductTask, analysis: ReferenceAnalysis): boolean {
  return Boolean(
    task.referenceProductUrls.length ||
      task.referenceImageUrls.length ||
      analysis.references.length ||
      /参考案例|案例学习|学习库|站酷|Design006/i.test(analysis.summary)
  );
}

function composeScreenPrompt(
  system: VisualSystem,
  screen: ScreenPrompt
): string {
  const aspectRatio = screen.role.includes("详情") ? "9:16" : "1:1";
  const isEnglishMarketplace = isEnglishMarketplaceTaskText(system.platform);
  return [
    isEnglishMarketplace
      ? "Generate one complete English marketplace ecommerce product image for the BananaPro/GPT image model."
      : "为 BananaPro/GPT 生图模型生成一张中文电商成品图。",
    `画布：${aspectRatio}，2K，单张完整设计稿，不要输出说明文字。`,
    visualSystemToPrompt(system),
    `本屏角色：${screen.role}`,
    `转化目标：${screen.conversionGoal}`,
    `画面调度：${screen.sceneDirection}`,
    `构图：${screen.composition}`,
    `本屏排版：${screen.typography}`,
    buildTypographyCompositionRule(screen.copy, screen.role, aspectRatio),
    exactCopyInstruction(screen.copy),
    productImageFinalCheckRule(),
    "视觉完成度：精修商业摄影、细节清楚、层级稳定、套图一致；文字必须像成熟品牌电商稿，不像普通 PPT 标题或随手加字。"
  ].join("\n");
}

function composeDetailScreenPrompt(
  shared: string,
  taskPrompt: string,
  copy: string[],
  role = "竖版详情页模块",
  screenIndex?: number
): string {
  const isEnglishMarketplace = isEnglishMarketplaceTaskText(shared);
  return [
    shared,
    "",
    isEnglishMarketplace
      ? "Canvas: 9:16, 2K, one complete vertical marketplace detail image. Do not output explanatory text outside the image design."
      : "画布：9:16，2K，单张完整竖版详情页设计稿，不要输出说明文字。",
    `本屏角色：${role}`,
    `本张任务：${taskPrompt}`,
    buildDetailShotDiversityRule(role, screenIndex),
    buildTypographyCompositionRule(copy, role, "9:16"),
    exactCopyInstruction(copy),
    productImageFinalCheckRule(),
    "视觉完成度：精修商业摄影、细节清楚、层级稳定、套图一致；文字必须像成熟品牌电商稿，不像普通 PPT 标题或随手加字。"
  ].join("\n");
}

function productImageFinalCheckRule(): string {
  return "出图前最终复核：再次比对当前随 API 提交的商品参考图。若本屏任何画面脚本、文案语境或类目模板中的外观描述与当前商品图不一致，必须删除旧描述并改成当前商品图真实可见的颜色、图案、结构、配件和商品本体文字；绝不允许沿用历史产品图或历史提示词里的商品外观。";
}

function buildDetailShotDiversityRule(role: string, screenIndex?: number): string {
  const sequence = [
    "第1屏：大商品英雄开场，低/平视三分之二构图，建立产品和核心主张。",
    "第2屏：用户顾虑场景，必须加入不同背景或生活问题证据，不能沿用第1屏的摆放角度。",
    "第3屏：动作/功能证明，用当前商品适用的手部操作、开合、放置、整理或取用动作作为主证据；不要套用其他品类的动作。",
    "第4屏：目标人群/真实生活场景，拉开距离或出现人物/餐桌/衣橱/厨卫空间，不能只是商品静物。",
    "第5屏：超近景细节，微距展示纹理、包装、结构或图案，可用局部放大圈。",
    "第6屏：多角度信息版，用俯拍、侧拍、拆分小图或组合格展示多个视角，和第5屏的单一微距区分。",
    "第7屏：决策理由场景，展示收纳、携带、摆放、搭配或送礼动作，必须和第1屏/第8屏背景不同。",
    "第8屏：收尾英雄图，回到稳定产品画面，但构图必须区别第1屏：若第1屏正面，收尾用俯拍/远景/留白静物；若第1屏场景，收尾用棚拍静物。"
  ];
  return [
    "详情页镜头差异硬规则：8 张详情页必须像一支完整销售短片，屏与屏之间更换镜头距离、拍摄角度、商品摆放、动作证据和空间层次。",
    "禁止连续两屏使用同一背景、同一商品正面 3/4 角度、同一桌面高度、同一文字位置。禁止只替换文案而画面主体和角度几乎不变。",
    "统一的是色彩、光线、字体和商品外观；变化的是镜头脚本、动作、场景和证据类型。",
    screenIndex ? `本屏镜头脚本：${sequence[screenIndex - 1] ?? "根据本屏角色选择与相邻屏明显不同的镜头和场景证据。"}` : "",
    `本屏必须和相邻屏形成差异：${role} 的商品角度、取景距离、背景空间和道具关系都要有明确变化。`
  ].filter(Boolean).join("\n");
}

function productContext(task: ProductTask): ProductContext {
  const identity = classifyProductIdentity(task);
  const identityText = [
    task.productName,
    task.originalProductName,
    task.visibleProductName,
    task.category,
    task.targetAudience,
    task.targetPlatform,
    task.outputLanguage,
    task.sellingPoints,
    task.platformRuleProfile,
    task.platformRuleName,
    task.languageRuleProfile,
    task.languageRuleName,
    task.generationRuleProfile,
    task.generationRuleName
  ].join(" ");
  const referenceText = task.referenceKeywords;
  const text = [
    identityText,
    referenceText,
    task.notes,
    task.platformRuleReason,
    task.platformRuleText,
    task.languageRuleReason,
    task.languageRuleText,
    task.generationRuleReason,
    task.generationRuleText,
  ].join(" ");
  const isIntimateApparel = /(胸罩|文胸|内衣|bra|bralette|无钢圈|聚拢|罩杯)/i.test(identityText);
  const isCup = /(杯|水杯|保温杯|杯子|壶)/.test(identityText);
  const isFootwear = identity.id === "footwear" && !isCup && !isIntimateApparel;
  const isPillow = /(枕头|睡眠枕|乳胶枕|护颈枕|颈椎枕|枕芯)/.test(identityText);
  const isLaundryDetergent = /(洗衣液|洗衣凝珠|洗衣粉|洗衣皂|衣物清洁|衣物洗护)/.test(identityText);
  const isSneaker =
    /(运动鞋|运动鞋子|板鞋|休闲鞋|跑鞋|男鞋|superstar|sneaker)/i.test(identityText) ||
    (/(鞋子|鞋)/.test(identityText) && /(男生|男士|高颜值|透气|出街|户外|穿搭|舒适)/.test(identityText));
  const isKitchenTextile = /(厨房|洗碗|擦拭|清洁|抹布|擦手巾|洗碗布|厨房巾|厨房毛巾)/.test(identityText) && /(毛巾|巾|布|抹布)/.test(identityText);
  const isBabyCare = /(尿布湿|尿不湿|纸尿裤|拉拉裤|婴儿尿裤|diaper)/i.test(identityText);
  const isPants = /(阔腿裤|宽腿裤|休闲裤|卫裤|运动裤|家居裤|女裤|裤子|长裤|裤装|拖地裤|九分裤|直筒裤|pants|trousers|wide leg)/i.test(identityText) && !isIntimateApparel && !isSneaker;
  const isApparel = (isPants || /(衣服|服饰|女装|男装|上衣|外套|卫衣|针织衫|打底衫|T恤|t恤|裙|套装|穿搭|apparel|clothing|shirt)/i.test(identityText)) && !isIntimateApparel && !isKitchenTextile && !isSneaker && !isBabyCare;
  const isSkincare = /(保湿霜|面霜|乳霜|护肤|美妆|化妆品|精华|乳液|水乳|cream|skincare)/i.test(identityText);
  const isPortableFan = /(风扇|小风扇|手持风扇|随身风扇|迷你风扇|电风扇)/.test(identityText);
  const isCuttingBoard = /(菜板|砧板|切菜板|案板|乌檀木)/.test(identityText);
  const isMagneticLifter = /(永磁起重机|永磁起重器|磁力吊|永磁吊|磁力起重|起重磁铁|磁吸吊具|永磁吸盘)/.test(identityText);
  const isStudentBackpack = /(学生双肩背包|学生书包|双肩背包|书包|上学背包)/.test(identityText);
  const isTissue = /(抽纸巾|抽纸|面巾纸|纸巾|纸抽|盒抽|软抽|tissue)/i.test(identityText) && !isBabyCare;
  const isUmbrella = /(雨伞|晴雨伞|晴雨两用|折叠伞|防晒伞|遮阳伞|伞)/.test(identityText);
  const isBikeBasket = /(电动车|自行车|车篮|篮筐|前篮|后篮|骑行|bike basket|bicycle basket|e-bike basket)/i.test(identityText);
  const isAiRobot = identity.id === "ai-robot";
  const isChildProduct = /(儿童|孩子|宝宝|幼儿|小孩|童)/.test(identityText) && !isIntimateApparel;
  const isEnglishMarketplace = /^English$/i.test(String(task.outputLanguage || "").trim()) || isEnglishMarketplaceTaskText(text);
  return {
    text,
    isChildProduct,
    isAiRobot,
    isFootwear,
    isYellowProduct: /(黄|黄色|明亮|柠檬)/.test(identityText),
    isCup,
    isTemperatureDisplay: /(电子|智能|温显|温度|数显|显示屏|LED)/i.test(text),
    isIntimateApparel,
    isKitchenTextile,
    isSkincare,
    isPortableFan,
    isPillow,
    isLaundryDetergent,
    isSneaker,
    isPants,
    isApparel,
    isBabyCare,
    isCuttingBoard,
    isMagneticLifter,
    isStudentBackpack,
    isTissue,
    isUmbrella,
    isBikeBasket,
    isAmazonPlatform: isAmazonPlatformTask(task),
    isAdultAudience: /(成人|女性|女士|女|38|39|40|成熟|妈妈|中年)/.test(identityText) && !isChildProduct,
    isEnglishMarketplace,
    canShowFace: !/(不露脸|不要露脸|不可露脸|只展示膝盖|只拍腿部|背影)/.test(text)
  };
}

function isAmazonTaskText(text: string): boolean {
  return /amazon|亚马逊/i.test(text);
}

function isAmazonPlatformTask(task: ProductTask): boolean {
  return isAmazonTaskText([
    task.targetPlatform,
    task.platformRuleProfile,
    task.platformRuleName,
    task.platformRuleFile
  ].join(" "));
}

function isEnglishMarketplaceTaskText(text: string): boolean {
  const value = String(text || "");
  return /(输出语言\s*[：:]\s*English|output\s*language\s*[：:]\s*English|语言规则\s*[：:]\s*English|language\s+rule\s*[：:]\s*English|可见宣传文案[^。\n；;]*English|visible\s+marketing\s+copy[^。\n；;]*English|all newly added visible marketing copy[^。\n；;]*English|English\s+copy|英文文案|输出英文|全英文)/i.test(value);
}

function buildPlatformRule(task: ProductTask): string {
  const platform = task.targetPlatform || "淘宝/天猫";
  const outputLanguage = task.outputLanguage || (isEnglishMarketplaceTaskText(task.languageRuleText || "") ? "English" : "简体中文");
  const platformText = [
    task.targetPlatform,
    task.outputLanguage,
    task.notes,
    promptSellingPoints(task),
    task.category,
    task.platformRuleProfile,
    task.platformRuleName,
    task.platformRuleReason,
    task.platformRuleText,
    task.languageRuleProfile,
    task.languageRuleName,
    task.languageRuleReason,
    task.generationRuleProfile,
    task.generationRuleName,
    task.generationRuleReason,
    task.generationRuleText
  ].join(" ");
  if (isAmazonPlatformTask(task)) {
    return [
      "目标平台：Amazon marketplace product images.",
      `输出语言：${outputLanguage}`,
      "平台风格：clean product clarity, feature proof, lifestyle credibility, restrained layout, and purchase confidence.",
      "Language note: visible marketing copy language is controlled by the output language field, not by Amazon platform style.",
      "Common quality note: Amazon style must still follow the public core rules for distinct product forms, distinct proof methods, non-repeated compositions, and benefit-led scene design.",
      "Design goal: clean product clarity, feature proof, lifestyle credibility, and purchase confidence.",
      "Do not use Taobao/Tmall/Douyin/Xiaohongshu visual language, Chinese default platform labels, fake ratings, review stars, Best Seller badges, prices, sales volume, platform watermarks, or unsupported certification claims."
    ].join("\n");
  }
  if (isEnglishMarketplaceTaskText(platformText)) {
    return [
      `目标平台：${platform}移动端电商图。`,
      `输出语言：${outputLanguage}`,
      "平台风格：按目标平台执行，不因为 English 输出而自动切换成 Amazon 风格。",
      "可见营销文案必须服从输出语言，构图密度和平台禁用项仍按目标平台规则执行。"
    ].join("\n");
  }
  const focus = /抖音/.test(platform)
    ? "强情绪价值、强转化、首秒抓眼"
    : /小红书/.test(platform)
      ? "场景种草、生活方式、氛围可信"
      : /京东/.test(platform)
        ? "信息清楚、品质可信、决策效率高"
        : "货架点击、品牌质感、移动端高转化";
  return `目标平台：${platform}移动端电商图，兼容淘宝/天猫/京东/抖音/小红书货架浏览；输出语言：${outputLanguage}；设计目标是${focus}。`;
}

function buildEcommerceLogicRule(context: ProductContext): string {
  const detailSequence = context.isAiRobot
    ? "AI机器人详情页节奏：首屏核心主张 -> 家长顾虑/少屏互动 -> AI对话功能证明 -> 早教学习陪伴 -> 可动关节与LED表情细节 -> 多姿态多表情证明 -> 送礼/桌面陪伴决策 -> 生活化收尾。AI机器人类目绝不能做成13张同一正面站姿，只换背景和文案。"
    : context.isIntimateApparel
    ? "详情页节奏：首屏核心主张 -> 用户痛点/顾虑 -> 材质证据 -> 实穿/版型 -> 结构细节 -> 日常内搭 -> 衣橱场景 -> 品牌收尾。内衣类不强行做尺码表或选择建议屏。"
    : context.isSkincare
      ? "详情页节奏：首屏核心主张 -> 干燥/肤感顾虑 -> 温和保湿证据 -> 膏体质地 -> 真人上脸 -> 包装品质 -> 早晚护肤场景 -> 品牌收尾。护肤类不强行做成分表、检测数据或医美功效屏。"
      : context.isPillow
        ? "详情页节奏：首屏核心主张 -> 睡前不适顾虑 -> 手压柔软证据 -> 颈部承托场景 -> 透气孔微距 -> 曲线多角度 -> 卧室睡眠氛围 -> 品牌收尾。枕头类不做治疗失眠、医学背书或规格选择建议屏。"
      : context.isLaundryDetergent
        ? "详情页节奏：首屏核心主张 -> 衣物污渍顾虑 -> 倒取动作证据 -> 清洁过程 -> 花香衣物场景 -> 瓶身标签细节 -> 家庭洗衣动线 -> 品牌收尾。洗衣液类不虚构除菌、检测数据或留香时长。"
      : context.isSneaker
        ? "详情页节奏：首屏核心主张 -> 男生穿搭顾虑 -> 鞋面透气证据 -> 户外上脚场景 -> 鞋头鞋底细节 -> 黑白金多角度 -> 出街穿搭决策 -> 品牌收尾。运动鞋类不做尺码表、科技参数或虚构性能屏。"
      : context.isPants
        ? "详情页节奏：首屏核心主张 -> 穿着顾虑 -> 版型动作证明 -> 居家/通勤穿搭 -> 腰头抽绳与面料细节 -> 多角度裤型展示 -> 衣橱搭配决策 -> 品牌收尾。裤装类不做规格选择建议或空泛生活方式屏。"
      : context.isApparel
        ? "详情页节奏：首屏核心主张 -> 穿搭顾虑 -> 版型证明 -> 日常搭配场景 -> 面料做工细节 -> 多角度展示 -> 衣橱搭配决策 -> 品牌收尾。服装类不做规格选择建议或虚构面料认证。"
      : context.isMagneticLifter
        ? "详情页节奏：首屏核心主张 -> 起重安全顾虑 -> 吸附吊装证据 -> 户外/车间工况 -> 吊环手柄结构 -> 规格参数展示 -> 无需用电场景 -> 工业品牌收尾。工业起重设备不做生活方式空镜，不虚构认证、吨位、检测报告或绝对安全承诺。"
      : context.isStudentBackpack
        ? "详情页节奏：首屏核心主张 -> 上学收纳顾虑 -> 肩带轻便证据 -> 校园/课桌场景 -> 前袋侧袋/配件细节 -> 多角度展示 -> 上学收纳决策 -> 品牌收尾。学生背包不虚构护脊、防水、防盗、容量升数、承重测试或材质认证。"
        : context.isChildProduct && context.isCup && !context.isTemperatureDisplay
          ? "详情页节奏：首屏核心主张 -> 妈妈选杯顾虑 -> 耐热饮用证据 -> 儿童家庭场景 -> 杯盖把手细节 -> 材质结构多角度 -> 上学携带 -> 品牌收尾。儿童保温杯没有具体规格时不做选择建议、尺码建议或参数屏。"
        : "详情页节奏：首屏核心主张 -> 用户痛点/顾虑 -> 核心功能证据 -> 目标人群场景 -> 结构细节 -> 多角度证明 -> 决策理由 -> 品牌收尾。有明确规格才讲规格，没有规格就继续讲商品价值和使用/送礼/穿搭/居家理由。";
  const base = [
    context.isAmazonPlatform
      ? "Amazon视觉逻辑：首图负责清晰识别与购买信任，必须商品清楚、卖点可信、留白克制；后续主图依次承担功能证明、真实场景、细节信任、决策收尾，不能套用淘宝/天猫高密度促销排版。"
      : "淘宝/天猫视觉逻辑：首图负责点击率，必须大商品、大品类识别、大核心卖点；后续主图依次承担功能证明、场景代入、细节信任、决策收尾。",
    "卖点翻译原则：不要把卖点写成口号，要把卖点变成画面证据；能近景证明的用近景，能动作证明的用动作，能场景证明的用场景。",
    detailSequence,
    "每一屏只讲一个购买理由，文字不超过三层信息，图片和文案必须互相证明。",
    "文案匹配原则：文案必须从本屏画面证据反推，不允许把材质文案放到衣橱图、把场景文案放到细节图、把给设计师看的任务描述当成消费者文案；消费者可见文案不要出现“实穿证明、场景代入、转化目标、案例学习”等内部术语。",
    `可见文案禁用模板词：${TEMPLATE_PROMPT_FORBIDDEN_COPY_TERMS.join("、")}。这些只能作为内部反例，绝不能出现在成品图文字中。`
  ];
  if (context.isAiRobot) {
    base.push("AI机器人重点：必须严格保留参考图中的黄色圆润机器人主体、黑银撞色、银色耳机装饰、蓝色LED表情屏、可动手臂腿部和儿童友好比例；每张主图和每屏详情都要有不同姿势或不同表情，至少包括挥手、前倾倾听、指向书本、双臂上举、坐姿/桌面摆件姿态、多表情组合。禁止13张图都复制同一正面站姿后只换背景。");
    base.push("AI机器人功能表达：可以用语音波纹、问答气泡形状、绘本、单词卡、亲子书桌、无品牌礼盒、家庭客厅等道具证明AI对话、早教学习、情感陪伴和送礼桌搭；不得把豆包、DeepSeek或其他模型画成真实商标，不虚构认证、教育成绩、医疗效果、绝对安全承诺、具体续航时长或未提供参数。");
  } else if (context.isCup && context.isTemperatureDisplay) {
    base.push("儿童温显水杯重点：用杯盖/屏幕近景证明温度显示；用书桌、书包、上学前、课间饮水等场景证明儿童日常适配；不能虚构保温时长、材质等级、防漏测试或安全认证。");
  } else if (context.isChildProduct && context.isCup) {
    base.push("儿童保温杯重点：用杯盖、杯口、双把手、杯身卡通图案证明可爱、耐热和小手好握；用家庭餐桌、书桌、无品牌书包和上学前场景证明 8-10 岁儿童日常适配；耐高温和环保材料只能做用户提供卖点的温和表达，不虚构具体温度、材质等级、认证、防漏测试或保温时长。");
    base.push("儿童杯饮用物理逻辑：任何“喝水、准备喝水、嘴巴靠近杯口”的画面，黄盖必须处于打开/翻开状态，必须露出杯口、吸饮口或内胆开口；如果杯盖关闭，只能表现拿取、握持、放入书包或桌面摆放，禁止让孩子对着关闭的杯盖喝水。");
  } else if (context.isBabyCare) {
    base.push("婴儿护理用品重点：只展示商品包装、干净折叠样片、吸收层纹理、父母手部整理和育儿台收纳；禁止换尿布动作、穿戴展示、裸露婴儿身体、婴儿下半身特写、尿液/排泄物画面、医疗功效、检测认证或具体吸收数据。");
  } else if (context.isCuttingBoard) {
    base.push("菜板重点：用整板英雄图、真实切菜动作、冲洗水流、乌檀木纹微距、边角厚度和厨房挂放收纳证明卖点；可以使用用户提供的“抗菌率99.9%”，但不能虚构检测机构、认证编号、材质等级、无毒绝对化承诺或更多实验数据。");
  } else if (context.isMagneticLifter) {
    base.push("永磁起重机重点：用黄色机身英雄图、U 型吊环、长手柄、机身铭牌/参数标签、钢板吸附吊装、户外工地/车间工况证明 3 倍吸力、无需用电和多场景适用；不得把商品画成电动葫芦、普通吊钩、叉车、吊车整机或无磁吸底座的吊具。");
    base.push("工业吊装安全逻辑：吊装画面必须只表现低高度、可控、规范的钢板/钢材搬运；钢板在设备磁吸底面下方，吊环连接无品牌吊钩或吊链，周围工人佩戴安全帽并保持距离；禁止人物站在悬吊钢材下方，禁止高空危险坠落、火花爆炸、超大桥吊、夸张断裂或绝对安全承诺。");
  } else if (context.isStudentBackpack) {
    base.push("学生双肩背包重点：先按当前商品图识别真实包身颜色、图案、前袋、侧袋、肩带、拉链、挂件/配件和织物质感，再用校园/课桌/上学路场景证明外观颜值、轻便肩负、分区收纳与细节质感；不得沿用历史样例书包外观，不得改成成人通勤包、旅行登山包或带真实品牌 LOGO 的其他书包。");
    base.push("学生书包场景逻辑：上学画面要符合真实背负和收纳关系，书包背在学生肩上时肩带必须自然受力；课本、作业本、水杯只能作为无品牌道具辅助，不得让道具比书包更抢眼；不写护脊、防水、防盗、容量升数、承重测试、减负科技或材质认证。");
  } else if (context.isCup) {
    base.push("水杯类重点：用握持、桌面、书包/通勤收纳和杯身细节证明日常饮水便利，避免空泛生活方式图。");
    base.push("水杯饮用物理逻辑：任何“喝水、准备喝水、嘴巴靠近杯口/吸管”的画面，杯盖必须打开或翻开，必须露出吸管、直饮口、杯口或内胆开口；如果杯盖关闭，只能表现拿取、握持、收纳或桌面摆放，禁止人物对着关闭杯盖喝水。");
  } else if (context.isKitchenTextile) {
    base.push("厨房毛巾重点：用台面擦拭、水槽冲洗、近景绒感、多色分区和挂放收纳证明卖点；不能只做静物氛围图，不能虚构抗菌、除螨、速干、强力去油、材质成分比例或检测认证。");
  } else if (context.isSkincare) {
    base.push("护肤保湿霜重点：用黑银包装英雄图、膏体质地近景、手背/脸颊轻抹动作、成年女性露脸模特和高端梳妆台场景证明温和保湿与品质感；不能虚构成分、浓度、临床数据、医美功效、敏感肌适用、抗老、美白、祛痘、修护屏障或 24 小时保湿。");
  } else if (context.isPortableFan) {
    base.push("手持风扇重点：用户外高温通勤/排队/公园场景证明怕热时随手吹；用手持大小对比和放包动作证明便携；用桌面充电场景证明充电补能方便；只可表达用户提供的约 1 小时持续吹风，不虚构档位、风速、静音分贝、电池容量、快充瓦数或认证。");
  } else if (context.isPillow) {
    base.push("睡眠枕头重点：用波浪曲线、密集透气孔、手压柔软回弹、颈部贴合和卧室睡眠场景证明柔软舒适与颈部承托；不能虚构治疗失眠、治疗颈椎病、医学功效、材质认证、助眠数据或睡眠监测结果。");
  } else if (context.isLaundryDetergent) {
    base.push("洗衣液重点：用粉色瓶身标签、倒取动作、领口袖口日常污渍、洗衣泡沫、晾晒衣物与蔷薇花香场景证明温和、清洁力和香味；不能虚构除菌、抑菌、母婴适用、无荧光剂、检测认证、去污率或留香时长。");
  } else if (context.isSneaker) {
    base.push("男生运动鞋重点：用大商品英雄图、鞋面孔位微距、上脚走路、户外出街穿搭、鞋头鞋底细节证明高颜值、舒适和透气；保持黑色三条纹、黑金鞋舌标、金色侧边文字、绿色细节等商品本体外观；不虚构气垫、增高、防滑等级、专业跑步性能、联名或官方背书。");
  } else if (context.isPants) {
    base.push("裤装重点：先按当前商品图识别真实裤型、颜色、腰头、抽绳、裤腿宽度、裤脚、面料纹理和是否多色；用完整裤型、模特实穿/衣架平铺、走动坐下、衣橱/通勤场景、腰头抽绳微距和多角度分区证明宽松版型、垂感面料、细节和好搭。不得沿用历史机器、杯子、鞋子、尿布或其他品类外观。");
    base.push("裤装场景逻辑：裤子必须符合真实穿着和陈列关系，模特穿着时腰线、裤腿、裤脚和鞋子比例自然；平铺/衣架时重力和褶皱合理；不能把裤子画成硬质设备、装饰布、裙子、内衣或无下半身逻辑的悬浮物。不虚构防水、速干、抗菌、塑形科技、面料成分百分比或认证。");
  } else if (context.isApparel) {
    base.push("服装重点：先按当前商品图识别真实款式、颜色、版型、领口/袖口/腰头/下摆、图案、吊牌文字和面料纹理；用完整款式、实穿/平铺/衣架、日常搭配、细节微距和多角度展示证明版型、面料、做工和好搭。不虚构材质认证、功能科技或外部品牌。");
  } else if (context.isIntimateApparel) {
    base.push("成人女性内衣重点：用商品陈列、专业躯干模特或克制成年女性穿着场景证明版型、棉感材质和轻松穿着；表达优雅性感，不做低俗暴露、挑逗姿态或未成年暗示；不能虚构抑菌、塑形、无痕、无钢圈等未提供功能。");
    base.push("胸罩物理摆放硬规则：非穿着画面只能平铺在柔软织物/台面/抽屉内、自然垂挂在无品牌衣架/挂钩上，或由成年模特/专业躯干模特穿着；禁止像硬壳摆件一样竖立在桌面、柜面、抽屉边缘或不合理悬空。肩带必须自然垂落或受力悬挂，罩杯朝向和重心符合真实拍摄。");
  }
  return base.join("\n");
}

function buildReferenceLearningRule(analysis: ReferenceAnalysis, context: ProductContext): string {
  const visual = analysis.visualPatterns.slice(0, 5);
  const detail = analysis.detailPagePatterns.slice(0, 8).map((item) => context.isIntimateApparel ? softenSelectionLanguage(item) : item);
  if (!visual.length && !detail.length) {
    return "案例学习：本次未提供可用案例，按类目和卖点生成原创电商视觉结构。";
  }
  return [
    "案例学习抽象规则：只学习优秀案例的结构、节奏、排版层级、场景精细度和功能证明方法；不复制案例商品、图片、商标、价格、标题或原文案。",
    visual.length ? `主图学习点：${visual.join("；")}` : "",
    detail.length ? `详情页学习点：${detail.join("；")}` : ""
  ].filter(Boolean).join("\n");
}

function buildBrandVisualLogicRule(analysis: ReferenceAnalysis, context: ProductContext): string {
  const logic = (analysis.brandVisualLogic ?? []).slice(0, 8).map((item) => context.isIntimateApparel ? softenSelectionLanguage(item) : item);
  if (!logic.length) {
    return "品牌化设计逻辑：先统一色彩、光线、字体层级和图形语言，再按主图/详情页转化任务拆屏；每屏有清楚购买理由和画面证据。";
  }
  return [
    "品牌化设计逻辑：参考案例分析的视觉方法必须转译为本商品原创设计。",
    ...logic.map((item, index) => `${index + 1}. ${item}`)
  ].join("\n");
}

function buildDesignReviewStandardRule(analysis: ReferenceAnalysis, context: ProductContext): string {
  const rules = (analysis.designReviewRules ?? []).slice(0, 10).map((rule) => context.isIntimateApparel ? softenSelectionLanguage(rule) : rule);
  const fallback = [
    "首图商品是否足够大，移动端 3 秒内能否看清商品和第一卖点。",
    "套图是否共用同一色彩、光线、字体层级和图形语言。",
    "每张图是否只承担一个转化任务，卖点是否有画面证据。",
    context.isIntimateApparel
      ? "详情页是否按价值、顾虑、材质、版型、细节、衣橱场景、收尾推进。"
      : context.isAiRobot
        ? "详情页是否按价值、家长顾虑、AI对话、早教学习、关节表情、多姿态表情、送礼桌搭、生活收尾推进；是否每屏都有不同姿势和不同LED表情。"
      : context.isChildProduct && context.isCup && !context.isTemperatureDisplay
        ? "详情页是否按价值、妈妈顾虑、耐热证据、家庭场景、杯盖把手、多角度、上学携带、收尾推进。"
        : context.isPillow
          ? "详情页是否按价值、睡前顾虑、手压柔软、颈部承托、透气孔、卧室场景、收尾推进。"
        : context.isBabyCare
          ? "详情页是否按价值、父母顾虑、吸收表现、育儿台场景、样片细节、多角度、外出准备、收尾推进。"
        : context.isCuttingBoard
          ? "详情页是否按价值、切配顾虑、硬度证明、厨房场景、木纹细节、多角度、冲洗收纳、收尾推进。"
        : context.isMagneticLifter
          ? "详情页是否按价值、吊装顾虑、吸附证明、户外/车间工况、结构细节、规格参数、无需用电、工业收尾推进。"
        : context.isStudentBackpack
          ? "详情页是否按价值、上学收纳顾虑、肩带轻便证据、校园场景、细节、多角度、上学收纳决策、收尾推进。"
        : context.isPants
          ? "详情页是否按价值、穿着顾虑、版型动作证明、居家/通勤场景、腰头面料细节、多角度裤型、衣橱搭配、收尾推进。"
        : context.isApparel
          ? "详情页是否按价值、穿搭顾虑、版型证明、日常搭配、面料做工、多角度、衣橱决策、收尾推进。"
        : context.isLaundryDetergent
          ? "详情页是否按价值、污渍顾虑、倒取动作、清洁过程、花香衣物、瓶身标签、洗衣动线、收尾推进。"
        : context.isSneaker
          ? "详情页是否按价值、穿搭顾虑、鞋面透气、户外上脚、鞋头鞋底、黑白金细节、出街场景、收尾推进。"
        : "详情页是否按价值、顾虑、证据、场景、细节、选择建议、收尾推进。",
    "是否没有乱码、随机英文、竞品商标、水印和虚构数据。"
  ];
  return [
    "设计审核标准：生成时必须提前满足以下审核清单，像电商品牌视觉总监自检后再交付。",
    ...(rules.length ? rules : fallback).map((item, index) => `${index + 1}. ${item}`)
  ].join("\n");
}

function buildTypographySystemRule(context: ProductContext): string {
  if (context.isEnglishMarketplace) {
    return [
      "Typography system: use one clean modern sans-serif family across the whole set. Headlines, subheads, badges, numbers, and small labels must differ only by size, weight, color, spacing, and layout.",
      "Visible copy must be natural English only. Do not add Chinese text, random letters, lorem ipsum, fake UI labels, fake ratings, review stars, prices, sales volume, Best Seller badges, or unsupported certification icons.",
      "Keep hierarchy simple: maximum three text levels per image. Headline is short and benefit-led; support copy is concise; labels must be attached to visible product evidence.",
      "Layout should feel like a credible overseas marketplace product listing: clean whitespace, clear product-first composition, restrained callouts, and no noisy sale-sticker collage.",
      "Use thin lines, simple arrows, dot markers, detail magnifier circles, and clean information blocks only when they help prove a visible selling point. Text must not cover the product's key structure."
    ].join("\n");
  }
  const rules = [
    "排版系统：学习高阶淘宝/天猫与站酷详情案例的短句大层级、强留白、局部放大和信息块节奏；文字是画面构成的一部分，不是说明书段落。",
    "字体系统硬规则：一个产品体系只允许一种中文营销文案字体家族。全套主图和详情页统一使用现代黑体/思源黑体/阿里巴巴普惠体/PingFang SC 风格；标题、副标题、胶囊标签、数字和小字都属于同一字体家族，只通过字号、字重、颜色、间距和排版区分层级。不得混用宋体、手写体、卡通字、花体字、随机英文或第二种字体。",
    "层级系统：每屏最多 3 个文字层级；主标题 1-2 行，副标题跟随同一文本组，第三句做小胶囊、细线信息条或轻量标签；三句不能同字号同字重排成普通三行。",
    "网格系统：文字锚定一处安全留白，左对齐、右对齐或品牌感居中只能选一种；主图文字区占画面 18%-30%，详情页文字区占画面 16%-28%；商品和画面证据优先于文字。",
    "图形系统：允许无文字短横线、竖线、圆点、细框、半透明底板、局部放大圈、箭头和极简线性 ICON 承托文案；图形颜色必须来自全案色板，不能像促销贴纸。",
    "移动端可读：标题行距紧而不挤，副标题与标题保持清楚间距；文字不得贴边、压住商品关键结构、漂浮在杂乱背景上或与人物脸部重叠。"
  ];
  if (context.isSkincare) {
    rules.push("高端护肤版式：偏杂志留白和奢侈品柜台秩序，黑银包装旁使用香槟金细线、窄边框或水光弧线托住文字；标题克制有气场，不做粉色甜美风和促销感大字。");
  } else if (context.isIntimateApparel) {
    rules.push("成熟女性内衣版式：暖白画册感、标题克制优雅，可用细线、柔雾色块和局部材质放大圈；避免低俗大字、性感夸张词视觉化和杂乱标签堆叠。");
  } else if (context.isKitchenTextile) {
    rules.push("家清厨房版式：信息清楚、动作证据明确，可用一条主标题配小标签和无文字流程线；颜色服务多色毛巾识别，不能做廉价彩虹促销条。");
  } else if (context.isPillow) {
    rules.push("睡眠寝具版式：像高端床品画册，标题短而安静，留白充足，可用柔和弧线、浅色半透明信息区和局部放大圈托住透气孔/曲线证据；不要医疗报告风、睡眠数据风或大促销字。");
  } else if (context.isLaundryDetergent) {
    rules.push("家清洗护版式：清新干净但有品牌秩序，主标题靠近衣物/倒取/标签证据，可用细线、局部放大圈、小胶囊承托清洁和花香信息；不要廉价爆炸贴、参数表堆叠或夸张去污对比图。");
  } else if (context.isSneaker) {
    rules.push("男鞋穿搭版式：标题有力量但克制，黑白灰大留白配金色细线或短横，文字靠近鞋面孔位、上脚动作或黑白金细节；不要潮牌乱贴纸、霓虹涂鸦和满屏英文字母。");
  } else if (context.isPants) {
    rules.push("裤装服饰版式：像成熟天猫女装/休闲服详情页，标题大而克制，围绕裤型轮廓、腰头抽绳、面料纹理和穿搭场景布置；可用短横线、细线标注、局部放大圈、衣橱浅色信息块和少量几何图形增加设计感；不要普通 PPT 大字、空泛模块名、满屏规格表或廉价服装促销贴。");
  } else if (context.isApparel) {
    rules.push("服装穿搭版式：标题服务版型和搭配证据，文字靠近实穿轮廓、面料微距或衣橱场景；可用短横、细线、局部放大圈和低饱和信息块承托文案；不要把任务描述、尺码建议或页面模块名当成消费者文案。");
  } else if (context.isBabyCare) {
    rules.push("婴儿护理版式：亲和、干净、可信，文字靠近包装/样片/父母手部整理证据；可用浅色圆角信息区和局部放大圈，但不能做医疗检测报告风或母婴焦虑恐吓。");
  } else if (context.isCuttingBoard) {
    rules.push("厨房木作版式：像高端厨具品牌画册，标题靠近切菜、冲洗、木纹或挂放证据；可用木色细线、局部放大圈和浅色信息区，不能做廉价厨房小商品促销风。");
  } else if (context.isMagneticLifter) {
    rules.push("工业设备版式：像专业 B2B 工业设备详情页，标题有力量但克制，使用黑黄安全色、深灰钢材底色、参数信息块、细线标注和结构放大圈；不能做生活用品小清新、廉价红色促销条或杂乱参数海报。");
  } else if (context.isStudentBackpack) {
    rules.push("学生书包版式：清爽校园电商风，暖白与浅木打底，跟随当前商品图的真实主色、图案或结构形成记忆点，少量校园浅蓝/薄荷绿点缀；标题亲和但不幼稚，可用细线、局部放大圈、纸张卡片形图形和极简校园 ICON 承托文案；不要开学大促红字、幼稚贴纸墙或满屏参数表。");
  } else if (context.isAiRobot) {
    rules.push("AI机器人版式：儿童智能硬件感，暖白大留白、商品黄色主体、科技蓝光效和银灰细线统一；可用语音波纹、局部放大圈、极简互动图形承托文案，但不能做幼稚贴纸墙、游戏UI杂乱光效、竞品Logo或满屏参数表。");
  } else if (context.isChildProduct) {
    rules.push("儿童亲子版式：圆润亲和但保持天猫品牌感，可用小圆点、柔和色块和轻量线性 ICON；不要幼稚贴纸化，也不要让文字盖住儿童正脸或商品。");
  }
  return rules.join("\n");
}

function buildTypographyCompositionRule(copy: string[], role: string, aspectRatio: "1:1" | "9:16"): string {
  const cleanCopy = copy.map((line) => line.trim()).filter(Boolean);
  const [headline, subline, support] = cleanCopy;
  const extras = cleanCopy.slice(3);
  const isDetail = aspectRatio === "9:16";
  const canvasRule = isDetail
    ? "9:16 详情页采用竖向阅读节奏：上方或中上方建立标题组，中段给画面证据，下段留呼吸感；不要把文字堆在整屏中心。"
    : "1:1 主图采用货架秒读节奏：商品先大，文字组占一个清楚角落或边侧留白，不能抢走商品第一主体。";
  const roleRule = typographyRoleRule(role, isDetail);
  return [
    "高级文字版式总控：把指定文案设计成一个完整品牌信息组，而不是把几行字直接叠在照片上。",
    headline ? `文字层级：第1句「${headline}」作为主标题，最大、最稳、最先被读到，可换行但不能拆字造词。` : "",
    subline ? `第2句「${subline}」作为副标题，靠近主标题下方或侧边，字号约为主标题的 45%-60%，字重明显降低。` : "",
    support ? `第3句「${support}」作为辅助标签、细线信息条或小胶囊，字号约为主标题的 30%-42%，用来补充购买理由。` : "",
    extras.length ? `其余指定文字「${extras.join("」「")}」作为同一组轻量标签或并列信息点，必须同轴对齐、等间距排列，不要散落到画面各处。` : "",
    canvasRule,
    roleRule,
    "对齐与间距：同一文本组只能使用一种对齐轴，标题/副标题/标签之间形成明确间距节奏；留白要像品牌画册，不能散点式到处放字。",
    "图形承托：可使用无文字细线、短横、圆点、浅色底板、透明磨砂信息区、局部放大圈或箭头连接画面证据；图形只增强层级，不新增任何文字。",
    "排版禁忌：不要把三句文案排成同字号三行；不要满屏散字、粗描边、重投影、爆炸贴、廉价渐变字、竖排乱排或装饰乱码；不要把任务描述、转化目标、案例学习词变成可见文案。"
  ].filter(Boolean).join("\n");
}

function typographyRoleRule(role: string, isDetail: boolean): string {
  if (/首图|英雄|首屏/.test(role)) {
    return isDetail
      ? "首屏版式：主标题压在高质量留白处，商品英雄图必须比标题更强；标题组形成开场气质，不出现参数表或多标签墙。"
      : "首图版式：商品体量优先，标题组只占一个稳定视觉锚点；用一条细线或小色块把卖点和商品方向连接起来。";
  }
  if (/证明|功能|温和|擦拭|好洗|上脸|痛点|顾虑/.test(role)) {
    return "证据型版式：文字必须靠近动作或功能证据，使用细线/箭头/局部放大圈建立对应关系，避免文案和画面各说各话。";
  }
  if (/细节|质地|材质|包装|杯身|肩带|绒感/.test(role)) {
    return "细节型版式：标题小而精，留给局部特写足够空间；可用一主两辅局部放大结构，文字避开纹理和关键边缘。";
  }
  if (/场景|日常|衣橱|厨房|收纳|上学|早晚/.test(role)) {
    return "场景型版式：文案像生活方式标题，放在自然光留白或干净墙面处；不要把说明文字压在人物脸部、手部动作或商品上。";
  }
  return isDetail
    ? "详情模块版式：标题组、画面证据和留白形成纵向节奏，每屏只服务一个购买理由。"
    : "主图模块版式：文字组短、准、有层级，服务货架点击和单一购买理由。";
}

function softenSelectionLanguage(value: string): string {
  return value
    .replace(/规格\/选择建议/g, "衣橱/内搭场景")
    .replace(/规格选择/g, "衣橱场景")
    .replace(/选择建议/g, "衣橱场景")
    .replace(/降低选择成本/g, "降低场景理解成本")
    .replace(/最后给规格和衣橱场景/g, "最后给衣橱和内搭场景")
    .replace(/最后给规格和选择建议/g, "最后给衣橱和内搭场景");
}

function buildPalette(task: ProductTask, brand: BrandProfile, context: ProductContext): string {
  if (context.isStudentBackpack) {
    return "全域色彩：主色清爽暖白 #F8F5EE；当前商品图里的真实包身主色、图案色和配件色作为第一记忆点；辅助色浅木色 #D8BE98 与校园浅蓝 #A8CDE8；点缀色低饱和薄荷绿 #95C8B7；文字炭黑 #232323；整体明亮、干净、校园上学感，避免廉价开学促销红、夜店潮牌风或幼稚杂色贴纸。";
  }
  if (context.isAiRobot) {
    return "全域色彩：主色清爽暖白 #F8F6EF；商品明亮黄色 #FFD436 作为第一记忆点；辅助色科技蓝 #4DA8FF 与银灰 #C8CCD2；少量黑色 #17191D 呼应关节和面框；文字深蓝黑 #172333；整体亲和儿童智能硬件、高颜值桌面玩具、柔和科技光，避免廉价大促红、杂乱霓虹和过冷工业蓝。";
  }
  if (context.isChildProduct && context.isYellowProduct) {
    return "全域色彩：主色奶油白 #F8F2E8；商品识别色明亮黄色 #FFD83D；辅助色角色蓝 #7EB8DE；点缀色胡萝卜橙 #F27A2E；文字深棕黑 #3A261B；整套图统一暖自然光，绝不跳色、杂色或突然换风格。";
  }
  if (context.isChildProduct && context.isCup) {
    return "全域色彩：主色清爽暖白 #F7F4EE；辅助色浅木色 #D8B989；功能点缀色清透蓝 #78B8E8；童趣小面积点缀色阳光黄 #F6C84C；文字深灰黑 #27313A；整体明亮干净、亲和可信，避免冷硬科技蓝和廉价促销红。";
  }
  if (context.isIntimateApparel) {
    return "全域色彩：主色暖象牙白 #F8F3EE；商品红色作为品牌记忆主视觉；辅助色柔雾玫瑰 #D9A0A5；细节线条用香槟金 #C6A46A；文字深酒红黑 #331D24；整体成熟女性、干净高级、柔和自然光，避免廉价大红促销和低俗夜店感。";
  }
  if (context.isKitchenTextile) {
    return "全域色彩：主色清洁暖白 #F7F4EF；商品多色毛巾作为第一记忆点，保留浅蓝、淡粉、柔紫、米咖、浅灰等低饱和颜色；辅助色浅木色 #D8BE9B；点缀色清透薄荷绿 #8FC7B5；文字深灰褐 #302A27；整体干净、明亮、家庭厨房真实感，避免廉价彩虹杂乱和强促销红。";
  }
  if (context.isSkincare) {
    return "全域色彩：主色珍珠白 #F8F7F3；商品黑色罐身作为高端记忆点；辅助色镜面银 #C8C8C5；点缀色香槟金 #C8A760；少量清透水光蓝 #BFDCE8；文字深曜石黑 #151515；整体高端护肤、干净奢雅、柔和棚拍光，避免廉价粉色、强促销红和杂乱科技蓝。";
  }
  if (context.isPortableFan) {
    return "全域色彩：主色清爽天空蓝 #BFE8FF；商品薄荷绿 #A8E7D4 作为第一记忆点；点缀色爱心黄 #FFD85A；辅助色夏日暖白 #FFF8ED；文字深海军蓝 #203445；整体清爽、轻快、户外夏天有风感，避免廉价荧光色、重促销红和杂乱彩虹背景。";
  }
  if (context.isPillow) {
    return "全域色彩：主色暖象牙白 #F7F1E8；商品奶油白 #EFE8DC 作为柔软睡感记忆点；辅助色浅木色 #D9BE9D；点缀色低饱和鼠尾草绿 #AEBFAF；文字深咖黑 #2F261F；整体安静、柔软、卧室自然光，不做医疗蓝和强促销红。";
  }
  if (context.isLaundryDetergent) {
    return "全域色彩：主色干净暖白 #FAF7F1；商品粉色瓶身 #F4A7B8 作为第一记忆点；辅助色浅玫瑰 #E6C4CB；点缀色叶绿 #8FB58F；文字深梅褐 #3B252B；整体清新家务、花香洁净、明亮洗衣房质感，避免廉价促销红和杂乱彩虹色。";
  }
  if (context.isBabyCare) {
    return "全域色彩：主色柔和暖白 #FAF6EE；辅助色浅木色 #D9C0A0；点缀色低饱和奶黄 #F5D27A 和柔和浅蓝 #A9CFE8；文字深暖灰 #2F2A25；整体干净、亲和、可信的婴儿护理感，避免医疗冷蓝、恐吓红和廉价促销色。";
  }
  if (context.isTissue) {
    return "全域色彩：主色温润米白 #F7F1E8；商品包装蓝白牡丹花纹和织梦蓝色标识作为第一记忆点；辅助色浅木色 #D9BE9A 与干净瓷白 #FFFFFF；点缀色清新叶绿 #8DBB66 仅小面积使用；文字深蓝黑 #183756；整体干净、柔和、家庭常备用纸质感，避免廉价促销红、杂乱彩虹色和医疗冷蓝。";
  }
  if (context.isCuttingBoard) {
    return "全域色彩：主色厨房暖白 #F7F3EA；商品乌檀木深棕 #5A3524 作为第一记忆点；辅助色浅木色 #D4B58A；点缀色清水蓝灰 #9BB8B7 和蔬果自然绿 #7FA36B；文字深咖黑 #2B211B；整体高级厨具、干净家庭厨房、自然光，不做廉价红黄促销风。";
  }
  if (context.isMagneticLifter) {
    return "全域色彩：主色工业深灰 #2C3035；商品安全黄 #F6C21A 作为第一记忆点；辅助色钢材银灰 #AEB4B8；点缀色安全红 #D71920 只用于少量警示/参数强调；背景用水泥灰 #E7E8E6 与户外工地自然光；文字炭黑/白色高对比，整体专业工业设备、B2B 可信、硬朗克制，不做廉价满屏红黄促销风。";
  }
  if (context.isSneaker) {
    return "全域色彩：主色清爽白 #F8F8F4；商品白色鞋身与黑色三条纹形成第一记忆点；辅助色浅水泥灰 #CFCFC8；点缀色 muted gold #B99145 和少量绿色 #6FA36F；文字炭黑 #1F1F1D；整体干净街头、男生日常穿搭，不做夜店霓虹或廉价潮牌海报。";
  }
  if (context.isPants) {
    return "全域色彩：主色温润米白 #F7F1E8；当前商品图里的真实裤子颜色作为第一记忆点；辅助色浅木色 #D7BE98 与衣橱暖灰 #C8C0B6；点缀色低饱和姜黄 #D8AB45；文字深咖黑 #312620；整体像成熟天猫女装/休闲服画册，暖白自然光、干净衣橱和通勤场景统一，避免廉价大促红、夜店潮牌黑金和杂乱撞色。";
  }
  if (context.isApparel) {
    return "全域色彩：主色温润米白 #F7F1E8；当前商品图里的真实服装颜色作为第一记忆点；辅助色浅木色 #D7BE98 与衣橱暖灰 #C8C0B6；点缀色低饱和金棕 #C49A48；文字深咖黑 #312620；整体干净、成熟、有品牌穿搭感，避免廉价促销红和杂乱街拍滤镜。";
  }
  const visualKeywords = brand.visualKeywords.length ? `；视觉关键词 ${brand.visualKeywords.join("、")}` : "";
  return `全域色彩：主背景 ${brand.backgroundColor}；品牌主色 ${brand.primaryColor}；辅助色 ${brand.secondaryColor}；文字深色；全案色温、光影和道具色彩统一${visualKeywords}；绝不跳色、杂色或突然换风格。`;
}

function buildSceneRule(task: ProductTask, context: ProductContext): string {
  if (context.isAiRobot) {
    return "场景系统：国内儿童智能硬件/早教玩具电商审美，明亮儿童书桌、亲子阅读角、家庭客厅、无品牌礼盒、桌面摆件区、浅木学习桌、绘本、单词卡、积木和柔和科技光；重点是黄色AI机器人在不同场景下主动互动、换姿势、换LED表情，所有道具无真实品牌 LOGO，不出现竞品商标。";
  }
  if (context.isStudentBackpack) {
    return "场景系统：国内学生上学真实审美，明亮校门、校园步道、浅木课桌、学习区、教室座椅、上学前玄关；道具可有无品牌课本、作业本、铅笔盒、水杯和校服感衣物，但必须克制且无真实 LOGO；重点是书包完整外观、肩带背负、前袋侧袋、配件如有和上学收纳关系，空间光线自然清爽。";
  }
  if (context.isChildProduct && context.isFootwear) {
    return "场景系统：国内精致亲子家庭审美，奶油白墙面、浅木玄关/卧室、燕麦色地毯、低饱和软装、干净收纳区；材质肌理、空间光影、生活道具都细腻真实；所有道具无真实品牌 LOGO。";
  }
  if (context.isChildProduct && context.isCup) {
    return "场景系统：国内 8-10 岁儿童/小学生真实生活审美，明亮书桌、浅木学习区、干净书包侧袋、上学前餐桌、课间桌面；道具可有书本、铅笔、便签、无品牌书包，但必须克制且无真实 LOGO；空间光线自然，商品始终清楚。";
  }
  if (context.isSkincare) {
    return "场景系统：国内高端护肤审美，珍珠白梳妆台、镜面银反射、柔焦浴室柜、干净化妆棉、透明水滴、浅色丝缎、克制花材；重点是包装质感、膏体质地、上脸动作和水润肤感证据，所有道具无真实品牌 LOGO。";
  }
  if (/美妆|护肤|面霜|精华|口红|粉底|洗护/.test(context.text)) {
    return "场景系统：国内高端梳妆台/浴室柜审美，干净台面、柔和反射、细腻包装材质、克制植物或织物点缀；所有道具无真实品牌 LOGO。";
  }
  if (context.isIntimateApparel) {
    return "场景系统：国内成熟女性内衣电商审美，暖白影棚、浅色衣帽间、柔软织物台面、无品牌衣架、折叠棉布、磨砂玻璃或浅木抽屉；材质肌理和商品轮廓必须清楚，空间克制高级，所有道具无真实品牌 LOGO。";
  }
  if (context.isKitchenTextile) {
    return "场景系统：国内干净家庭厨房审美，暖白瓷砖、浅木台面、白色水槽、无品牌陶瓷碗盘、透明水滴、少量绿植或餐具；重点是擦拭、清洗、挂放和收纳的真实流程，空间明亮清爽，所有道具无真实品牌 LOGO。";
  }
  if (context.isPortableFan) {
    return "场景系统：国内夏日户外通勤审美，浅蓝天空、城市步道、公交站/地铁口外、户外咖啡桌、公园长椅、野餐布、无品牌帆布包、太阳镜和水杯；重点是怕热时手持吹风、放包便携、桌面充电和清爽外观，所有道具无真实品牌 LOGO。";
  }
  if (context.isPillow) {
    return "场景系统：国内安静卧室睡眠审美，暖白床品、浅木床头、亚麻被套、柔和晨光或睡前床头灯、少量无品牌书本/睡衣/水杯；重点是波浪曲线、透气孔、手压柔软和颈部承托证据，所有道具无真实品牌 LOGO。";
  }
  if (context.isLaundryDetergent) {
    return "场景系统：国内干净家庭洗衣房审美，白色洗衣机、浅色台面、无品牌洗衣篮、晾晒衣物、细腻泡沫、少量玫瑰/蔷薇花材；重点是粉色瓶身、倒取动作、日常污渍处理和洗后清新场景，所有道具无真实品牌 LOGO。";
  }
  if (context.isBabyCare) {
    return "场景系统：国内干净婴儿房/育儿台审美，浅木护理台、柔和暖白背景、无品牌收纳篮、干净折叠样片、湿巾盒、棉柔巾、父母手部整理动作；重点是包装、样片纹理、吸收层和日常护理准备，所有道具无真实品牌 LOGO。";
  }
  if (context.isTissue) {
    return "场景系统：国内干净家庭用纸审美，浅木餐桌、客厅茶几、厨房台面、玄关柜或卧室床头柜；道具可有无品牌水杯、餐盘、遥控器、收纳篮、浅色花材和少量绿叶，但必须克制；重点是抽取动作、擦拭动作、纸张压纹、蓝白花纹包装和家庭随手取用关系，所有道具无真实品牌 LOGO。";
  }
  if (context.isCuttingBoard) {
    return "场景系统：国内干净家庭厨房审美，暖白瓷砖、浅木台面、不锈钢水槽、无品牌菜刀、蔬果食材、清水水流、挂放收纳区；重点是乌檀木菜板、切配动作、冲洗方便、木纹边角和厨房做饭场景，所有道具无真实品牌 LOGO。";
  }
  if (context.isMagneticLifter) {
    return "场景系统：国内工业设备/B2B 电商审美，户外钢材堆场、工地吊装区、机械加工车间、钢板仓储区、无品牌吊钩吊链、H 型钢/钢板/钢管、水泥地面、远处安全围栏；重点是永磁起重机吸附钢板、低高度吊装、无需用电、结构细节和参数信息，所有机械和道具无真实品牌 LOGO。";
  }
  if (context.isSneaker) {
    return "场景系统：国内男生日常出街审美，浅灰水泥台阶、城市步道、校园入口、公园长椅、干净街区、牛仔裤或运动裤穿搭；重点是大商品、鞋面孔位、上脚走路和黑白金细节，所有道具无真实品牌 LOGO。";
  }
  if (context.isPants) {
    return "场景系统：国内成熟女装/休闲裤电商审美，暖白衣橱、浅木地板、干净客厅、咖啡店门口、通勤街区、镜前试穿、无品牌基础上衣/鞋包；重点是裤型完整、腰头抽绳、裤腿垂感、面料纹理、两色/多色如参考图可见和居家通勤搭配，所有道具无真实品牌 LOGO。";
  }
  if (context.isApparel) {
    return "场景系统：国内成熟服饰穿搭审美，暖白衣橱、浅木卧室、镜前试穿、干净通勤街区、咖啡店外、无品牌基础上衣/裤装/鞋包；重点是完整款式、版型轮廓、面料细节和日常搭配，所有道具无真实品牌 LOGO。";
  }
  if (/食品|零食|茶|咖啡|饮品|坚果|水果/.test(context.text)) {
    return "场景系统：国内品质餐桌/厨房审美，干净台面、自然食物肌理、柔和晨间光、少量同色系餐具；所有道具无真实品牌 LOGO。";
  }
  return `场景系统：围绕${task.category || "产品使用"}搭建国内消费者熟悉的高级日常空间，材质、肌理、光影和软装细节真实克制；所有道具无真实品牌 LOGO。`;
}

function buildModelRule(task: ProductTask, context: ProductContext): string {
  const targetAudience = usefulTargetAudience(task);
  if (context.isAiRobot) {
    return "人物系统：人物不是主角。如出现孩子或家长，只使用手部、侧脸、背影或远景辅助互动，服务书桌学习、亲子阅读和语音问答动作；机器人始终是主体。人物动作安全自然，不出现夸张教育结果、医疗暗示或危险把玩。";
  }
  if (context.isStudentBackpack) {
    const faceRule = context.canShowFace ? "允许露出自然正脸或侧脸，表情干净自然" : "不展示正脸，可用背影、侧脸或半身裁切";
    return `人物系统：如出现学生，整套图保持同一名 8-13 岁学生模特，同一清爽校园穿搭；${faceRule}；人物用于证明上学背负比例、肩带受力和校园使用场景，书包永远是主体。`;
  }
  if (context.isChildProduct) {
    if (context.isBabyCare) {
      return "人物系统：优先只出现成年父母手部整理、拿取、收纳商品；如出现婴儿，只能是穿完整衣物的远景或被家长抱在背景中，不能出现换尿布、裸露身体、下半身特写或贴身穿戴展示；人物服务商品，不抢主体。";
    }
    const faceRule = context.canShowFace ? "允许露出儿童正脸，表情自然，不做夸张摆拍" : "不展示儿童正脸，可用背影、侧脸或膝盖以下裁切";
    const childModel = normalizeChildModelAudience(task.targetAudience);
    return `人物系统：如出现儿童，整套图必须是同一名${childModel}儿童模特；${faceRule}；人物服务商品，不抢主体。`;
  }
  if (context.isIntimateApparel) {
    return `人物系统：优先使用商品平铺、衣架陈列或专业躯干模特；如出现真人，必须是符合“${task.targetAudience || "成年女性"}”的成年女性，姿态自然克制，不露骨、不挑逗、不未成年化；人物裁切服务版型说明，商品永远是主体。`;
  }
  if (context.isSkincare) {
    const faceRule = context.canShowFace ? "允许露出成年女性正脸，皮肤真实干净、表情自然高级" : "不展示正脸，可用侧脸、手部或脸颊局部裁切";
    return `人物系统：如出现模特，整套图保持同一名符合“${task.targetAudience || "爱美女性"}”的成年女性模特；${faceRule}；不未成年化、不医美术后感、不夸张磨皮，人物服务肤感和使用动作，商品仍是主体。`;
  }
  if (context.isPillow) {
    return `人物系统：如出现人物，整套图保持同一名符合“${task.targetAudience || "成年人"}”的成年模特；可露出自然侧脸或闭眼休息状态，表情放松克制；人物服务颈部承托和睡前场景，不做医疗康复姿态。`;
  }
  if (context.isLaundryDetergent) {
    return `人物系统：如出现人物，优先使用同一名成年家庭用户的手部、背影或半身，符合“${task.targetAudience || "家庭洗衣用户"}”；人物服务倒取、洗衣和晾晒动作，不抢粉色瓶身主体。`;
  }
  if (context.isTissue) {
    return `人物系统：如出现人物，优先使用同一名符合“${task.targetAudience || "家庭用户"}”的成年女性/家庭用户手部、半身或背影；人物服务抽取、擦拭、餐桌整理和家务动作，不抢抽纸盒主体，不遮挡包装蓝白花纹和原有商品文字。`;
  }
  if (context.isSneaker) {
    return `人物系统：如出现人物，整套图保持同一名符合“${task.targetAudience || "年轻男生"}”的年轻男生模特，同一干净出街穿搭；可拍下半身、系鞋带动作或自然走路，人物服务鞋子，不抢商品主体。`;
  }
  if (context.isPants) {
    const faceRule = context.canShowFace ? "可露出自然正脸或侧脸，表情克制真实" : "不展示正脸，可用半身、下半身、侧脸或背影";
    return `人物系统：如出现模特，整套图保持同一名符合“${task.targetAudience || "成年女性日常穿搭用户"}”的成年模特，同一简洁上衣、鞋包和发型；${faceRule}；人物用于证明裤型比例、走动坐下和衣橱/通勤搭配，裤子永远是主体。`;
  }
  if (context.isApparel) {
    const faceRule = context.canShowFace ? "可露出自然正脸或侧脸，表情克制真实" : "不展示正脸，可用半身、下半身、侧脸或背影";
    return `人物系统：如出现模特，整套图保持同一名符合“${task.targetAudience || "成年日常穿搭用户"}”的成年模特，同一穿搭风格和光线；${faceRule}；人物用于证明版型和搭配，服装商品永远是主体。`;
  }
  if (context.isMagneticLifter) {
    return "人物系统：如出现人物，只出现成年工业工人，佩戴安全帽、手套和工作服；人物用于体现操作比例和规范工况，不展示正脸特写，不站在悬吊钢材下方，不抢黄色永磁起重机主体。";
  }
  if (targetAudience) {
    return `人物系统：如出现人物，整套图保持同一名符合“${targetAudience}”的人物模特、同一服装色系、同一空间和光线；人物服务商品，不抢主体。`;
  }
  return "人物系统：如出现人物，整套图保持同一名模特、同一服装色系、同一空间和光线；人物服务商品，不抢主体。";
}

function buildConsistencyRule(task: ProductTask, context: ProductContext): string {
  if (context.isAiRobot) {
    return "套图一致性：固定同一款黄色AI机器人，保留参考图中的圆润大头机身、黄色主体、黑色关节和手脚、银色耳机装饰、银色面框、深蓝LED表情屏、蓝色发光眼睛、短手臂短腿和儿童友好比例；整套图使用同一暖白+清爽科技蓝+黄色点缀色彩系统。不同画面必须改变姿势、手臂/腿部动作、头部朝向、LED表情、场景和镜头距离，但不得把商品改成陌生机器人、金属工业机器人、卡通动物、无屏玩具或其他颜色款式。";
  }
  if (context.isStudentBackpack) {
    return "套图一致性：固定同一款学生双肩背包，先以当前商品图识别并保留真实包身颜色、图案、前袋、手提带、侧袋、肩带、挂件/配件如有、圆润包型、拉链走线和织物质感；整套图使用同一清爽暖白+校园浅蓝+浅木色彩系统和同一名学生模特。不同画面只改变正面英雄图、背负动作、校园/课桌场景、细节微距、多角度信息版和收尾构图，不把书包改成成人通勤包、旅行登山包、其他图案或带真实品牌 LOGO 的书包。";
  }
  if (context.isChildProduct && context.isFootwear) {
    return "套图一致性：固定同一名约5岁儿童，圆脸、自然黑色短发或齐耳短发、浅肤色、干净笑容；固定浅蓝色居家套装，上衣胸前可有小胡萝卜点缀；5张图使用同一间奶油白+浅木色居家空间、同一柔和自然光、同一产品摆放比例。出现脚部时，儿童双脚必须穿同一双黄色拖鞋，不能出现白鞋、运动鞋、袜鞋或第二双其他鞋。禁止换成不同年龄、不同性别感、不同发型或不同服装的儿童。";
  }
  if (context.isIntimateApparel) {
    return "套图一致性：固定同一款红色胸罩、同一暖白+柔雾玫瑰色彩系统、同一柔和影棚光；主图和详情页只改变陈列方式、取景距离和功能证明角度，不改变红色、罩杯轮廓、肩带、下围和棉感纹理。所有静物场景必须符合真实内衣拍摄逻辑：平铺、衣架垂挂、抽屉内平放或衣橱自然收纳，禁止竖立摆放和悬空。";
  }
  if (context.isChildProduct && context.isCup) {
    return "套图一致性：固定同一只儿童保温杯，保留黄色杯盖、蓝色双把手、米色杯身、杯身卡通图案、杯身原有 JUMP 与 THERMOS 等商品本体文字、杯体比例和塑料/保温杯质感；整套图使用同一名 8-10 岁短黑发男孩儿童模特、同一明亮亲子家庭光线和清爽暖白+蓝黄配色。不同画面只改变杯盖杯口近景、餐桌、书桌、书包、手部操作和多角度信息版，不把商品改成普通水壶、成人杯、无字杯、其他颜色或不同儿童。";
  }
  if (context.isKitchenTextile) {
    return "套图一致性：固定同一组多色厨房毛巾，保留参考图的叠放层次、柔软绒毛纹理、低饱和浅蓝/淡粉/柔紫/米咖/浅灰色系、厚度和布边；不同画面只改变擦拭、冲洗、挂放、收纳和取景距离，不把毛巾变成纸巾、海绵、一次性抹布或带品牌图案的布。";
  }
  if (context.isSkincare) {
    return "套图一致性：固定同一款黑色圆罐保湿霜，保留黑色光泽罐身、镜面银色盖、圆柱比例、厚重高端包装、瓶身/包装原有文字图案和可见膏体质感；不复刻外部参考图英文品牌商标，不在背景或装饰上新增随机英文。整套图使用同一名成年女性模特、同一珍珠白+黑银金色彩系统和同一柔和高端棚拍光。";
  }
  if (context.isPortableFan) {
    return "套图一致性：固定同一款薄荷绿色手持小风扇，保留圆形扇罩、可见扇叶、猫脸表情、黄色爱心装饰、机身圆润比例、开关键位置和小巧手持尺寸；整套图使用同一清爽天空蓝+薄荷绿+爱心黄配色，同一夏日自然光。不同画面只改变手持、放包、充电、微距和户外场景，不把商品改成普通白色风扇、落地风扇、无脸风扇或其他形状。";
  }
  if (context.isPillow) {
    return "套图一致性：固定同一只奶油白睡眠枕头，保留波浪高低曲线、弧形侧面、密集透气孔、圆润边角、柔软材质观感和厚度比例；整套图使用同一暖白卧室自然光和象牙白+浅木+鼠尾草绿配色。不同画面只改变床品场景、手压动作、颈部承托、孔位微距和多角度信息版，不把枕头改成普通平枕、彩色枕、记忆棉块或医疗器械。";
  }
  if (context.isLaundryDetergent) {
    return "套图一致性：固定同一瓶粉色洗衣液，保留把手、瓶盖、瓶身比例、粉色液体/瓶身质感、花朵标签、5A、洗衣液、薔薇花香、净含量等商品本体标签文字和排版；整套图使用同一干净洗衣房光线和暖白+粉色+叶绿配色。不同画面只改变污渍、倒取、泡沫、晾晒、标签微距和洗衣动线，不把商品改成其他颜色瓶、无字瓶、喷雾瓶或其他清洁产品。";
  }
  if (context.isTissue) {
    return "套图一致性：固定同一盒织梦牌抽取式面巾纸，保留白色盒身、蓝白牡丹花纹、蓝色织梦标识、盒体长方比例、顶部抽出的白色压纹纸张、包装原有中文信息和侧面结构；整套图使用同一暖白+浅木+蓝白花纹色彩系统和同一家庭自然光。不同画面只改变商品英雄图、手部抽取、餐桌/茶几随手取用、纸张压纹微距、多角度信息版和家庭收尾，不把商品改成卷纸、湿巾、无包装散纸、其他品牌或其他花纹。";
  }
  if (context.isSneaker) {
    return "套图一致性：固定同一双白色运动鞋，保留白色贝壳鞋头、白色鞋带、黑色侧边三条纹、黑金鞋舌标、金色侧边文字、绿色细节、鞋底比例和皮革/橡胶质感；整套图使用同一黑白灰+金色+少量绿色配色和干净户外自然光。不同画面只改变静物、系鞋带、上脚走路、鞋面孔位、鞋头鞋底微距和多角度分区，不把鞋改成跑鞋、拖鞋、无标白鞋、彩色鞋或其他款式。";
  }
  if (context.isPants) {
    return "套图一致性：固定同一款裤装，先以当前商品图识别并保留真实裤型、颜色、腰头、抽绳、裤腿宽度、裤脚、面料纹理、褶皱、走线、口袋/配件如有和两色/多色如参考图可见；整套图使用同一暖白衣橱+浅木+商品真实色彩系统和同一名成年模特。不同画面只改变完整裤型、走动坐下、居家/通勤场景、腰头面料微距、多角度信息版和搭配收尾，不把裤子改成裙子、内衣、床品、运动鞋、机器设备或其他颜色款式。";
  }
  if (context.isApparel) {
    return "套图一致性：固定同一款服装，先以当前商品图识别并保留真实款式、颜色、版型、领口/袖口/腰头/下摆、图案、吊牌文字、面料纹理、走线和配件如有；整套图使用同一暖白衣橱+浅木+商品真实色彩系统和同一名成年模特。不同画面只改变实穿/平铺/衣架、搭配场景、面料微距、多角度信息版和收尾构图，不把商品改成其他服装款式或颜色。";
  }
  if (context.isMagneticLifter) {
    return "套图一致性：固定同一款黄色永磁起重机/磁力吊，保留黄色矩形机身、银色 U 型吊环、长操作手柄、圆柱侧轴、黑色顶盖螺丝、机身铭牌/参数标签、警示图标、底部磁吸接触面和工业金属材质；整套图使用同一黑灰钢材+安全黄+少量安全红配色和专业工业光线。不同画面只改变棚拍英雄图、钢板吊装、户外工地、结构微距、参数展示和无需用电场景，不把商品改成电动葫芦、普通吊钩、叉车、吊车整机或其他颜色设备。";
  }
  const targetAudience = usefulTargetAudience(task);
  if (targetAudience) {
    return `套图一致性：围绕“${targetAudience}”设定同一人物/同一生活空间/同一光线系统；不同画面只改变动作和取景，不改变人物身份、产品外观和全案色彩。`;
  }
  return "套图一致性：不同画面只改变任务、角度和取景，不改变产品外观、色彩系统、光线质感和品牌排版气质。";
}

function normalizeChildModelAudience(targetAudience: string): string {
  const ageMatch = targetAudience.match(/(\d+\s*[-~—至到]\s*\d+\s*岁)/);
  if (ageMatch) return ageMatch[1].replace(/\s+/g, "");
  if (/宝宝|幼儿/.test(targetAudience)) return "幼儿";
  if (/儿童|孩子|小孩|童/.test(targetAudience)) return "";
  return "";
}

function buildProductLock(task: ProductTask, points: string[], context: ProductContext): string {
  const categoryGuard = context.isStudentBackpack
    ? "学生背包类目只允许表现当前参考图里的同一只背包，不得套用历史样例的颜色、图案、挂件/配件或其他书包外观。"
    : context.isAiRobot
      ? "AI机器人类目只允许表现当前参考图里的同一台黄色黑银机器人。可以重绘可动手臂、腿部姿势和LED表情来证明互动卖点，但必须保留圆润比例、黄色机身、黑色关节、银色耳机装饰、银色面框和蓝色LED表情屏；不得把机器人替换成其他款式或让13张图使用同一正面站姿。"
    : context.isChildProduct && context.isCup
      ? "杯壶类目只允许表现当前参考图里的同一只杯子/水壶，杯盖打开、饮水、手持等动作必须符合当前产品结构。"
    : context.isCuttingBoard
      ? "菜板类目只允许表现当前参考图里的同一块菜板，冲洗、切配、收纳场景必须符合真实厨房动线。"
    : context.isMagneticLifter
      ? "工业起重类目只允许表现当前参考图里的同一台设备；机身铭牌、参数标签和警示图标属于商品本体文字，必须按当前图片原样保留。不得把机身小铭牌里的 PML/1000KGF 等原有小字放大成醒目营销规格，营销规格只允许使用需求文档或参考图中明确可见的规格，不得新增吨位、认证或绝对安全承诺。"
    : context.isLaundryDetergent
      ? "洗护类目只允许表现当前参考图里的同一瓶/同一包装，标签文字、瓶型和瓶身颜色以当前图片为准。"
    : context.isIntimateApparel
      ? "内衣类目只允许表现当前参考图里的同一件商品，平铺、衣架、衣橱和模特展示必须符合真实穿搭/收纳逻辑。"
    : context.isPants
      ? "裤装类目只允许表现当前参考图里的同一条/同一组裤子，裤型、颜色、腰头抽绳、裤腿宽度、裤脚、面料纹理和两色/多色如有必须以当前图片为准；不得套用历史产品备注、历史衣服款式或其他品类外观。"
    : context.isApparel
      ? "服装类目只允许表现当前参考图里的同一件/同一组服装，款式、颜色、版型、面料、图案、吊牌文字和配件必须以当前图片为准；不得套用历史产品备注或其他品类外观。"
    : "";
  const detailLock = [
    "严格保持当前本地商品图中的真实商品外观：颜色、比例、结构、轮廓、开口/盖子/肩带/瓶盖/配件等可见部件，图案、Logo、标签、包装文字、商品本体文字、材质质感、边缘厚度和关键细节都必须按当前图片保留。",
    "不得根据产品名称、类目经验、历史范本或外部参考案例自行换色、换图案、换包装、换配件、换型号、换商品表面文字，也不得把当前商品改成同类里的另一款。",
    categoryGuard
  ].filter(Boolean).join("");
  const sanitizedNote = sanitizePromptNote(task.notes);
  const noteLock = isPlaceholderCopy(task.notes) || noteConflictsWithProduct(task.notes, context) || !sanitizedNote
    ? ""
    : `；用户特殊要求已转译为画面动作，不作为可见文案：${sanitizedNote}`;
  return `商品锁定：${task.productName}。${detailLock}；商品永远是第一视觉主体，不能被人物、文字或道具压住。产品本体文字锁定：本地商品图中商品表面的品牌字样、型号、标签、包装文字、瓶身/杯身/鞋身/吊牌文字、图案和标识都属于商品外观，必须保留位置、大小、颜色和排版；这些不属于新增营销文案，不能抹掉、改写、翻译、替换或虚构。外部参考案例中的文字、商标和文案不得复制到商品上。核心利益点：${points.slice(0, 5).join("；")}${noteLock}。`;
}

function sanitizePromptNote(notes: string): string {
  const clean = notes.trim();
  if (!clean) return "";
  const replacements: Array<[RegExp, string]> = [
    [/使用纸巾的场景/g, "通过抽取、擦拭、家庭随手取用等真实动作证明纸巾卖点"],
    [/纸巾.*场景/g, "通过抽取、擦拭、家庭随手取用等真实动作证明纸巾卖点"],
    [/卧室睡眠场景|室内睡觉场景|睡眠场景/g, "通过睡前放松、躺下承托和床品空间证明卖点"],
    [/户外运动场景|户外场景/g, "通过随身携带、手持使用和真实动作证明卖点"],
    [/洗衣场景/g, "通过倒取、清洁和衣物整理动作证明卖点"],
    [/衣橱场景/g, "通过衣橱搭配、拿取和收纳动作证明卖点"],
    [/厨房场景/g, "通过厨房切配、擦拭、冲洗或收纳动作证明卖点"],
    [/浴室场景/g, "通过洗护收纳、湿区拿取和真实动作证明卖点"],
    [/办公场景/g, "通过桌面使用、收纳和日常拿取动作证明卖点"],
    [/使用场景/g, "真实使用动作"],
    [/场景/g, "生活空间"]
  ];
  return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), clean);
}

function noteConflictsWithProduct(notes: string, context: ProductContext): boolean {
  if (!notes.trim()) return false;
  if (context.isCup && /(鞋型|鞋床|拖鞋|家居鞋|双脚|穿着|鞋口)/.test(notes)) return true;
  if (context.isFootwear && /(杯盖|杯口|杯身|水杯|保温杯|温显)/.test(notes)) return true;
  if (context.isIntimateApparel && /(鞋型|鞋床|拖鞋|家居鞋|双脚|鞋口|儿童|孩子|胡萝卜|黄色)/.test(notes)) return true;
  if (context.isKitchenTextile && /(鞋型|鞋床|拖鞋|家居鞋|双脚|鞋口|儿童|孩子|胡萝卜|胸罩|文胸|内衣|罩杯|肩带)/.test(notes)) return true;
  if (context.isSkincare && /(鞋型|鞋床|拖鞋|家居鞋|厨房毛巾|擦台|胸罩|文胸|内衣|罩杯|儿童|孩子|胡萝卜)/.test(notes)) return true;
  if (context.isPillow && /(鞋型|鞋床|拖鞋|家居鞋|水杯|杯盖|洗衣液|瓶身|胸罩|文胸|内衣|风扇)/.test(notes)) return true;
  if (context.isLaundryDetergent && /(鞋型|鞋床|拖鞋|家居鞋|枕头|睡眠枕|水杯|杯盖|胸罩|文胸|内衣|风扇)/.test(notes)) return true;
  if (context.isSneaker && /(杯盖|杯口|杯身|水杯|保温杯|枕头|睡眠枕|洗衣液|瓶身|胸罩|文胸|内衣|儿童|孩子|胡萝卜)/.test(notes)) return true;
  if (context.isStudentBackpack && /(杯盖|杯口|杯身|保温杯|拖鞋|鞋型|枕头|睡眠枕|洗衣液|胸罩|文胸|内衣|菜板|砧板|起重机|磁力吊)/.test(notes)) return true;
  if ((context.isPants || context.isApparel) && /(机身|提手|出风口|出风|网罩|底座|扇罩|扇叶|杯盖|杯口|杯身|水杯|保温杯|鞋型|鞋床|拖鞋|家居鞋|枕头|睡眠枕|洗衣液|瓶身|胸罩|文胸|内衣|罩杯|尿布|尿不湿|纸尿裤|菜板|砧板|起重机|磁力吊|吊环|手柄|钢板)/.test(notes)) return true;
  if (/(机身|出风口|网罩|底座)/.test(notes) && !context.isPortableFan && !context.isMagneticLifter) return true;
  return false;
}

function specConflictsWithProduct(specs: string, context: ProductContext): boolean {
  if (!specs.trim()) return false;
  if (context.isCup && /(脚长|尺码|鞋码|鞋长|适合.*脚|按.*脚)/.test(specs)) return true;
  if (context.isFootwear && /(杯盖|杯口|杯身|容量|毫升|ml|mL|L|PPSU|吸管)/.test(specs)) return true;
  if (context.isApparel && /(杯盖|杯口|杯身|容量|毫升|PPSU|吸管|起重|钢板|尿布|纸尿裤)/.test(specs)) return true;
  if (context.isBabyCare && /(脚长|鞋码|鞋长|杯盖|吸管|起重|钢板|胸罩|罩杯)/.test(specs)) return true;
  return false;
}

function buildStudentBackpackMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const copySets = buildStudentBackpackCopyPlan(task, points).main;
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "货架 3 秒内看清这是学生双肩背包，商品足够大，当前图真实外观、前袋/侧袋/肩带和配件如有形成第一记忆点，提高点击率。",
        sceneDirection: "严格使用本地商品图中的同一款学生双肩背包，大号正面或 3/4 角度展示；当前商品图里的包身颜色、图案、前袋、手提带、侧袋、肩带、拉链和挂件/配件如有必须清楚；产品占画面约78%-86%。背景可用浅木课桌或清爽校园光影，但学生和道具不能抢主体。",
        composition: "商品居中略偏下形成第一视觉主体，左上或上方保留标题区；用少量无品牌课本/作业本暗示上学，但不要堆满书本、价格贴或开学促销元素。",
        typography: "主标题最大，轻便肩负第二层，颜值卖点第三层；文字区不超过画面30%，不得遮挡当前图里的图案、前袋、配件和肩带。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "轻便肩负",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "肩负卖点证明图",
        conversionGoal: "把“轻便肩负”变成真实背负证据，让家长理解孩子每天上学背着更轻松。",
        sceneDirection: "同一名 8-13 岁学生在明亮校园步道或上学前玄关背着同一款书包，镜头从侧后方或 3/4 背面拍摄，当前图同款肩带贴合肩背并自然受力，书包完整清楚；可以露自然侧脸，但书包是主体。不写护脊、减负科技、承重测试或健康功效。",
        composition: "学生半身/背影与书包形成真实比例，书包位于视觉中心；可用一处无文字局部放大圈展示肩带结构，避免同第1屏静物角度重复。",
        typography: "标题靠近肩带受力证据，副文案短而准；图形承托用细线和浅蓝/薄荷小块，不做促销标签。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "上学收纳",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "上学收纳场景图",
        conversionGoal: "用课本、水杯和上学场景证明分区收纳与日常携带，降低家长对东西装不清的顾虑。",
        sceneDirection: "同一款书包放在浅木课桌、教室座椅或上学前玄关旁，拉链打开一部分，露出无品牌课本/作业本；侧袋可放一只无品牌水杯，前袋与配件如有清楚。画面只表达分区收纳关系，不写容量升数或防盗功能。",
        composition: "书包占主体，课本水杯作为辅助证据；镜头略俯拍或侧前方，和第1屏大正面英雄图、第2屏背负图明显不同。",
        typography: "标题在自然留白区，第三句可做小胶囊；文案必须和收纳画面对应，不能变成空泛校园氛围。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "细节特写",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节信任图",
        conversionGoal: "解决用户看不清图案结构、前袋、侧袋、配件和肩带细节的不确定。",
        sceneDirection: "一主两辅局部特写：主画面近景展示当前商品图真实可见的前袋、图案/色块/装饰和拉链走线；辅画面展示同款肩带、侧袋、织物纹理和挂件/配件如有。所有细节必须来自同一款书包，不改变图案和颜色。",
        composition: "主细节占画面约65%-75%，辅细节用浅色分区或局部放大圈；背景浅景深但能看到完整书包轮廓，文字避开关键图案。",
        typography: "细节型画册排版，标题小而精，局部放大圈和细线只做图形，不新增标签文字。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "颜值收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用高颜值上学搭配完成主图闭环，让家长和孩子都能感到日常好背也好看。",
        sceneDirection: "同一名学生把同一款书包放在校园长椅、教室椅背或浅木课桌旁，也可以自然背在肩上走过校门；当前图真实包身图案、前袋、配件如有和肩带清楚，构图比第2屏更轻松更留白。",
        composition: "书包在前景或学生背部成为第一主体，背景有干净校园空间和自然光；不要新增其他书包、品牌校徽或开学促销装饰。",
        typography: "标题两行以内，副文案和第三句组成同一文本组；可用短横线、校园浅蓝色块和无文字图形增强设计感。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildPantsMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const copySets = buildPantsCopyPlan(task, points).main;
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "货架 3 秒内看清这是裤装，完整裤型足够大，宽松版型和面料质感成为第一购买理由，提高点击率。",
        sceneDirection: "严格使用本地商品图中的同一款裤子，大号完整展示真实裤型、颜色、腰头、抽绳、裤腿宽度、裤脚和面料纹理；优先采用成年模特全身实穿、衣架垂挂或平铺棚拍，按当前商品图最适合的展示方式选择。产品占画面约78%-86%；若当前参考图有两色/多色，可一主一辅并列展示，但不得新增不存在颜色。",
        composition: "裤子是第一视觉主体，画面左上或上方留标题区；可用无品牌上衣/鞋包少量辅助穿搭，但不能抢走裤型完整轮廓。",
        typography: "主标题最大，版型卖点第二层，面料卖点第三层；文字区不超过画面30%，不得遮挡腰头抽绳、裤腿轮廓和裤脚。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "宽松版型",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "版型卖点证明图",
        conversionGoal: "用走动、坐下或侧身姿态证明宽松版型不拘束，降低用户怕勒腿、怕显臃肿的顾虑。",
        sceneDirection: "同一名成年模特穿同一款裤子自然走动、坐下或侧身站立，腰头抽绳、裤腿垂顺线条和裤脚比例清楚；画面用身体动作证明宽松自在，不做夸张弹力拉扯，不写塑形科技。",
        composition: "下半身和裤装占视觉中心，可用一处无文字局部放大圈展示腰头松紧或裤腿垂感；背景与第1屏不同。",
        typography: "标题靠近版型证据，副文案短而准；图形用细线、短横和低饱和色块，不做促销标签。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "日常场景",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "居家通勤场景图",
        conversionGoal: "让用户看到这条裤子在家、出门、通勤都能自然搭配，建立日常购买理由。",
        sceneDirection: "同一名成年模特穿同一款裤子，搭配无品牌基础上衣和干净鞋包，出现在暖白衣橱、客厅、咖啡店门口或通勤街区；裤子完整清楚，裤腿线条和颜色是视觉重点。",
        composition: "模特与裤装形成真实穿搭比例，裤子位于画面中心或前景；背景生活化但干净，不出现真实品牌招牌。",
        typography: "标题在墙面、衣橱或浅色留白处，主副标题形成一个信息组；不要把文案压在裤腿纹理和模特脸上。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "细节特写",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节信任图",
        conversionGoal: "解决用户看不清腰头抽绳、面料纹理、裤脚走线和整体质感的不确定。",
        sceneDirection: "一主两辅局部特写：主画面展示同一款裤子的腰头抽绳和面料纹理，辅画面展示裤脚走线、裤腿垂感或口袋/边缘细节如当前商品图可见；所有细节来自同一款裤子。",
        composition: "主细节占画面约65%-75%，辅细节用浅色分区或局部放大圈；背景保留一处完整裤型轮廓，文字避开抽绳和纹理关键区域。",
        typography: "细节型画册排版，标题小而精，局部放大圈和细线只做图形，不新增标签文字。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "搭配收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用当前参考图配色和衣橱搭配完成主图闭环，让用户知道这条裤子日常好搭、出门省心。",
        sceneDirection: "同一款裤子与无品牌上衣、鞋包或衣架在暖白衣橱/玄关形成稳定搭配画面；如果当前商品图有两色/多色，按真实颜色展示对比，不新增颜色。整体比第1屏更留白、更像穿搭画册收尾。",
        composition: "裤子在前景或模特下半身成为第一主体，背景有干净衣橱和自然光；不要新增其他裤款、价格牌或促销装饰。",
        typography: "标题两行以内，副文案和第三句组成同一文本组；可用短横线、低饱和金色细线和无文字图形增强设计感。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildChildFootwearMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const primaryPoint = points[0] || "宽口好穿";
  const secondaryPoint = points[1] || "居家走动更轻松";
  const productName = productDisplayName(task, "精选商品");
  const copySets = [
    [productName, primaryPoint, "孩子在家轻松穿"],
    [primaryPoint, "一脚套入", "日常换穿更省心"],
    ["居家走动", "自然又轻松", task.category || "儿童家居鞋"],
    ["细节清晰", "靠近看也有质感", "宽口好穿"],
    ["放在顺手处", "出门不慌张", specs[0] || "请按实际脚长选择合适尺码"]
  ];
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "3秒看清商品外观、颜色、品类和第一卖点，先提高货架点击率。",
        sceneDirection: "大号清晰展示同一双黄色儿童家居拖鞋，双拖鞋完整露出，鞋口、鞋床纹理、外侧卡通图案必须清楚；产品占画面约78%-85%。同一名约5岁儿童只允许作为小比例背景或角落辅助，不能抢商品，也可以不出现人物。",
        composition: "产品置于画面中心或中下方形成第一视觉主体，标题区在左上天然留白；背景是浅木玄关/奶油白空间但要极简，不能让人物、家具或道具比产品更醒目。",
        typography: "主标题最大但不压商品，卖点短句次级，第三行小字；移动端一眼读完，标题区不超过画面28%。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "核心卖点",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "核心卖点证明图",
        conversionGoal: "用真实动作证明宽口好穿，降低家长对穿脱麻烦的顾虑。",
        sceneDirection: "固定同一名约5岁儿童，穿同一套浅蓝色居家服，把脚自然滑入拖鞋，另一只脚已穿好；鞋口、脚背和鞋床关系真实，卡通图案可见。",
        composition: "主画面为穿入动作，可加入一个精致圆形局部放大展示宽口，不做复杂参数图。",
        typography: "卖点标题强对比，辅助文案放在标题下方；小圆形放大区旁边只用短标注。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "使用场景",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "居家场景种草图",
        conversionGoal: "让家长代入孩子在家真实穿着，建立场景需求。",
        sceneDirection: "固定同一名约5岁儿童，穿同一套浅蓝色居家服，双脚正在穿着同一双黄色拖鞋，在同一玄关或卧室活动区自然走动、拿书或玩耍；拖鞋必须在脚上且完整清楚，步态真实，不能只把拖鞋放在前景摆拍。",
        composition: "人物与穿着中的拖鞋形成生活画面，商品必须在脚部视觉中心；可以有少量前景空间，但不要用一双巨大摆拍拖鞋替代真实穿着证明。",
        typography: "标题在左上或左侧留白区，少字大标题，副文案压低存在感。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "细节特写",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节卖点图",
        conversionGoal: "解决买家看不清图案、鞋口和细节质感的不确定。",
        sceneDirection: "商品近景，突出卡通图案、宽口结构、鞋床纹理；另一只鞋做背景层次，保持真实比例。",
        composition: "产品占画面70%左右，浅景深但关键细节清晰；文字避开图案和鞋口。",
        typography: "成熟品牌画册式排版，留白充足，标题精致清楚，细节标注只用极简线条或小ICON。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "日常收纳",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: `用收纳和${secondaryPoint}完成临门一脚，让家长知道怎么选。`,
        sceneDirection: "同一玄关矮柜、脚垫或浅木收纳区旁；固定同一名约5岁儿童穿浅蓝色居家服，双脚必须穿着或正在穿入同一双黄色拖鞋，旁边可有收纳区但不能出现白鞋、运动鞋或其他鞋款。",
        composition: "黄色拖鞋在脚上或手边前景清晰，右侧或上方留文字区；画面传达顺手、好找、出门不慌张。",
        typography: "主标题两行以内，尺码建议用小胶囊/细线信息条呈现，移动端清晰可读。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildChildTemperatureCupMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const productName = productDisplayName(task, "精选商品");
  const primaryPoint = points[0] || "温度显示更直观";
  const secondaryPoint = points[1] || "上学日常带着走";
  const tertiaryPoint = points[2] || "课桌书包都适合";
  const specHint = firstUsefulSpec(specs, "按孩子日常饮水需求选择");
  const copySets = [
    [productName, primaryPoint, "儿童日常饮水杯"],
    [primaryPoint, "喝前看一眼水温", "家长更省心"],
    ["上学日常", "带着走", tertiaryPoint],
    ["屏幕清楚", "杯身细节清晰", "孩子自己也好识别"],
    ["选择更简单", specHint, "日常饮水更方便"]
  ];
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "货架 3 秒内看清这是儿童温显水杯/保温杯，商品足够大，第一卖点明确，提高点击率。",
        sceneDirection: "严格使用本地商品图中的同一只水杯，大号正面或 3/4 角度展示，杯盖/温显区域、杯身图案、颜色和比例清楚；产品占画面约78%-86%。可有书桌或浅木背景，但不能让儿童、书包或道具抢主体。",
        composition: "商品居中略偏下，顶部或左侧留出标题区；背景干净明亮，最多用一两个学习道具暗示儿童日常，不堆叠多件商品。",
        typography: "主标题最大，核心卖点第二层，品类说明第三层；中文排版精致，文字区不超过画面30%，不得遮挡杯盖、屏幕和杯身图案。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "温显功能",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "核心功能证明图",
        conversionGoal: "把“温度显示”从文字卖点变成可见证据，解决家长对水温不直观的顾虑。",
        sceneDirection: "杯盖/温显屏幕近景为主，另一只完整水杯或杯身做背景层次；画面可以出现儿童手指轻触或靠近屏幕的动作，但手部和人物不能遮挡商品。温度数字可抽象成清晰发光屏幕质感，不写虚构具体温度。",
        composition: "一主近景加一个小比例完整杯，使用精致局部放大框或细线标注，避免复杂科技 UI 和廉价发光特效。",
        typography: "大标题强调功能，副文案解释使用动作；标注短而准，像高端小家电详情页。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "上学场景",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "目标人群场景图",
        conversionGoal: "让家长代入孩子上学、书桌、书包携带的真实使用场景，建立购买理由。",
        sceneDirection: "同一只水杯放在 10-15 岁学生的明亮书桌或无品牌书包旁，儿童可以露出自然侧脸/正脸但不抢主体；水杯必须完整清楚，杯身图案和温显区域可见。",
        composition: "水杯在前景或视觉中心，人物和书包只做场景证据；画面有学习区真实细节，但保持干净。",
        typography: "标题在自然留白区，三行以内；不要做促销贴纸，不要写学习成绩、健康功效等无依据内容。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "细节特写",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节信任图",
        conversionGoal: "解决用户看不清屏幕、杯盖、杯身图案和产品质感的不确定。",
        sceneDirection: "超近景展示杯盖/温显屏幕、杯身图案、杯口或杯身质感，另一角度水杯作为背景层次；严格保持本地商品图外观，不虚构材质和认证。",
        composition: "主细节占画面约65%-75%，背景用同色系浅景深；可用三处极简细线标注，但文字不能压住屏幕或图案。",
        typography: "成熟品牌画册式排版，留白充足，标题精致清楚，细节标注使用小字号和细线。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "决策收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用规格/选择建议和日常饮水场景完成购买决策，避免空泛品牌收尾。",
        sceneDirection: "同一只水杯放在书桌和书包之间，形成“家里准备、上学带走”的收尾画面；商品完整清楚，背景温暖干净。",
        composition: "水杯居中或右下，左侧/上方做选择建议信息区；整体稳定，有系列结束感。",
        typography: "主标题两行以内，规格建议用细线信息条呈现；文字精致清晰，不要出现价格、销量、认证或促销语。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildChildCupMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const copySets = buildChildCupCopyPlan(task, points).main;
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "货架 3 秒内看清这是儿童保温杯，商品足够大，可爱外观和儿童喝水场景明确，提高点击率。",
        sceneDirection: "严格使用本地商品图中的同一只儿童保温杯，大号正面或 3/4 角度展示；黄色杯盖、蓝色双把手、米色杯身、杯身卡通图案、JUMP 与 THERMOS 商品本体文字必须清楚；产品占画面约78%-86%。可有浅木书桌或早餐餐桌背景，但儿童、书包和道具不能抢主体。",
        composition: "商品居中略偏下形成第一视觉主体，左上或上方留标题区；背景干净明亮，只用少量书本、餐盘或无品牌书包暗示儿童日常，不堆叠多个杯子。",
        typography: "主标题最大，核心卖点第二层，品类说明第三层；文字区不超过画面30%，不得遮挡杯盖、双把手、卡通图案和杯身原有文字。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "耐热饮用",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "耐热卖点证明图",
        conversionGoal: "把“耐高温/耐热”从短卖点变成可见饮用场景，降低家长对热水温水使用的顾虑。",
        sceneDirection: "杯盖、杯口和打开动作近景为主，成人手部正在打开杯盖、倒入温水或轻扶杯口；同一只完整儿童保温杯小比例做背景层次，黄盖、蓝把手、米色杯身和杯身文字仍可识别。可有很轻微温水蒸汽生活感，但不写具体温度、不写保温时长、不做危险沸水画面。",
        composition: "一主杯口近景加一辅完整杯，使用局部放大圈或细线指向杯盖杯口；画面高级干净，不做实验室检测海报。",
        typography: "卖点标题靠近杯口动作，副文案贴近主标题；标注短而准，像成熟母婴/儿童水杯详情图。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "家庭上学",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "目标人群场景图",
        conversionGoal: "让妈妈代入孩子家里喝水、上学带杯的真实使用场景，建立日常购买理由。",
        sceneDirection: "同一名 8-10 岁短黑发男孩在明亮早餐餐桌、书桌或无品牌书包旁自然拿起同一只儿童保温杯；如果表现喝水，黄色杯盖必须翻开，杯口/吸饮口必须露出，孩子嘴巴只能靠近打开的杯口，不能对着关闭的杯盖喝水。可以露出自然正脸或侧脸，但商品必须在前景或视觉中心完整清楚，杯身图案和原有文字不能被手遮挡。",
        composition: "杯子占视觉中心，儿童和书包只做场景证据；镜头从桌面侧前方或略俯拍，和第1屏纯商品英雄角度明显不同。",
        typography: "标题在自然留白区，三行以内；文案表达家里上学都适合，不写成绩、健康功效或夸大安全承诺。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "杯盖把手",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节信任图",
        conversionGoal: "解决用户看不清杯盖、双把手、卡通图案和杯身文字的不确定。",
        sceneDirection: "超近景展示黄色杯盖、蓝色双把手、杯口边缘、米色杯身卡通图案、JUMP 与 THERMOS 商品本体文字；另一角度完整水杯作为背景层次。严格保持商品文字清楚，不得抹掉或改写。",
        composition: "主细节占画面约65%-75%，可用两处局部放大圈和无文字细线，背景浅景深但完整杯轮廓可见；文字避开杯身文字和卡通图案。",
        typography: "成熟品牌画册式排版，留白充足，标题精致清楚，细节标注使用小字号和细线。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "环保材质",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用环保材质放心感和孩子爱用的外观完成主图闭环，不用空泛品牌收尾。",
        sceneDirection: "同一只儿童保温杯放在干净书桌或早餐餐桌一角，儿童手部准备取杯或家长把杯子放到书包旁；商品完整清楚，黄盖、蓝把手、杯身卡通和原有文字保持一致。只表达环保材质更放心，不写材质等级、检测认证或无毒绝对化承诺。",
        composition: "杯子居中或右下，左侧/上方保留信息区；背景有书本、餐盘或无品牌书包形成日常收尾，但画面稳定不杂乱。",
        typography: "主标题两行以内，辅助句用细线信息条或小胶囊呈现，移动端清晰可读，不出现价格、销量、认证或促销语。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildAiRobotShotDirective(role: "main" | "detail", index: number, points: string[]): string {
  const select = (pattern: RegExp, fallback: string) => pickPoint(points, pattern, fallback);
  const desktopPoint = select(/潮玩|摆件|桌面|颜值|造型|外观/, "潮玩桌面摆件");
  const languagePoint = select(/多语言|方言|双语|中文|英文|英语|日语|粤语|闽南语|语言/, "多语言与方言互动");
  const storyPoint = select(/讲故事|故事|成语接龙|成语|儿歌/, "讲故事与成语接龙");
  const voicePoint = select(/趣味语音|语音|对话|问答|唤醒|多模型|模型/, "趣味语音交互");
  const learningPoint = select(/学习答疑|学习|答疑|早教|百科|课本/, "学习答疑");
  const jointPoint = select(/多关节|关节|可动|动作|姿势/, "多关节可动");
  const playPoint = select(/玩法丰富|玩法|游戏|跳舞/, "玩法丰富");
  const childPoint = select(/孩子|玩伴|陪伴|亲子/, "孩子贴心玩伴");
  const onlinePoint = select(/联网|WiFi|智能聊天|云端|网络/, "联网智能聊天");
  const batteryPoint = select(/长续航|续航|电池|电量/, "长续航");
  const screenPoint = select(/LED|表情|屏幕|科技/, "LED表情屏互动");
  const key = `${role}-${index}`;
  const map: Record<string, { point: string; scene: string; presence: string; proof: string }> = {
    "main-1": {
      point: desktopPoint,
      scene: "让书桌、展示架、台灯和书本成为桌面潮玩的大场景，机器人使用3/4角度或坐姿。",
      presence: "机器人是第一视觉主体，占画面约55%-70%。",
      proof: "用桌面尺度和陈列关系证明潮玩摆件，不用普通白底证件照。"
    },
    "main-2": {
      point: languagePoint,
      scene: "让教室黑板、中文/English/方言语言卡、对话气泡和孩子提问手部成为大视觉元素。",
      presence: "机器人缩小为正在授课的小老师，占画面约25%-40%，不是唯一主体。",
      proof: "用语言卡、黑板和对话关系具体表现多语言/方言；语言示例不代表未经确认的支持数量。"
    },
    "main-3": {
      point: storyPoint,
      scene: "让打开的绘本、成语接龙卡、阅读灯和孩子翻页动作成为大场景。",
      presence: "机器人作为讲故事伙伴出现在绘本旁，采用侧身或坐姿。",
      proof: "用绘本、卡牌和翻页互动证明故事与成语玩法，不能只放标题。"
    },
    "main-4": {
      point: jointPoint,
      scene: "使用抬手、弯腿、转身等明显不同姿势，搭配关节放大圈和动作轨迹。",
      presence: "机器人是动态主视觉，姿势变化先于背景装饰。",
      proof: "用手臂/腿部关节和LED表情的真实可见变化证明可动。"
    },
    "main-5": {
      point: batteryPoint,
      scene: "让大型电池能量图、从早到晚时间线、白天学习和夜间故事小场景成为大视觉元素。",
      presence: "不要求完整机器人出场，只保留小型机器人轮廓或LED屏插图作为识别锚点。",
      proof: "用全天陪伴时间线表达长续航，不写小时数、电池容量或百分比。"
    },
    "detail-1": {
      point: voicePoint,
      scene: "用麦克风、声波、提问卡和孩子说话的侧脸/手部构成大关系图。",
      presence: "机器人前倾倾听或抬手回应，占前景约35%-50%。",
      proof: "用倾听表情、声波和回应动作证明趣味语音交互。"
    },
    "detail-2": {
      point: onlinePoint,
      scene: "用云端节点、WiFi连接线、家庭设备和聊天关系图占据画面主区域。",
      presence: "机器人作为小型联网终端出现，不要求居中占满画面。",
      proof: "用连接关系和聊天气泡表达联网智能聊天，不虚构速度或技术参数。"
    },
    "detail-3": {
      point: learningPoint,
      scene: "用课本、问题卡、黑板和孩子提问动作占主要区域。",
      presence: "机器人指向问题或做回应姿态，保持屏幕和关节清晰。",
      proof: "用具体问题、指向动作和回应表情证明学习答疑。"
    },
    "detail-4": {
      point: childPoint,
      scene: "使用家庭客厅、亲子阅读角或床边的真实生活空间，出现孩子、绘本和家长手部。",
      presence: "机器人坐在孩子身边或朝向亲子互动，人物不得抢主体。",
      proof: "用孩子主动靠近、共同翻书或聊天动作证明贴心玩伴。"
    },
    "detail-5": {
      point: playPoint,
      scene: "用游戏板、动作轨迹、故事卡和多个不同机器人姿势组成三宫格或四宫格。",
      presence: "每格机器人姿态、LED表情、镜头距离和道具必须不同。",
      proof: "用跳舞、挥手、讲故事、思考等状态证明玩法丰富。"
    },
    "detail-6": {
      point: screenPoint,
      scene: "用蓝色LED表情屏、银色耳机装饰和黄黑圆润机身做局部特写。",
      presence: "机器人局部占主视觉，表情屏和耳机细节必须清晰。",
      proof: "用微笑、倾听、眨眼等屏幕状态建立互动生命感，不虚构内部元件。"
    },
    "detail-7": {
      point: jointPoint,
      scene: "使用正面、侧面、背面/顶部和关节局部四种视角，姿态与表情各不相同。",
      presence: "同一机器人作为多角度结构板主体，不要四格都正面站立。",
      proof: "用多角度和不同姿态证明主体一致与关节关系。"
    },
    "detail-8": {
      point: desktopPoint,
      scene: "用家庭客厅、学习桌或办公桌的生活纵深完成舒展收尾，加入桌面摆件和陪伴元素。",
      presence: "机器人采用生活化坐姿或邀请互动手势，作为右下或中下产品锚点。",
      proof: "用桌面尺度、家庭陪伴和礼物场景收束购买理由。"
    }
  };
  const selected = map[key] || map["main-1"];
  return [
    `本屏卖点驱动硬覆盖：只突出“${selected.point}”。`,
    `本屏大视觉元素：${selected.scene}`,
    `机器人出场级别：${selected.presence}`,
    `本屏可见证明：${selected.proof}`,
    "如果上方通用模板与本屏指令冲突，以本屏指令为准；禁止用机器人旁边加几行字替代卖点场景。",
    "禁止13张图重复同一正面站姿、同一LED表情、同一背景和同一左文案右产品结构。"
  ].join("\n");
}

function buildAiRobotMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const productName = productDisplayName(task, "AI机器人");
  const desktopPoint = pickPoint(points, /潮玩|摆件|桌面|颜值|造型|外观/, "潮玩桌面摆件");
  const languagePoint = pickPoint(points, /多语言|方言|双语|中文|英文|英语|日语|粤语|闽南语|语言/, "多语言与方言互动");
  const storyPoint = pickPoint(points, /讲故事|故事|成语接龙|成语|儿歌/, "讲故事与成语接龙");
  const jointPoint = pickPoint(points, /多关节|关节|可动|动作|姿势/, "多关节可动");
  const batteryPoint = pickPoint(points, /长续航|续航|电池|电量/, "长续航");
  const screenPoint = pickPoint(points, /LED|表情|屏幕|科技/, "LED表情屏互动");
  const copySets = [
    [productName, desktopPoint, "萌趣桌面AI玩伴"],
    [languagePoint, "中文、English与方言语言卡", "机器人作为课堂小老师"],
    [storyPoint, "绘本、成语卡和亲子阅读", "故事互动不只靠文字"],
    [jointPoint, "抬手、弯腿、转身都不同", screenPoint],
    [batteryPoint, "电池能量图与全天时间线", "不编造具体续航数字"]
  ];
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "AI机器人产品英雄首图",
        conversionGoal: "3秒看清这是黄色黑银撞色的豆包AI机器人，并立刻感知萌趣、科技和儿童陪伴属性。",
        sceneDirection: "严格以参考图中的同款黄色机器人为主体：黄色圆润机身、黑银撞色、银色耳机装饰、深蓝LED表情屏和两只蓝色发光眼必须保留。不要沿用原图正面呆站，改成轻微3/4角度站姿，右手友好挥手，左手自然张开，LED屏是微笑表情。背景为明亮儿童书桌或干净科技玩具棚拍环境，主体占画面70%-82%。",
        composition: "机器人为第一视觉主体，头部和LED表情屏清楚，四肢完整；背景只用低饱和学习桌、积木、书本或柔和光带辅助，不出现竞品Logo。标题区放在上方或左侧留白，避免遮挡表情屏和关节。",
        typography: "现代黑体，主标题最大，卖点短句次级，信息不超过三层；版式活泼但不使用卡通花字。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "AI对话卖点",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "AI对话功能证明图",
        conversionGoal: `围绕“${languagePoint}”做可视化证明，让语言课堂和对话关系成为大视觉元素，而不是静态摆拍。`,
        sceneDirection: "同款机器人放在儿童学习桌上，身体微微前倾，头部朝向正在提问的孩子，右手抬起像在回应问题，LED表情屏改成倾听状态：两颗蓝色眼睛或圆点带轻微呼吸光。画面可以出现儿童侧脸或手部、英语课本、单词卡、铅笔和温馨室内书桌；单词卡只允许出现简单清楚的 A B C / apple 等学习道具字样，不作为营销文案。可加入克制的语音波纹、问答气泡形状，但不要写随机英文或真实竞品Logo；不要把豆包/DeepSeek画成商标，只表达多模型AI能力。",
        composition: "机器人位于视觉中心或前景，孩子、英语课本和文具只做学习陪伴证据；可用一处细线连接到LED屏，强调语音互动。整张图必须和第1张英雄棚拍明显不同，是儿童学英语的真实场景。",
        typography: "标题突出“多模型AI对话”，副标题解释聊天、讲故事、学习陪伴；排版避开机器人头部。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "亲子学习",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "亲子学习陪伴图",
        conversionGoal: "用真实儿童书桌互动场景证明它是学习助手和低压力陪伴，而不是普通玩具静物。",
        sceneDirection: "同款机器人以坐姿或半蹲姿态站在书桌边，身体侧向孩子和家长方向，一只手指向打开的绘本或故事书，另一只手自然支撑；LED表情屏变成好奇/提示表情。画面可出现儿童正侧脸、家长手部翻书、绘本、故事卡和暖色台灯，但不出现危险动作，不让人物遮挡机器人主体。",
        composition: "机器人、孩子和书本形成三角构图，镜头略低或平视，突出机器人正在参与亲子故事/问答互动；背景换成温暖家庭学习角，与第1、2张明显不同。",
        typography: "左上或右上留白放短标题，副标题更小，整体像淘宝天猫儿童智能硬件主图。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "关节与表情细节",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "可动关节与LED表情细节图",
        conversionGoal: "用动作差异和细节特写解决用户对互动感、把玩性和科技感的疑问。",
        sceneDirection: "用同款机器人做一主两辅构图：主机器人双臂上举或一手比OK姿势，腿部略分开形成活泼站姿；辅图/局部放大展示手臂关节、腿部关节、银色耳机装饰和蓝色LED表情屏。LED表情改成眨眼或开心表情。必须保持黄黑银配色和圆润比例，不要变成陌生机器人。",
        composition: "主体占画面60%左右，右侧或下方两个局部放大圈，细线连接到关节和表情屏；背景为浅色科技展台，不使用复杂参数表。",
        typography: "标题强调“可动关节”，小字强调表情互动；细节标注简洁，禁止堆砌规格和虚构认证。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "礼物桌搭",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "把儿童陪伴、桌面摆件和送礼理由收束到一张有记忆点的决策图。",
        sceneDirection: "同款机器人换成桌面摆件/礼物氛围：坐在或站在简洁书桌一角，旁边有无品牌礼盒、台灯、绘本或家庭客厅软装；姿势与前面不同，一只手向外伸出像邀请互动，LED表情屏为温柔微笑。画面不要只复制原图正面站姿。",
        composition: "机器人置于中下或右下，背景有生活纵深和柔和光，左上保留文案区；整体干净高级，有结束感。",
        typography: "短标题两行以内，副文案更小；不写价格、销量、限时、夸张促销。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: `${composeScreenPrompt(visualSystem, screen)}\n${buildAiRobotShotDirective("main", spec.index, points)}`
  }));
}

function buildAiRobotDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const productName = productDisplayName(task, "AI机器人");
  const shared = [
    visualSystemToPrompt(visualSystem),
    "AI机器人专属硬规则：13张图里机器人不能都是同一张参考图的正面站姿。每屏必须是独立场景和独立卖点，必须换姿势、换LED表情、换镜头距离、换道具或换使用空间；严格保留黄黑银圆润机器人外观。语言、联网、续航等抽象卖点允许场景、关系图或信息图成为大视觉元素，机器人是识别锚点但不必每屏占中心。",
    "场景变化池：语言课堂、亲子故事阅读、语音问答互动、联网关系图、长续航电池时间线、关节把玩近景、家庭客厅陪伴、桌面潮玩摆件、礼物开箱、正侧背多角度结构说明。画面可以出现儿童、家长手部、课本、中文/English/方言语言卡、绘本、成语卡、铅笔、台灯、礼盒和云端节点，但所有辅助元素必须服务本屏卖点。",
    "姿态变化池：挥手、前倾倾听、坐在书桌旁、指向绘本、指向英语单词卡、双臂上举、侧身3/4站姿、桌面摆件坐姿、被双手捧起、邀请互动手势、四宫格多姿态。LED表情池：微笑、眨眼、倾听圆点、好奇眼神、故事模式柔光。"
  ].join("\n");
  const languagePoint = pickPoint(points, /多语言|方言|中文|英文|英语|日语|粤语|闽南语|语言/, "多语言与方言互动");
  const voicePoint = pickPoint(points, /趣味语音|语音|对话|问答|唤醒|多模型|模型/, "趣味语音交互");
  const storyPoint = pickPoint(points, /讲故事|故事|成语接龙|成语|儿歌/, "讲故事与成语接龙");
  const learningPoint = pickPoint(points, /学习答疑|学习|答疑|早教|百科|课本/, "学习答疑");
  const jointPoint = pickPoint(points, /多关节|关节|可动|动作|姿势/, "多关节可动");
  const playPoint = pickPoint(points, /玩法丰富|玩法|游戏|跳舞/, "玩法丰富");
  const childPoint = pickPoint(points, /孩子|玩伴|陪伴|亲子/, "孩子贴心玩伴");
  const onlinePoint = pickPoint(points, /联网|WiFi|智能聊天|云端|网络/, "联网智能聊天");
  const screenPoint = pickPoint(points, /LED|表情|屏幕|科技/, "LED表情屏互动");
  const copySets = [
    [voicePoint, "麦克风、声波和回应表情", productName],
    [onlinePoint, "云端节点与聊天关系图", "机器人作为连接终端"],
    [learningPoint, "课本、问题卡和提问动作", "学习答疑更具体"],
    [childPoint, "亲子阅读和家庭陪伴", "孩子愿意主动交流"],
    [playPoint, "游戏板、动作轨迹和多种姿态", "玩法变化看得见"],
    [screenPoint, "蓝色LED表情与银色耳机细节", "互动更有生命感"],
    [jointPoint, "正侧背与关节局部多角度", "同一主体不同形态"],
    [storyPoint, languagePoint, "把故事和语言陪伴带进日常"]
  ];
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string; roleLabel: string }> = [
    {
      role: "detail",
      index: 1,
      title: "语音互动",
      aspectRatio: "9:16",
      copy: copySets[0],
      roleLabel: "详情页首屏",
      taskPrompt: "表现趣味语音交互：以麦克风、声波、提问卡和孩子说话的侧脸或手部作为大关系元素；同款机器人前倾倾听或抬手回应，LED屏显示倾听/回应状态。机器人清晰可辨但不只是站在文字旁边，不出现随机英文或虚构语音参数。"
    },
    {
      role: "detail",
      index: 2,
      title: "联网聊天",
      aspectRatio: "9:16",
      copy: copySets[1],
      roleLabel: "详情页用户顾虑",
      taskPrompt: "表现联网智能聊天：让云端节点、WiFi连接线、家庭设备和聊天关系图成为画面主视觉；机器人作为清晰可辨的小型联网终端出现在关系图中，不要求居中占满画面。不虚构速度、协议、设备数量或技术参数。"
    },
    {
      role: "detail",
      index: 3,
      title: "学习答疑",
      aspectRatio: "9:16",
      copy: copySets[2],
      roleLabel: "详情页功能证明",
      taskPrompt: "表现学习答疑：课本、问题卡、黑板和孩子提问动作占主要区域；同款机器人指向问题卡或做回应姿态，屏幕显示思考/回答状态。问题内容使用简洁无品牌学习道具，不虚构考试成绩或教育效果。"
    },
    {
      role: "detail",
      index: 4,
      title: "亲子陪伴",
      aspectRatio: "9:16",
      copy: copySets[3],
      roleLabel: "详情页学习陪伴",
      taskPrompt: "表现孩子贴心玩伴：使用家庭客厅、亲子阅读角或床边的真实生活空间，出现孩子、绘本和家长手部；同款机器人坐在孩子身边或朝向亲子互动，LED表情温和，人物只提供互动和尺度证据，不遮挡机器人。"
    },
    {
      role: "detail",
      index: 5,
      title: "玩法丰富",
      aspectRatio: "9:16",
      copy: copySets[4],
      roleLabel: "详情页细节信任",
      taskPrompt: "表现玩法丰富：用游戏板、动作轨迹、故事卡和互动区域作为大视觉元素，安排多个同款机器人姿势作为玩法证据；每个姿势、LED表情、视角和道具关系不同，不能只复制同一个站姿。"
    },
    {
      role: "detail",
      index: 6,
      title: "表情细节",
      aspectRatio: "9:16",
      copy: copySets[5],
      roleLabel: "详情页多角度证明",
      taskPrompt: "表现表情与互动细节：用蓝色LED表情屏、银色耳机装饰和黄黑圆润机身做局部特写，加入微笑、倾听、眨眼三种表情小窗；放大圈和细线只指向参考图中真实可见结构，不虚构内部元件。"
    },
    {
      role: "detail",
      index: 7,
      title: "多角度可动",
      aspectRatio: "9:16",
      copy: copySets[6],
      roleLabel: "详情页决策理由",
      taskPrompt: "表现多角度和可动结构：使用正面、侧面、背面/顶部和关节局部四种视角组成结构板，姿态与LED表情各不相同；四格不能都正面站立，必须保持同款黄黑银机器人结构一致，不新增未提供的按钮、接口或参数。"
    },
    {
      role: "detail",
      index: 8,
      title: "桌面陪伴与送礼",
      aspectRatio: "9:16",
      copy: copySets[7],
      roleLabel: "详情页收尾",
      taskPrompt: "表现桌面潮玩与送礼价值：同款机器人以生活化坐姿或邀请互动手势出现在书桌、展示架或无品牌礼盒旁，加入台灯、书本或办公桌面作为尺度辅助；构图舒展留白，区别前面的信息图和细节板，不出现价格、销量或促销贴纸。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: `${composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, screen.roleLabel, screen.index)}\n${buildAiRobotShotDirective("detail", screen.index, points)}`
  }));
}

function buildUmbrellaMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void points;
  void specs;
  const productName = productDisplayName(task, "晴雨两用折叠伞");
  const copySets = [
    [productName, "晴天遮阳 雨天挡雨", "通勤随身带"],
    ["雨天通勤更从容", "雨珠顺伞面滑落", "出门不怕突然下雨"],
    ["折叠入包更省心", "书包通勤包都好放", "出门携带不占位"],
    ["细节看得见", "彩色包边更有辨识度", "黑色手柄握持稳"],
    ["日常百搭不挑人", "上班上学出门都适合", "简约蓝调更耐看"]
  ];
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "折叠伞产品英雄首图",
        conversionGoal: "3秒看清这是蓝色晴雨两用折叠伞，折叠收纳形态、彩色包边和通勤属性明确。",
        sceneDirection: "严格以本地参考图里的同一把折叠伞为主体：蓝紫/藏蓝伞布、黑色短手柄、黑色挂绳、同色束带、下方红白蓝几何彩色包边必须保留。用干净办公桌或通勤桌面做背景，可有无品牌笔记本、眼镜、电脑一角、通勤包边角作为辅助。主体占画面70%-82%，可加入一处打开伞的小圆图作为晴雨两用暗示。",
        composition: "折叠伞为第一视觉主体，斜放或竖放形成稳定构图；文字在左上或右上留白区，不遮挡彩色包边、束带、手柄和挂绳。",
        typography: "现代黑体，标题短而大，副标题和小标签形成一个文本组；不要出现人群清单或长段说明。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "雨天通勤",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "雨天卖点证明图",
        conversionGoal: "用水珠和雨天通勤动作证明晴雨伞雨天可用，避免只做静物摆拍。",
        sceneDirection: "同一把伞处于打开状态，蓝色伞面覆盖画面主体，边缘红白蓝几何包边清楚；背景为雨天城市街道、地铁口或办公楼外，雨珠从伞面滑落，手部或通勤人物半身只做尺度证据。不要写防水等级、100%防水或绝对不湿衣。",
        composition: "打开伞占画面60%-75%，雨珠和城市反光做动态证据；人物和建筑虚化，商品边缘花边不能被裁掉。",
        typography: "标题靠近雨珠证据但不压伞面，副标题短句说明雨天通勤。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "入包收纳",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "便携收纳证明图",
        conversionGoal: "用折叠后放入包内的动作证明便携卖点。",
        sceneDirection: "同一把折叠伞收起后放入米色或黑色无品牌通勤包/书包中，手部正在取放，旁边可有笔记本、钥匙、耳机盒或办公桌面。蓝紫伞布、黑色手柄、挂绳、束带和彩色包边必须清楚可见。",
        composition: "伞和包口形成动作中心，手部只做操作证据；文字区放在包外干净留白，避免遮挡伞身。",
        typography: "标题短而清楚，副文案两行以内，不写尺寸重量。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "包边手柄",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "结构细节信任图",
        conversionGoal: "用彩色包边、伞布纹理、黑色手柄和挂绳细节建立做工信任。",
        sceneDirection: "一主两辅细节构图：主画面展示折叠伞中下段的红白蓝几何彩色包边和蓝紫伞布褶皱，辅图/局部放大展示黑色短手柄、挂绳、束带、伞布纹理或打开伞的边缘。必须来自同一把伞，不换图案。",
        composition: "主细节占65%左右，辅细节用圆形放大或浅色分区；细线图形可以连接细节，但不要新增无依据参数。",
        typography: "标题强调细节，副标题短句；不要把细节标注写成复杂参数表。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "百搭收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用日常通勤/上学/户外都能放的画面完成购买理由，避免生硬人群清单。",
        sceneDirection: "同一把折叠伞放在通勤桌面或包旁，也可有打开伞在晴天城市步道/校园外的柔焦小画面；整体表达蓝调简约、日常百搭。保留蓝紫伞布、彩色包边、黑色手柄和挂绳，不出现价格促销。",
        composition: "折叠伞居中或偏下，配合包、书本、眼镜或城市光影形成完整收尾；画面稳定高级。",
        typography: "主标题两行以内，副标题和小标签组成一个短文本组；严禁写大段目标人群清单。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildUmbrellaDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void points;
  void specs;
  const productName = productDisplayName(task, "晴雨两用折叠伞");
  const shared = [
    visualSystemToPrompt(visualSystem),
    "雨伞专属硬规则：全套必须锁定同一把蓝紫/藏蓝折叠伞，保留黑色短手柄、黑色伞杆、挂绳、同色束带、红白蓝几何彩色包边和打开后的蓝色伞面；不得变成长柄伞、透明伞、纯黑伞、纯色无花边伞或其他款式。",
    "每屏都要独立卖点和独立场景：雨天通勤、入包收纳、晴天遮阳、包边细节、手柄挂绳、多角度展示、桌面/包内收尾必须有明显差异。不要使用人群清单做标题。"
  ].join("\n");
  const copySets = [
    ["一把应对多变天气", "晴天雨天都能带", productName],
    ["雨天通勤更从容", "雨珠顺伞面滑落", "出门少一点狼狈"],
    ["折叠入包更省心", "书包通勤包都好放", "随手取放不占位"],
    ["晴天出门也能撑", "蓝调伞面更清爽", "日常户外不突兀"],
    ["伞边细节更有记忆点", "彩色包边看得见", "简约里多一点精致"],
    ["打开收起都清楚", "伞面手柄挂绳一屏看", "选伞更有把握"],
    ["桌面包里都好放", "通勤上学随身带", "日常收纳更整洁"],
    ["随身一把更安心", "从家门到办公室", "晴雨变化都从容"]
  ];
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string; roleLabel: string }> = [
    {
      role: "detail",
      index: 1,
      title: "核心主张",
      aspectRatio: "9:16",
      copy: copySets[0],
      roleLabel: "详情页首屏",
      taskPrompt: "大幅展示同一把蓝紫折叠伞，前景为收起状态，背景小画面或半透明分区展示打开状态；彩色包边、黑手柄、挂绳清楚。画面建立晴雨两用和通勤随身带的第一印象。"
    },
    {
      role: "detail",
      index: 2,
      title: "雨天通勤",
      aspectRatio: "9:16",
      copy: copySets[1],
      roleLabel: "详情页用户顾虑",
      taskPrompt: "雨天城市通勤场景：同一把伞打开遮雨，蓝色伞面有雨珠滑落，边缘红白蓝几何包边清楚；可出现通勤人物半身、办公楼或地铁口虚化背景。不要写防水等级或绝对承诺。"
    },
    {
      role: "detail",
      index: 3,
      title: "入包收纳",
      aspectRatio: "9:16",
      copy: copySets[2],
      roleLabel: "详情页功能证明",
      taskPrompt: "折叠入包动作：同一把伞收起后放入无品牌通勤包或学生书包，手部正在取放，旁边有笔记本、钥匙或办公桌道具。重点证明折叠收纳便利，伞身和彩色包边清楚。"
    },
    {
      role: "detail",
      index: 4,
      title: "晴天出门",
      aspectRatio: "9:16",
      copy: copySets[3],
      roleLabel: "详情页场景代入",
      taskPrompt: "晴天户外或城市步道场景：同一把蓝色伞打开在阳光下使用，人物或手部只做尺度证据，背景有干净天空、建筑或校园/通勤路。只表达晴天也能撑，不写防晒指数或紫外线数据。"
    },
    {
      role: "detail",
      index: 5,
      title: "包边细节",
      aspectRatio: "9:16",
      copy: copySets[4],
      roleLabel: "详情页细节信任",
      taskPrompt: "超近景细节屏：主图展示红白蓝几何彩色包边、蓝紫伞布褶皱和伞边缝线观感，辅图展示黑色手柄、挂绳、束带或打开伞边缘。必须保持同款图案，不生成其他花边。"
    },
    {
      role: "detail",
      index: 6,
      title: "多角度证明",
      aspectRatio: "9:16",
      copy: copySets[5],
      roleLabel: "详情页多角度证明",
      taskPrompt: "四宫格或多分区信息屏：展示收起正面、打开俯视、手柄挂绳、彩色包边局部、入包状态。每个分区都是同一把伞，颜色和图案一致，背景简洁统一。"
    },
    {
      role: "detail",
      index: 7,
      title: "收纳决策",
      aspectRatio: "9:16",
      copy: copySets[6],
      roleLabel: "详情页决策理由",
      taskPrompt: "桌面/包内收纳场景：同一把折叠伞放在办公桌、抽屉、通勤包或书包旁，搭配眼镜、笔记本、电脑一角等无品牌道具，表达日常收纳整洁。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: copySets[7],
      roleLabel: "详情页收尾",
      taskPrompt: "收尾图：同一把折叠伞放在家门口玄关、办公室桌面或通勤包旁，远处可有雨后城市窗景或阳光，形成从家门到办公室的日常陪伴感。构图和第1屏不同，更生活化。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, screen.roleLabel, screen.index)
  }));
}

function buildGenericMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const plan = buildGenericCopyPlan(task, points, specs);
  const proofMatrix = buildProductProofMatrix(task, productContext(task), plan);
  const primaryPoint = plan.primaryPoint;
  const copySets = plan.main;
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "3秒看懂商品品类、核心卖点和品牌质感，提高点击率。",
        sceneDirection: `商品以参考图一致的真实外观大号呈现，可置于符合类目的高品质生活场景中；产品占画面约75%-85%，结构、颜色、材质和关键图案必须清楚。\n${proofScriptToPrompt(proofMatrix.main[0])}`,
        composition: `商品第一视觉主体，标题区在天然留白处，背景服务商品，不堆砌装饰；如有人物或道具，只能作为小比例辅助，不能抢商品。${proofMatrix.main[0]?.avoidRepeat || ""}`,
        typography: "主标题最大，卖点短句次级，品类信息更小；移动端一眼读完。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "核心卖点",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "核心卖点证明图",
        conversionGoal: "把第一卖点转成可看见的使用关系，降低用户理解成本。",
        sceneDirection: `围绕“${primaryPoint}”设计真实使用动作或结构展示，不虚构未提供的功能数据。\n${proofScriptToPrompt(proofMatrix.main[1])}`,
        composition: `一主产品视角加一个克制的局部细节，不做复杂参数海报。${proofMatrix.main[1]?.avoidRepeat || ""}`,
        typography: "卖点标题强对比，辅助短句紧跟标题，标注少而准。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "使用场景",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "场景种草图",
        conversionGoal: "让目标人群代入真实使用环境，建立购买理由。",
        sceneDirection: `在符合“${usefulTargetAudience(task, "目标用户")}”审美的真实场景中展示商品与使用流程，商品完整清楚。\n${proofScriptToPrompt(proofMatrix.main[2])}`,
        composition: `场景有生活感但不抢主体，商品位于视觉中心或前景。${proofMatrix.main[2]?.avoidRepeat || ""}`,
        typography: "左上或侧边留白区排短标题，副文案压低存在感。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "细节特写",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节卖点图",
        conversionGoal: "解决用户看不清结构、材质和识别点的不确定。",
        sceneDirection: `商品近景突出${plan.detailFocus}，另一角度作为背景层次；细节必须服务本商品卖点，不做无关装饰。\n${proofScriptToPrompt(proofMatrix.main[3])}`,
        composition: `产品占画面70%左右，浅景深但关键细节清晰，文字避开商品关键区域。${proofMatrix.main[3]?.avoidRepeat || ""}`,
        typography: "成熟品牌画册式排版，留白充足，标注克制，不用促销贴纸。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "决策收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "回到商品卖点和目标人群场景完成临门一脚，不用空泛口号收尾。",
        sceneDirection: `商品以干净稳定的收尾英雄画面呈现，可加入同色系场景道具表达本商品的真实购买理由。\n${proofScriptToPrompt(proofMatrix.main[4])}`,
        composition: `商品清晰偏下或居中，右侧/上方保留信息区，画面稳定有结束感。${proofMatrix.main[4]?.avoidRepeat || ""}`,
        typography: "主标题两行以内，辅助句用细线信息条或小胶囊呈现，移动端清晰可读。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildCupMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const plan = buildCupCopyPlan(task, points);
  const copySets = plan.main;
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "3秒看清这是高颜值潮流水杯，商品足够大，杯盖、杯身图案和第一卖点明确，提高点击率。",
        sceneDirection: "严格使用本地商品图中的同一只潮流水杯，大号正面或 3/4 角度展示；透明杯身、浅蓝翻盖、白色吸管/直饮口、橙色防滑圈、黄色按钮、蓝色挂环/挂带、杯身彩色抽象图案和刻度必须清楚。产品占画面约78%-86%，户外清爽背景只做辅助，不让人物或道具抢主体。",
        composition: "商品位于画面中心或中下方，标题区在左上或侧边留白；可用浅蓝、橙色、奶白色图形呼应商品结构，但不新增无关文字。",
        typography: "主标题最大，颜值卖点第二层，品类说明第三层；文字区不超过画面30%，不得遮挡杯盖、按钮、吸管、杯身图案和刻度。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "材质安心",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "核心卖点证明图",
        conversionGoal: "把环保材质、无异味转成透明杯身和包装信息的可见证据，降低用户对日常饮水材质的顾虑。",
        sceneDirection: "同一只水杯和包装局部同框，透明杯身清透、杯身图案清楚，包装上的 Babycare、PPSU、2-IN-1 PPSU CUP、500mL、36月+ 等商品本体文字如出现必须保留；不写检测认证、无毒绝对化承诺或材质等级。",
        composition: "水杯为主，包装或杯身清透局部为辅；可用一处局部放大圈指向杯身/包装信息，但不新增额外中文小字。",
        typography: "卖点标题强对比，辅助短句紧跟标题，整体像成熟水杯/母婴杯详情主图，不做参数表。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "打开饮用",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "饮用动作证明图",
        conversionGoal: "用杯盖翻开和吸管/杯口可见的喝水动作证明隔热与户外饮用便利，避免物理逻辑错误。",
        sceneDirection: "年轻人或成年手部在户外拿起同一只水杯准备喝水或正在喝水；杯盖必须翻开，白色吸管、直饮口或杯口必须清楚露出，嘴巴只能靠近打开的吸管/杯口，禁止对着关闭杯盖喝水。可有公园、露营桌、城市步道或运动后休息背景，不写具体温度或保温时长。",
        composition: "水杯和打开的杯盖/吸管是视觉中心，人物只露手部或局部侧脸；背景清爽有户外感但不过度抢镜。",
        typography: "标题靠近打开饮用动作，副文案短而准；可用无文字箭头或细线连接打开的杯盖和吸管。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "户外携带",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "场景种草图",
        conversionGoal: "让年轻人代入出门、户外、通勤随手带杯的真实场景。",
        sceneDirection: "同一只水杯放在户外咖啡桌、公园长椅、露营桌或无品牌帆布包旁，手部抓握蓝色挂环/挂带或透明杯身；浅蓝翻盖、橙色防滑圈、黄色按钮和彩色图案仍可见。商品完整清楚，场景与第3屏饮用动作不同。",
        composition: "水杯在前景或视觉中心，道具只做使用证据；文字放在自然留白区，整体清爽年轻。",
        typography: "标题像生活方式短句，副文案压低存在感；允许少量无文字图形增强潮流感。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "细节收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "细节卖点图",
        conversionGoal: "解决用户看不清杯盖、按钮、吸管、刻度、杯身图案和挂环的不确定。",
        sceneDirection: "超近景展示浅蓝翻盖、白色吸管/直饮口、黄色按钮、橙色防滑圈、蓝色挂环/挂带、透明杯身刻度和彩色抽象图案；另一角度完整水杯作为背景层次。严格保持当前商品图上的图案、刻度和包装/杯身文字，不得改成乱码或无字杯。",
        composition: "主细节占画面约65%-75%，可用两个局部放大圈和无文字细线，背景浅景深但完整杯轮廓可见。",
        typography: "成熟品牌画册式排版，留白充足，只出现指定三句文案；文字避开杯身图案和刻度。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildBabyCareMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const plan = buildBabyCareCopyPlan(task, points);
  const copySets = plan.main;
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "3秒看清商品包装、品类和第一卖点，提高货架点击。",
        sceneDirection: "尿布湿/纸尿裤外包装大号清楚呈现，占画面75%-85%，旁边只放一片干净折叠样片和浅色育儿台道具；不出现婴儿身体或换尿布动作。",
        composition: "包装为第一主体，样片作为小比例辅助，文字放在干净留白处，背景温柔干净不杂乱。",
        typography: "主标题最大，卖点短句次级，辅助标签更小；移动端一眼读完。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "核心卖点",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "核心卖点证明图",
        conversionGoal: "用干净样片和吸收表现证明核心卖点，不做敏感穿戴画面。",
        sceneDirection: "浅色护理台近景，包装在后景清楚可见，前景是一片干净展开/折叠样片，可用透明滴管或清水小道具表现吸收关系；禁止尿液、换尿布、裸露婴儿身体或下半身特写。",
        composition: "一主样片近景加包装辅助，细线或局部放大圈连接吸收层，不做参数表。",
        typography: "卖点标题靠近样片证据，辅助短句紧跟标题，标注少而准。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "使用场景",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "场景种草图",
        conversionGoal: "让父母代入日常护理准备场景，建立购买理由。",
        sceneDirection: "干净婴儿房或育儿台场景，成年父母手部整理包装和干净样片，旁边有无品牌收纳篮/棉柔巾；商品完整清楚，不出现换尿布动作。",
        composition: "手部动作和商品同框，包装位于视觉中心或前景，场景有生活感但不抢主体。",
        typography: "左上或侧边留白区排短标题，副文案压低存在感。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "细节特写",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节卖点图",
        conversionGoal: "解决用户看不清包装、样片层次和吸收层细节的不确定。",
        sceneDirection: "超近景展示包装图案/原有文字、干净样片表层纹理和折叠边缘，可用一个局部放大圈；不得改写包装文字，不出现婴儿身体。",
        composition: "样片纹理和包装细节占画面主体，浅景深但关键细节清晰，文字避开商品关键区域。",
        typography: "成熟品牌画册式排版，留白充足，标注克制，不用促销贴纸。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "决策收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "回到父母日常护理准备，完成主图闭环。",
        sceneDirection: "包装和干净折叠样片放在浅色育儿台/收纳篮旁，成年父母手部正在准备外出包或整理护理用品；画面稳定有结束感。",
        composition: "包装清晰偏下或居中，右侧/上方保留信息区，浅木与暖白背景统一。",
        typography: "主标题两行以内，辅助句用细线信息条或小胶囊呈现，移动端清晰可读。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildCuttingBoardMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const plan = buildCuttingBoardCopyPlan(task, points);
  const copySets = plan.main;
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "3秒看清这是乌檀木菜板，木质感和厨房切配价值明确，提高货架点击。",
        sceneDirection: "严格使用本地商品图中的同一款菜板，整板大号清楚呈现，占画面75%-85%；乌檀木深棕色、木纹、边角、厚度和整体形状必须保持一致。背景可为暖白厨房台面和少量蔬果，但不能抢主体。",
        composition: "菜板为第一主体，前景少量蔬果/刀具只做尺度和厨房场景辅助，文字放在自然留白处。",
        typography: "主标题最大，材质卖点第二层，厨房切配第三层；文字区不超过画面30%。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "高硬度",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "核心卖点证明图",
        conversionGoal: "用真实切配动作证明高硬度和稳定感，降低用户对耐切使用的顾虑。",
        sceneDirection: "成年手部在同一块菜板上切黄瓜、胡萝卜或熟食食材，刀具无品牌，动作真实克制；菜板木纹和边缘清楚，不出现夸张劈砍或危险飞溅。",
        composition: "切配动作作为主证据，菜板占画面主体，可用一处局部放大圈展示刀口附近木纹，不做实验室参数海报。",
        typography: "卖点标题靠近切配动作，辅助文案短而准。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "冲洗方便",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "冲洗场景图",
        conversionGoal: "用水槽冲洗动作证明清洗方便，建立厨房日常使用理由。",
        sceneDirection: "同一块菜板在干净水槽盆上方或盆内被清水冲洗，成年手部轻扶菜板，水流自然；必须采用真实厨房水槽结构：水槽前沿在画面下方靠近观看者，水槽后沿在画面上方靠墙，水龙头底座只能安装在水槽后沿/靠墙台面内侧，龙身从后方向前伸入水槽盆内，出水口朝向水槽盆内。严禁把水龙头底座画在画面下方前沿、台面外侧、水槽外面或观众这一侧；菜板木纹、颜色和厚度仍清楚，不出现脏污夸张对比。",
        composition: "优先使用略俯拍或水槽正前方视角，完整看见水槽盆、后沿和后置水龙头的空间关系；菜板正面切菜面朝上或略微倾斜接水，水流从后置龙头落到菜板表面并进入水槽盆内；背景是暖白瓷砖/不锈钢水槽，文字在干净墙面或留白处。",
        typography: "场景型标题，短句精致，不能写未提供的速干、防霉或无毒承诺。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "木纹细节",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节卖点图",
        conversionGoal: "解决用户看不清乌檀木纹、边角厚度和质感的不确定。",
        sceneDirection: "超近景展示菜板乌檀木纹、切面边角、厚度和表面质感，另一角度整板作为背景层次；可出现清水珠和极简局部放大圈。",
        composition: "木纹和边角细节占画面主体，浅景深但关键纹理清晰，文字避开木纹关键区域。",
        typography: "成熟厨具品牌画册式排版，留白充足，标注克制。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "决策收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用抗菌率和冲洗收纳场景完成购买理由，不虚构额外认证。",
        sceneDirection: "同一块菜板干净立放或挂放在厨房台面/收纳区，旁边有少量无品牌蔬果和清水感道具；可出现“抗菌率99.9%”作为需求提供卖点，但不得出现检测机构、认证编号或更多数据。",
        composition: "菜板居中或偏下形成稳定收尾，右侧/上方保留信息区，画面干净有结束感。",
        typography: "主标题两行以内，辅助句用细线信息条或小胶囊呈现，移动端清晰可读。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildMagneticLifterMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const plan = buildMagneticLifterCopyPlan(task, points);
  const copySets = plan.main;
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "货架 3 秒内看清这是黄色永磁起重机/磁力吊，承载设备识别和第一卖点明确，提高工业买家点击。",
        sceneDirection: "严格使用本地商品图中的同一款黄色永磁起重机，大号 3/4 角度棚拍或工业台面展示，占画面 75%-85%；银色 U 型吊环、长操作手柄、黄色机身、黑色顶盖螺丝、侧轴、铭牌/参数标签和警示图标必须清楚。可在背景放低饱和钢板和钢材纹理，但不能抢主体。",
        composition: "商品为第一主体，底部可有钢板做尺度参照，标题在左侧或上方深灰留白；不要堆参数表，不做廉价红底促销。",
        typography: "工业设备首图标题有力量但克制，主标题最大，吸力卖点第二层，钢板搬运第三层；文字区不超过画面30%。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "吸力证明",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "核心卖点证明图",
        conversionGoal: "用钢板吸附吊装动作证明 3 倍吸力和稳定感，降低用户对吊装是否牢靠的顾虑。",
        sceneDirection: "同一台永磁起重机吸附在厚钢板上，U 型吊环连接无品牌吊钩/吊链，钢板低高度离地、处于可控吊起状态；黄色机身、磁吸底面和钢板接触关系必须清楚。工人如出现需佩戴安全帽手套并站在侧后方安全距离，禁止站在悬吊钢板下方。",
        composition: "钢板吊装关系是主证据，可用局部放大圈展示磁吸接触面，不画夸张飞溅火花或危险高空吊装。",
        typography: "卖点标题靠近吊装证据，副文案短而准，使用工业细线标注。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "户外工况",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "目标场景证明图",
        conversionGoal: "用户外钢材堆场/工地吊装证明多种起重场景适用和无需用电价值。",
        sceneDirection: "户外钢材堆场或工地起重区，同一台黄色永磁起重机在钢板或 H 型钢上作业，背景有水泥地、钢材堆和远处安全围栏；不出现电源线和电控箱，用画面表达无需用电。设备必须完整清楚，不被吊钩或钢材遮住。",
        composition: "设备和钢板在前景，工地/车间空间拉开但不杂乱，文字放在天空/墙面/深灰信息区。",
        typography: "场景型工业标题，搭配小胶囊或细线信息条，不做生活方式小清新。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "结构细节",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节卖点图",
        conversionGoal: "解决用户看不清吊环、手柄、铭牌和机身结构的不确定。",
        sceneDirection: "超近景展示银色 U 型吊环、长操作手柄、机身铭牌/参数标签、黑色顶盖螺丝和侧面圆柱轴，另一角度完整设备作为背景层次；机身已有文字和图标尽量保留，不得改成乱码或随机英文。",
        composition: "一主近景加两处局部放大圈，钢材银灰背景，文字避开铭牌和关键结构。",
        typography: "细节型工业画册排版，标题小而精，标注线克制清楚。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "决策收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用无需用电与多工况适用完成购买理由，形成工业设备可靠收尾。",
        sceneDirection: "同一台黄色永磁起重机放在钢材仓储区或车间工作台，旁边有无品牌吊链、钢板和安全帽/手套作为场景道具；不出现电源线。画面干净专业，设备完整清楚。",
        composition: "设备居中或偏下形成稳定收尾，右侧/上方保留深灰信息区；整体像专业工业品牌主图。",
        typography: "主标题两行以内，辅助句用参数信息块或细线标签呈现，移动端清晰可读。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildTissueMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const copySets = buildTissueCopyPlan(task, points).main;
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "货架 3 秒内看清这是蓝白花纹盒装抽取式面巾纸，商品足够大，原生木浆与柔软卖点明确，提高点击率。",
        sceneDirection: "严格使用本地商品图中的同一盒织梦牌抽取式面巾纸，大号正面或 3/4 角度展示；白色盒身、蓝白牡丹花纹、蓝色织梦标识、顶部抽出的白色压纹纸张、盒体比例和包装原有中文信息必须清楚；产品占画面约78%-86%。背景可用暖白墙面、浅木台面和少量绿叶，但不能抢主体。",
        composition: "商品居中略偏下形成第一视觉主体，顶部或左上保留标题区；背景干净，像成熟天猫家清主图，不做促销贴纸。",
        typography: "主标题最大，原生木浆卖点第二层，柔软卖点第三层；文字区不超过画面30%，不得遮挡蓝白花纹、织梦标识和抽出的纸张。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "柔软触感",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "柔软卖点证明图",
        conversionGoal: "用手部轻触和纸张弯曲证明柔软不粗糙，降低用户对纸感粗硬的顾虑。",
        sceneDirection: "成年女性或家庭用户手部从同一盒抽纸中轻轻抽出一张纸巾，纸张自然弯曲并显出压纹和柔软层次；包装在前景清楚可见，蓝白花纹和织梦标识不能被手遮挡。不要出现婴儿贴身擦拭或夸张皮肤对比。",
        composition: "手部抽取动作作为主证据，抽纸盒占画面主体；可用一处无文字局部放大圈展示纸张压纹。",
        typography: "标题靠近手部和纸张证据，副文案短而准；细线和浅蓝信息块承托文案，不新增任何标签文字。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "随手抽取",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "日常取用证明图",
        conversionGoal: "用客厅茶几或餐桌随手抽取动作证明家庭常备和抽取顺手。",
        sceneDirection: "同一盒抽纸放在浅木餐桌或客厅茶几上，成年女性手部正在抽取纸巾准备擦手、擦杯口或整理桌面；旁边可有无品牌水杯、餐盘或遥控器作为生活尺度。商品完整清楚，不能变成卷纸或湿巾包。",
        composition: "抽纸盒位于前景或视觉中心，手部和桌面道具形成真实使用关系；背景有生活感但不杂乱。",
        typography: "标题在自然留白区，第三句可做小胶囊；文案必须和抽取动作对应，不能写“使用场景”。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "细节特写",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节信任图",
        conversionGoal: "解决用户看不清纸张压纹、包装花纹和盒体细节的不确定。",
        sceneDirection: "一主两辅局部特写：主画面超近景展示白色纸张压纹、层次和柔软折痕；辅画面展示蓝白牡丹花纹、织梦标识、包装中文信息和盒体边角。所有细节必须来自同一盒抽纸，不改变图案和文字。",
        composition: "主细节占画面约65%-75%，辅细节用浅色分区或局部放大圈；文字避开包装标识和纸张纹理关键区域。",
        typography: "细节型画册排版，标题小而精；局部放大圈和细线只做图形，不新增标签文字。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "家庭收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用家庭常备和随手清洁完成主图闭环，让目标用户感到家里放一盒更省心。",
        sceneDirection: "同一盒抽纸放在温暖客厅茶几、餐桌或厨房台面上，旁边有无品牌收纳篮、水杯或浅色花材；可出现成年女性手部整理桌面，但抽纸盒必须是第一主体，蓝白花纹和抽出纸张清楚。",
        composition: "商品居中或偏下形成稳定收尾，右侧/上方保留信息区；画面有家庭温度但干净克制。",
        typography: "标题两行以内，副文案和第三句组成同一文本组；可用短横线、浅蓝色块和无文字图形增强设计感。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildIntimateApparelMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const primaryPoint = points[0] || "优雅红色更有记忆点";
  const materialPoint = pickConcretePoint(points, /棉感纹理看得见/, /棉|材质|面料/, "棉感纹理看得见");
  const comfortPoint = points.find((point) => /轻松|舒适|不紧/.test(point)) || points[2] || "穿着轻松不紧绷";
  const copySets = [
    [primaryPoint, "成熟女性内衣", "一眼看清款式"],
    [materialPoint, "近看纹理清楚", "贴身面料细节"],
    ["上身轮廓直观", comfortPoint, "贴合状态看得见"],
    ["杯型线条清楚", "肩带下围可见", "细节靠近看"],
    ["衣橱日常", "穿前一眼好搭", "搭配更从容"]
  ];
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "货架 3 秒内看清这是红色成熟女性内衣，颜色、质感和第一卖点突出，提高点击率；主标题不要直接写产品名称。",
        sceneDirection: "严格使用本地商品图中的同一件红色胸罩，大号正面平铺在柔软浅色织物上，或自然垂挂在无品牌衣架上；罩杯、肩带、下围、红色和纹理必须清楚；材质执行重点是“棉感纹理看得见”；产品占画面约78%-86%。不出现真人穿着首图，不做低俗性感氛围。禁止把胸罩竖立在桌面/柜面/抽屉边缘。",
        composition: "商品居中或略偏下，顶部/左侧留出标题区；背景为暖白影棚或柔软织物台面，内衣受力和重心真实，不能像硬壳摆件。后续实穿证明屏必须执行“成年模特实穿证明”，本张仍只做商品英雄陈列。",
        typography: "主标题最大，核心卖点第二层，品类说明第三层；文字区不超过画面30%，不得遮挡罩杯和肩带。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "棉感材质",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "材质卖点证明图",
        conversionGoal: "把纯棉/棉感卖点变成可见纹理，建立亲肤日常穿着的信任。",
        sceneDirection: "用罩杯表面或下围布料的近景展示细密纹理，旁边保留一件平铺或衣架垂挂的完整商品小视角；可用柔软棉布道具衬托，但不写未提供的检测或成分百分比。禁止让完整商品不合逻辑地竖立。",
        composition: "一主近景一辅完整商品，局部放大框和细线标注克制高级。",
        typography: "标题短而有力，标注只指向纹理区域，像成熟内衣品牌画册。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "轻松穿着",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "穿着体验场景图",
        conversionGoal: "用成年模特实穿证明版型和轻松穿着，让 38-40 岁女性代入日常穿着需求。",
        sceneDirection: "优先用专业躯干模特或衣架轻挂展示自然轮廓；如出现真人必须是成年女性，姿态克制，不露脸或自然裁切，不能挑逗。商品主体清楚，重点在穿着关系而不是身体。",
        composition: "商品与躯干/衣架居中，背景为浅色衣帽间或暖白影棚，留白干净。",
        typography: "标题在自然留白区，副文案不超过两行，不写夸张功效。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "版型细节",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "结构细节信任图",
        conversionGoal: "解决用户看不清杯型、肩带、下围细节的不确定。",
        sceneDirection: "用正面平铺和局部特写展示罩杯弧度、肩带调节扣、下围车线；只表现已能从商品图看到的结构，不虚构无钢圈、聚拢、无痕等功能。",
        composition: "产品占画面70%左右，三处细线标注，文字避开关键结构。",
        typography: "成熟品牌画册式排版，留白充足，标注克制。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "决策收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用真实衣橱/内搭场景完成主图闭环，让用户感到这件内衣适合日常穿搭。",
        sceneDirection: "红色胸罩必须自然平放在打开的浅色衣橱抽屉内，或自然挂在无品牌衣架上；旁边可有折叠白衬衫、针织衫或丝巾作为内搭联想。商品完整清楚，不能竖立在柜面或抽屉边缘，不出现促销语。",
        composition: "商品清晰偏下或居中，场景道具只做真实生活证据；右侧/上方保留信息区，有收尾感。",
        typography: "主标题两行以内，文案像成熟品牌画册，不做参数条或选择建议条。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildKitchenTextileMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const productName = productDisplayName(task, "精选商品");
  const cleanPoint = pickConcretePoint(points, /轻轻一擦就干净/, /擦|干净|水渍|清洁/, "轻轻一擦就干净");
  const washPoint = points.find((point) => /洗|冲/.test(point)) || "一冲一洗更省心";
  const colorPoint = pickConcretePoint(points, /多色可选好区分/, /多色|颜色|区分/, "多色可选好区分");
  const texturePoint = points.find((point) => /绒|纹理|细密|柔软|吸水/.test(point)) || "细密绒感看得见";
  const specHint = firstUsefulSpec(specs, "按厨房不同用途分开使用");
  const copySets = [
    [productName, cleanPoint, colorPoint],
    [cleanPoint, "台面水渍随手擦", "厨房清洁更省心"],
    [washPoint, "水槽一冲更清爽", "日常清洗不费劲"],
    [texturePoint, "靠近看也清楚", "柔软厚实有质感"],
    [colorPoint, "擦手擦台分开用", specHint]
  ];
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "货架 3 秒内看清这是多色厨房毛巾，商品足够大，多色和清洁卖点明确，提高点击率。",
        sceneDirection: "严格使用本地商品图中的同一组多色厨房毛巾，大号叠放或阶梯式平铺展示；浅蓝、淡粉、柔紫、米咖、浅灰等颜色层次和毛绒纹理必须清楚，产品占画面约78%-86%。可有极少量厨房台面/水槽背景暗示使用场景，但不能让碗盘、人物或道具抢主体。",
        composition: "商品置于画面中心或中下方形成第一视觉主体，标题区在左上天然留白；背景明亮干净，像成熟天猫家清主图，不做廉价促销贴纸。",
        typography: "主标题最大，核心卖点第二层，多色卖点第三层；文字区不超过画面30%，不得遮挡毛巾颜色层次和绒毛纹理。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "擦拭清洁",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "核心卖点证明图",
        conversionGoal: "把“轻轻一擦就干净”变成可见动作，解决买家对厨房擦拭是否顺手的顾虑。",
        sceneDirection: "同一组毛巾中的一条正在擦拭浅木或暖白厨房台面上的水渍/少量酱汁痕迹；手部可以出现但不露脸，动作真实克制。旁边保留叠放的多色毛巾小视角，证明同一组商品。",
        composition: "擦拭动作作为主画面，水渍前后关系要清楚但不能夸张脏污；可用一处局部放大展示毛巾接触台面的细节。",
        typography: "卖点标题强对比，副文案短而准；标注只指向擦拭区域，不写强力去油、抗菌等未提供功效。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "好洗场景",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "易清洗证明图",
        conversionGoal: "用水槽冲洗动作证明好洗，降低用户对厨房毛巾容易脏、难清洗的顾虑。",
        sceneDirection: "一条多色毛巾在白色水槽或水龙头下轻轻冲洗，水流清透，手部自然拧洗或展开；旁边可有干净挂放的其他颜色毛巾。画面表达日常好洗，不写具体去污率或速干数据。",
        composition: "水槽和毛巾占视觉中心，水流有真实感但不过度飞溅；标题在上方或侧边留白区。",
        typography: "标题两行以内，副文案压低存在感；整体像品质家清详情图，不做夸张对比实验。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "绒感细节",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "细节卖点图",
        conversionGoal: "解决用户看不清厚度、绒毛纹理和布边细节的不确定。",
        sceneDirection: "超近景展示厨房毛巾表面的细密绒毛、柔软厚度、布边收口和叠放层次；另一角度完整多色叠放作为背景层次。只展示真实纺织质感，不虚构材质成分比例。",
        composition: "主细节占画面约65%-75%，背景浅景深但颜色层次可见；如需标注，只能用无文字细线、圆点或局部放大圈，不能生成额外中文标签。",
        typography: "成熟品牌画册式排版，留白充足，只保留指定三句文案；文字避开绒毛纹理主区域。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "多色分区",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用多色分区和厨房收纳完成购买决策，让用户知道不同用途可以分开使用。",
        sceneDirection: "多色厨房毛巾整齐挂在无品牌挂杆或收纳在浅木抽屉/台面篮中；用画面中的颜色和摆放暗示擦手、擦台分开用，但不要生成用途列表、图例、表格或额外小字。商品完整清楚，颜色必须与参考图一致。",
        composition: "多色毛巾横向或纵向有秩序展开，留出右侧/上方信息区；画面稳定有收尾感。",
        typography: "主标题两行以内，只出现指定三句中文；可以用无文字图形分隔信息，但不能加用途清单、图例小字或任何未指定文案。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildSkincareMainSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const productName = productDisplayName(task, "精选商品");
  const gentlePoint = pickConcretePoint(points, /^温和不刺激$/, /温和|刺激|负担|舒缓/, "温和不刺激");
  const moisturePoint = pickConcretePoint(points, /水润保湿感/, /保湿|水润|补水|滋润/, "水润保湿感");
  const texturePoint = points.find((point) => /质地|膏体|肤感/.test(point)) || "水润质地看得见";
  const modelPoint = points.find((point) => /真人|上脸|模特|透亮|状态/.test(point)) || "真人上脸更直观";
  const premiumPoint = points.find((point) => /高端|品质|黑银|包装/.test(point)) || "黑银高级瓶身";
  const copySets = [
    [productName, moisturePoint, gentlePoint],
    [gentlePoint, "日常护肤少负担", "脸颊轻抹更安心"],
    [texturePoint, "细腻膏体", "水润感一眼看见"],
    [modelPoint, "自然透亮好状态", "可以露脸更真实"],
    [premiumPoint, "镜面银盖", "质感看得见"]
  ];
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { screen: ScreenPrompt }> = [
    {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: copySets[0],
      screen: {
        role: "产品英雄首图",
        conversionGoal: "货架 3 秒内看清这是高端黑银罐保湿霜，商品足够大，保湿和温和卖点明确，提高点击率。",
        sceneDirection: "严格使用本地商品图中的同一款黑色圆罐保湿霜，大号正面或 3/4 角度展示，黑色光泽罐身、镜面银盖、圆柱比例、原有瓶身文字/图案和高端反射必须清楚；产品占画面约78%-86%。不得复制外部参考图英文品牌商标，不在背景或装饰上新增随机英文；本地商品图上已有的包装文字必须保留，不可改成无字瓶身。",
        composition: "商品置于画面中心或中下方，珍珠白棚拍背景、镜面台面轻反射，少量水光或香槟金图形增强高级感；标题区在左上或上方留白。",
        typography: "主标题最大，保湿卖点第二层，温和卖点第三层；文字区不超过画面30%，不得遮挡瓶身和银盖。",
        copy: copySets[0]
      }
    },
    {
      role: "main",
      index: 2,
      title: "温和肤感",
      aspectRatio: "1:1",
      copy: copySets[1],
      screen: {
        role: "温和卖点证明图",
        conversionGoal: "把“温和不刺激”转成可感知的脸颊轻抹动作，降低用户对上脸刺激的顾虑。",
        sceneDirection: "同一名成年女性模特自然露脸或侧脸，干净真实皮肤，手指在脸颊轻抹少量保湿霜；黑色罐身在前景或手边清楚可见。表情自然高级，不夸张磨皮，不表现红肿过敏或医美效果。",
        composition: "模特脸部与产品同框，产品不可小到看不清；可加入柔和水光图形，但不出现医学符号和检测图标。",
        typography: "标题强对比，副文案短而温和；允许少量无文字线性图形增强设计感，不加未指定小字。",
        copy: copySets[1]
      }
    },
    {
      role: "main",
      index: 3,
      title: "质地特写",
      aspectRatio: "1:1",
      copy: copySets[2],
      screen: {
        role: "质地细节图",
        conversionGoal: "用膏体近景证明水润质地，让用户直观看到保湿霜质感。",
        sceneDirection: "打开黑色保湿霜罐，展示浅色细腻膏体表面、抹刀挑起或指尖取用的一小抹质地；旁边保留完整黑银罐身小视角。只表现质地观感，不写成分和浓度。",
        composition: "一主膏体近景一辅完整产品，可用局部放大圈、水滴和香槟金细线，但不添加额外文字标签。",
        typography: "标题短而有力，留白充足，文字避开膏体和罐口。",
        copy: copySets[2]
      }
    },
    {
      role: "main",
      index: 4,
      title: "模特上脸",
      aspectRatio: "1:1",
      copy: copySets[3],
      screen: {
        role: "真人上脸场景图",
        conversionGoal: "满足用户要求的露脸模特，用真实肤感和护肤动作提升信任与高端感。",
        sceneDirection: "同一名成年女性模特正脸或 3/4 侧脸，坐在高端梳妆台前，手持黑色保湿霜罐或正在轻拍脸颊；皮肤自然透亮，妆容干净，产品与脸部同为视觉重点。商品罐身原有文字/图案必须清楚保留；不得在背景或装饰上新增随机英文、竞品品牌或夸张美容仪器。",
        composition: "模特脸部占画面约45%，产品在前景或手中清楚可见；背景柔焦镜面和珍珠白台面，整体高级但不空。",
        typography: "主标题在自然留白区，副文案两行以内；可以用无文字图形装饰增加设计感。",
        copy: copySets[3]
      }
    },
    {
      role: "main",
      index: 5,
      title: "品质收尾",
      aspectRatio: "1:1",
      copy: copySets[4],
      screen: {
        role: "购买决策收尾图",
        conversionGoal: "用黑银包装和高端梳妆台场景完成主图闭环，突出品质感与日常摆放价值。",
        sceneDirection: "黑色保湿霜罐放在珍珠白梳妆台或镜面台面上，银盖反射清楚，旁边可有无品牌化妆棉、透明水滴、浅色丝缎或小花材；商品完整清楚，罐身原有文字/图案必须保留，不复制外部参考商标。",
        composition: "商品居中偏下或右下，左上保留文字区；香槟金线条、镜面反射和柔和阴影增强设计感。",
        typography: "主标题用简洁现代黑体，副文案短句水平排版；只出现指定三句中文，可以有无文字图形元素，但不能加英文、书法字、装饰乱码或额外小字。",
        copy: copySets[4]
      }
    }
  ];
  return screens.map(({ screen, ...spec }) => ({
    ...spec,
    prompt: composeScreenPrompt(visualSystem, screen)
  }));
}

function buildNativeImageSpecs(
  task: ProductTask,
  brand: BrandProfile,
  analysis: ReferenceAnalysis,
  productVisualInsight?: ProductVisualInsight,
  creativePlan?: CreativePlan
): NativeImageSpec[] {
  const points = inferSellingPoints(task, analysis);
  const context = productContext(task);
  const specs = specConflictsWithProduct(task.specs, context) ? [] : cleanBusinessPhrases(splitList(task.specs));
  const primaryPoint = points[0] || "日常好用";
  const secondaryPoint = points[1] || "细节清晰";
  const tertiaryPoint = points[2] || "安心选择";
  const productName = productDisplayName(task, "精选商品");
  const banned = [brand.bannedElements, task.bannedElements].filter(Boolean).join("；");
  const visualSystem = buildVisualSystem(task, brand, points, banned, analysis, productVisualInsight);
  const main = context.isAiRobot
    ? buildAiRobotMainSpecs(task, visualSystem, points, specs)
    : context.isChildProduct && context.isFootwear
    ? buildChildFootwearMainSpecs(task, visualSystem, points, specs)
    : context.isStudentBackpack
      ? buildStudentBackpackMainSpecs(task, visualSystem, points, specs)
    : context.isUmbrella
      ? buildUmbrellaMainSpecs(task, visualSystem, points, specs)
    : context.isPants
      ? buildPantsMainSpecs(task, visualSystem, points, specs)
    : context.isBabyCare
      ? buildBabyCareMainSpecs(task, visualSystem, points, specs)
    : context.isCuttingBoard
      ? buildCuttingBoardMainSpecs(task, visualSystem, points, specs)
    : context.isMagneticLifter
      ? buildMagneticLifterMainSpecs(task, visualSystem, points, specs)
    : context.isTissue
      ? buildTissueMainSpecs(task, visualSystem, points, specs)
    : context.isChildProduct && context.isCup && context.isTemperatureDisplay
      ? buildChildTemperatureCupMainSpecs(task, visualSystem, points, specs)
      : context.isChildProduct && context.isCup
        ? buildChildCupMainSpecs(task, visualSystem, points, specs)
      : context.isCup
        ? buildCupMainSpecs(task, visualSystem, points, specs)
      : context.isIntimateApparel
        ? buildIntimateApparelMainSpecs(task, visualSystem, points, specs)
        : context.isKitchenTextile
          ? buildKitchenTextileMainSpecs(task, visualSystem, points, specs)
          : context.isSkincare
            ? buildSkincareMainSpecs(task, visualSystem, points, specs)
      : buildGenericMainSpecs(task, visualSystem, points, specs);
  const detail = context.isAiRobot
    ? buildAiRobotDetailSpecs(task, visualSystem, points, specs)
    : context.isChildProduct && context.isCup && context.isTemperatureDisplay
    ? buildChildTemperatureCupDetailSpecs(task, brand, visualSystem, points, specs)
    : context.isStudentBackpack
      ? buildStudentBackpackDetailSpecs(task, visualSystem, points, specs)
    : context.isUmbrella
      ? buildUmbrellaDetailSpecs(task, visualSystem, points, specs)
    : context.isBabyCare
      ? buildBabyCareDetailSpecs(task, visualSystem, points, specs)
    : context.isCuttingBoard
      ? buildCuttingBoardDetailSpecs(task, visualSystem, points, specs)
    : context.isMagneticLifter
      ? buildMagneticLifterDetailSpecs(task, visualSystem, points, specs)
    : context.isTissue
      ? buildTissueDetailSpecs(task, visualSystem, points, specs)
    : context.isChildProduct && context.isCup
      ? buildChildCupDetailSpecs(task, visualSystem, points, specs)
    : context.isIntimateApparel
      ? buildIntimateApparelDetailSpecs(task, visualSystem, points, specs)
      : context.isKitchenTextile
        ? buildKitchenTextileDetailSpecs(task, visualSystem, points, specs)
        : context.isSkincare
          ? buildSkincareDetailSpecs(task, visualSystem, points, specs)
    : buildGenericDetailSpecs(task, brand, visualSystem, points, specs);
  const languageSafeSpecs = context.isEnglishMarketplace
    ? applyEnglishVisibleCopyContract(task, [...main, ...detail], points, specs)
    : [...main, ...detail];
  const fallbackInsight = productVisualInsight ?? buildPromptLayerProductVisualInsight(task, [], analysis);
  const activeCreativePlan = creativePlan ?? buildDeterministicCreativePlan(
    task,
    fallbackInsight,
    buildStoryboardPlan(storyboardInput(task, points))
  );
  return languageSafeSpecs.map((spec) => {
    const frame = activeCreativePlan.frames.find((candidate) => candidate.role === spec.role && candidate.index === spec.index);
    if (!frame) return spec;
    return {
      ...spec,
      creativeFrame: frame,
      auditSummary: frameAuditSummary(frame),
      prompt: compileDirectedFramePrompt({
        task,
        insight: fallbackInsight,
        direction: activeCreativePlan.direction,
        frame,
        copy: spec.copy,
        title: spec.title,
        aspectRatio: spec.aspectRatio,
        forbidden: banned,
        legacyPrompt: spec.prompt
      })
    };
  });
}

function applyEnglishVisibleCopyContract(
  task: ProductTask,
  specsToLocalize: NativeImageSpec[],
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const plan = buildEnglishMarketplaceCopyPlan(task, points, specs, productContext(task));
  return specsToLocalize.map((spec) => {
    const copy = spec.role === "main" ? plan.main[spec.index - 1] : plan.detail[spec.index - 1];
    const safeCopy = (copy || []).map(cleanEnglishVisibleCopy).filter(Boolean);
    const promptWithoutOldCopy = spec.prompt
      .split(/\r?\n/)
      .filter((line) => !/营销文案只允许出现以下指定文字|文字层级：第[123]句|其余指定文字/.test(line))
      .join("\n");
    const aspectRatio = spec.role === "main" ? "1:1" : "9:16";
    return {
      ...spec,
      copy: safeCopy,
      prompt: [
        promptWithoutOldCopy,
        "English visible-copy override (highest priority): all newly added visible marketing copy must use only the exact English lines below. Chinese scene directions are internal instructions and must never be rendered as visible text.",
        buildTypographyCompositionRule(safeCopy, spec.title, aspectRatio),
        exactCopyInstruction(safeCopy)
      ].join("\n")
    };
  });
}

function buildGenericDetailSpecs(
  task: ProductTask,
  brand: BrandProfile,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const shared = visualSystemToPrompt(visualSystem);
  const plan = buildGenericCopyPlan(task, points, specs);
  const proofMatrix = buildProductProofMatrix(task, productContext(task), plan);
  const copySets = plan.detail;
  const shotPrompts = buildGenericDetailShotPrompts(task, plan)
    .map((prompt, index) => `${prompt}\n${proofScriptToPrompt(proofMatrix.detail[index] ?? proofMatrix.main[index % proofMatrix.main.length])}`);
  const detail: NativeImageSpec[] = [
    {
      role: "detail",
      index: 1,
      title: "核心主张",
      aspectRatio: "9:16",
      copy: copySets[0],
      prompt: composeDetailScreenPrompt(shared, `制作竖版详情页首屏。先给本商品最强购买理由，用大幅商品英雄画面证明；不要把产品名称当主标题，不写虚构 Logo，不写空泛品牌口号。\n本屏画面脚本：${shotPrompts[0]}`, copySets[0], "详情页首屏", 1)
    },
    {
      role: "detail",
      index: 2,
      title: "用户顾虑",
      aspectRatio: "9:16",
      copy: copySets[1],
      prompt: composeDetailScreenPrompt(shared, `制作竖版详情页顾虑回应屏。画面从目标用户真实购买顾虑切入，用产品和场景回答为什么值得买；文案必须是消费者能感知的商品卖点，不出现页面模块名。\n本屏画面脚本：${shotPrompts[1]}`, copySets[1], "详情页用户顾虑", 2)
    },
    {
      role: "detail",
      index: 3,
      title: "卖点证明",
      aspectRatio: "9:16",
      copy: copySets[2],
      prompt: composeDetailScreenPrompt(shared, `制作竖版详情页核心卖点证明屏。围绕“${plan.primaryPoint}”安排近景、动作或当前商品适用的开合、操作、摆放、整理或取用等可见证据；不能虚构未提供的数据、认证或功能。\n本屏画面脚本：${shotPrompts[2]}`, copySets[2], "详情页卖点证明", 3)
    },
    {
      role: "detail",
      index: 4,
      title: "场景代入",
      aspectRatio: "9:16",
      copy: copySets[3],
      prompt: composeDetailScreenPrompt(shared, `制作竖版详情页场景代入屏。场景必须符合本商品真实使用/送礼/穿搭/居家逻辑，商品完整清楚且是主角；文字和画面必须讲同一个卖点。\n本屏画面脚本：${shotPrompts[3]}`, copySets[3], "详情页场景代入", 4)
    },
    {
      role: "detail",
      index: 5,
      title: "细节信任",
      aspectRatio: "9:16",
      copy: copySets[4],
      prompt: composeDetailScreenPrompt(shared, `制作竖版详情页细节信任屏。近景突出${plan.detailFocus}，用局部放大、细线或小图形增强设计感；商品识别点必须准确，文字不要遮挡关键细节。\n本屏画面脚本：${shotPrompts[4]}`, copySets[4], "详情页细节信任", 5)
    },
    {
      role: "detail",
      index: 6,
      title: "多角度证明",
      aspectRatio: "9:16",
      copy: copySets[5],
      prompt: composeDetailScreenPrompt(shared, `制作竖版详情页多角度证明屏。用一主一辅或多宫格构图补充展示商品整体和关键细节，让用户理解卖点从哪里来；不做无意义空镜，不添加未提供参数。\n本屏画面脚本：${shotPrompts[5]}`, copySets[5], "详情页多角度证明", 6)
    },
    {
      role: "detail",
      index: 7,
      title: "决策理由",
      aspectRatio: "9:16",
      copy: copySets[6],
      prompt: composeDetailScreenPrompt(shared, `制作竖版详情页决策理由屏。用目标人群的真实使用、送礼、穿搭或居家场景完成购买理由，不强行写规格选择建议；有具体规格才展示规格，没有规格就讲更具体的商品价值。\n本屏画面脚本：${shotPrompts[6]}`, copySets[6], "详情页决策理由", 7)
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: copySets[7],
      prompt: composeDetailScreenPrompt(shared, `制作竖版详情页收尾屏。回到产品英雄画面和本商品核心价值，留白克制，形成完整系列的高级结束；不要使用空泛口号或模板词。\n本屏画面脚本：${shotPrompts[7]}`, copySets[7], "详情页系列收尾", 8)
    }
  ];
  return detail;
}

function buildStudentBackpackDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const shared = visualSystemToPrompt(visualSystem);
  const plan = buildStudentBackpackCopyPlan(task, points);
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string; roleLabel: string }> = [
    {
      role: "detail",
      index: 1,
      title: "核心主张",
      aspectRatio: "9:16",
      copy: plan.detail[0],
      roleLabel: "详情页首屏",
      taskPrompt: "制作竖版详情页首屏。不要把产品名称当主标题。用大幅学生双肩背包英雄画面建立第一印象：当前商品图里的真实包身颜色、图案、前袋、侧袋、肩带、拉链和挂件/配件如有必须清楚；背景是明亮校园光影或浅木课桌，商品是第一视觉主体。标题先讲轻便肩负和外观颜值，不堆参数，不写虚构 Logo。"
    },
    {
      role: "detail",
      index: 2,
      title: "上学收纳顾虑",
      aspectRatio: "9:16",
      copy: plan.detail[1],
      roleLabel: "详情页用户顾虑",
      taskPrompt: "制作竖版详情页顾虑回应屏。画面从孩子上学东西多的真实需求切入：同一款书包放在上学前玄关或浅木课桌旁，拉链打开一部分，无品牌课本、作业本、文具和水杯有序放入；前袋、侧袋和配件如有可见。不要写容量升数、超大容量、防盗或防水。"
    },
    {
      role: "detail",
      index: 3,
      title: "肩带轻便",
      aspectRatio: "9:16",
      copy: plan.detail[2],
      roleLabel: "详情页卖点证明",
      taskPrompt: "制作竖版详情页肩带轻便证明屏。同一名 8-13 岁学生背着同一款书包走在校园步道或校门旁，镜头从侧后方或 3/4 背面拍摄；当前图同款肩带贴合肩背并自然受力，书包主体完整清楚。可以用一处局部放大圈展示肩带，但不写护脊、减负科技、承重测试或健康功效。"
    },
    {
      role: "detail",
      index: 4,
      title: "校园场景",
      aspectRatio: "9:16",
      copy: plan.detail[3],
      roleLabel: "详情页场景代入",
      taskPrompt: "制作竖版详情页校园上学场景屏。同一名学生背着同一款书包在校门、教室座椅或课桌旁自然活动，可露自然侧脸或正脸；书包必须完整清楚，当前图真实图案、前袋和配件如有不能被人物或书本遮挡。画面要和第3屏肩带证明不同，换成更开阔的校园/教室场景。"
    },
    {
      role: "detail",
      index: 5,
      title: "细节信任",
      aspectRatio: "9:16",
      copy: plan.detail[4],
      roleLabel: "详情页细节信任",
      taskPrompt: "制作竖版详情页细节信任屏。一主两辅局部特写展示当前商品图真实可见的前袋、图案/色块/装饰、侧袋、肩带、挂件/配件如有、拉链走线和织物质感；可用局部放大圈、细线和浅色图形增强设计感。文字避开关键图案，不能把图案改成其他样式。"
    },
    {
      role: "detail",
      index: 6,
      title: "多角度展示",
      aspectRatio: "9:16",
      copy: plan.detail[5],
      roleLabel: "详情页多角度证明",
      taskPrompt: "制作竖版详情页多角度证明屏。用品牌画册式分区展示同一款书包的正面、侧面、背面肩带、前袋/配件细节四个视角；每个视角都保持当前商品图真实颜色、图案、前袋、肩带和配件如有一致。不要做容量参数表，不新增防水、防盗、护脊、材质认证或承重数据。"
    },
    {
      role: "detail",
      index: 7,
      title: "上学决策",
      aspectRatio: "9:16",
      copy: plan.detail[6],
      roleLabel: "详情页决策理由",
      taskPrompt: "制作竖版详情页上学收纳决策屏。场景换到教室座椅、课桌旁或校园长椅：同一款书包与课本、作业本、文具和无品牌水杯合理同框，学生手部正在从前袋或侧袋拿取物品；画面表达上学日常更从容，不写选择建议、尺码建议或参数。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: plan.detail[7],
      roleLabel: "详情页系列收尾",
      taskPrompt: "制作竖版详情页收尾屏。回到清爽校园或浅木学习区的远景留白画面，同一款书包放在校园长椅、教室椅背或课桌旁，也可由同一名学生自然背着走过校门；构图比第1屏更远、更有呼吸感，商品外观清楚，形成高级校园系列收尾，不做开学促销收口。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, screen.roleLabel, screen.index)
  }));
}

function buildBabyCareDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const shared = visualSystemToPrompt(visualSystem);
  const plan = buildBabyCareCopyPlan(task, points);
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string }> = [
    {
      role: "detail",
      index: 1,
      title: "核心主张",
      aspectRatio: "9:16",
      copy: plan.detail[0],
      taskPrompt: "制作竖版详情页首屏。不要把产品名称当主标题；用大幅包装英雄图和一片干净折叠样片建立婴儿护理用品的温和、干净、可信感。背景是浅色育儿台或婴儿房收纳区，禁止婴儿身体、换尿布动作、穿戴展示或裸露画面。"
    },
    {
      role: "detail",
      index: 2,
      title: "用户顾虑",
      aspectRatio: "9:16",
      copy: plan.detail[1],
      taskPrompt: "制作竖版详情页顾虑回应屏。画面从父母整理护理用品的真实顾虑切入：成年父母手部在育儿台上拿取包装和干净样片，旁边是无品牌湿巾盒/棉柔巾/收纳篮。商品清楚，不出现婴儿下半身、换尿布动作或敏感贴身画面。"
    },
    {
      role: "detail",
      index: 3,
      title: "卖点证明",
      aspectRatio: "9:16",
      copy: plan.detail[2],
      taskPrompt: "制作竖版详情页吸收表现证明屏。用透明滴管或小量清水滴在干净样片表层，近景展示清水吸收和样片层次；包装在背景辅助出现。禁止尿液、排泄物、婴儿身体、医疗检测数据或认证标识。"
    },
    {
      role: "detail",
      index: 4,
      title: "场景代入",
      aspectRatio: "9:16",
      copy: plan.detail[3],
      taskPrompt: "制作竖版详情页育儿台日常场景。拉开镜头展示干净婴儿房/护理台，包装、折叠样片、收纳篮和父母手部整理动作同框；如背景出现婴儿，必须穿完整衣物并远景虚化，不能出现换尿布或下半身特写。"
    },
    {
      role: "detail",
      index: 5,
      title: "细节信任",
      aspectRatio: "9:16",
      copy: plan.detail[4],
      taskPrompt: "制作竖版详情页细节信任屏。超近景展示干净样片表层纹理、吸收层边缘、折叠厚度、包装图案和原有文字，可用局部放大圈和细线增强设计感；不得改写包装文字，不出现婴儿身体。"
    },
    {
      role: "detail",
      index: 6,
      title: "多角度证明",
      aspectRatio: "9:16",
      copy: plan.detail[5],
      taskPrompt: "制作竖版详情页多角度证明屏。用四宫格或画册式分区展示包装正面、侧面、干净折叠样片、样片表层纹理；同一商品外观保持一致，不做参数表，不新增认证、材质等级或吸收数据。"
    },
    {
      role: "detail",
      index: 7,
      title: "决策理由",
      aspectRatio: "9:16",
      copy: plan.detail[6],
      taskPrompt: "制作竖版详情页决策理由屏。外出前准备场景：成年父母手部把包装或干净样片放入无品牌妈咪包/收纳袋，旁边是干净婴儿用品；画面表达日常护理准备顺手，不出现婴儿贴身画面。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: plan.detail[7],
      taskPrompt: "制作竖版详情页收尾屏。包装和干净样片在浅色育儿台上形成安静留白品牌画面，旁边少量无品牌棉柔巾、收纳篮和柔和布料；构图比首屏更远更有结束感，禁止婴儿身体和换尿布动作。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, `详情页${screen.title}`, screen.index)
  }));
}

function buildCuttingBoardDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const shared = visualSystemToPrompt(visualSystem);
  const plan = buildCuttingBoardCopyPlan(task, points);
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string }> = [
    {
      role: "detail",
      index: 1,
      title: "核心主张",
      aspectRatio: "9:16",
      copy: plan.detail[0],
      taskPrompt: "制作竖版详情页首屏。不要把产品名称当主标题；用大幅乌檀木菜板英雄画面和少量厨房蔬果建立高级厨房切配质感。菜板整板、木纹、边角和厚度清楚，商品是第一视觉主体。"
    },
    {
      role: "detail",
      index: 2,
      title: "用户顾虑",
      aspectRatio: "9:16",
      copy: plan.detail[1],
      taskPrompt: "制作竖版详情页顾虑回应屏。画面从家庭厨房切配频繁、菜板要稳要耐用的顾虑切入：成年手部准备切菜，菜板在浅木台面上稳定放置，木纹清楚，不做夸张砍剁或危险画面。"
    },
    {
      role: "detail",
      index: 3,
      title: "卖点证明",
      aspectRatio: "9:16",
      copy: plan.detail[2],
      taskPrompt: "制作竖版详情页高硬度证明屏。成年手部在同一块菜板上切胡萝卜、黄瓜或熟食食材，刀具无品牌，动作真实；用近景和局部放大展示菜板表面稳定感，不新增硬度数值或检测数据。"
    },
    {
      role: "detail",
      index: 4,
      title: "场景代入",
      aspectRatio: "9:16",
      copy: plan.detail[3],
      taskPrompt: "制作竖版详情页厨房做饭场景。拉开镜头展示家庭厨房台面，菜板、蔬果、刀具和成年人手部准备做饭同框；商品完整清楚，场景真实温暖，不让食材或人物抢主体。"
    },
    {
      role: "detail",
      index: 5,
      title: "细节信任",
      aspectRatio: "9:16",
      copy: plan.detail[4],
      taskPrompt: "制作竖版详情页木纹细节屏。超近景展示乌檀木纹、边角切面、厚度和表面质感，可用局部放大圈和细线；另一角度整板作为背景层次，文字避开木纹关键区域。"
    },
    {
      role: "detail",
      index: 6,
      title: "多角度证明",
      aspectRatio: "9:16",
      copy: plan.detail[5],
      taskPrompt: "制作竖版详情页多角度证明屏。用画册式分区展示菜板正面、侧边厚度、边角、木纹微距和厨房台面摆放；可出现“抗菌率99.9%”作为需求给出的卖点，但不得出现检测机构、认证编号或更多数据。"
    },
    {
      role: "detail",
      index: 7,
      title: "决策理由",
      aspectRatio: "9:16",
      copy: plan.detail[6],
      taskPrompt: "制作竖版详情页冲洗收纳屏。同一块菜板在干净水槽盆上方或盆内被清水冲洗，水龙头必须位于水槽后沿/台面内侧，出水口朝向水槽盆内，绝不能画成水龙头在水槽外面或从台面外侧伸出；菜板正面切菜面朝上或略微倾斜接水，水流从菜板表面带走水珠并流入水槽盆内。也可在画面右侧展示冲洗后立放/挂放在厨房收纳区；水流、木纹和边角清楚，表达日常用完一冲更省心。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: plan.detail[7],
      taskPrompt: "制作竖版详情页收尾屏。菜板在暖白厨房台面或挂放收纳区形成大留白品牌画面，旁边少量蔬果和无品牌厨具；构图比首屏更远更安静，形成高级厨具收尾。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, `详情页${screen.title}`, screen.index)
  }));
}

function buildTissueDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const shared = visualSystemToPrompt(visualSystem);
  const plan = buildTissueCopyPlan(task, points);
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string }> = [
    {
      role: "detail",
      index: 1,
      title: "核心主张",
      aspectRatio: "9:16",
      copy: plan.detail[0],
      taskPrompt: "制作竖版详情页首屏。不要把产品名称当主标题。用大幅同一盒织梦牌抽取式面巾纸英雄画面建立第一印象，白色盒身、蓝白牡丹花纹、织梦标识、顶部抽出的白色压纹纸张和包装原有中文信息必须清楚；标题先建立原生木浆与柔软安心的核心主张，不堆参数，不做促销海报。"
    },
    {
      role: "detail",
      index: 2,
      title: "家用放心",
      aspectRatio: "9:16",
      copy: plan.detail[1],
      taskPrompt: "制作竖版详情页顾虑回应屏。画面从家庭用纸每天接触餐桌、手部和杯口的真实顾虑切入：同一盒抽纸放在浅木餐桌上，成年女性手部抽取纸巾准备擦拭杯口或餐盘边缘；商品包装清楚，蓝白花纹和织梦标识不能被遮挡。只表达抽取无异味和日常接触安心，不写食品级、抗菌、检测认证或医学承诺。"
    },
    {
      role: "detail",
      index: 3,
      title: "柔软证明",
      aspectRatio: "9:16",
      copy: plan.detail[2],
      taskPrompt: "制作竖版详情页柔软触感证明屏。成年手部轻捏或展开一张从同一盒中抽出的纸巾，纸面压纹、柔软折痕和厚薄层次可见；旁边保留完整抽纸盒小视角。可用局部放大圈和细线增强设计感，但不新增未指定文字。"
    },
    {
      role: "detail",
      index: 4,
      title: "随手取用",
      aspectRatio: "9:16",
      copy: plan.detail[3],
      taskPrompt: "制作竖版详情页随手取用屏。拉开镜头展示温暖客厅茶几或餐桌，同一盒抽纸在前景，成年女性或家庭用户手部正在抽纸擦手、擦桌面水渍或整理餐桌；空间与第2屏不同，商品完整清楚，不出现“使用场景”等低级文案。"
    },
    {
      role: "detail",
      index: 5,
      title: "细节信任",
      aspectRatio: "9:16",
      copy: plan.detail[4],
      taskPrompt: "制作竖版详情页细节信任屏。超近景展示白色纸巾压纹、抽取口、包装蓝白牡丹花纹、织梦标识、产品名称/规格等包装原有中文信息；一主两辅构图，可用局部放大圈，绝不能把包装文字改成乱码、英文或其他品牌。"
    },
    {
      role: "detail",
      index: 6,
      title: "抽取方便",
      aspectRatio: "9:16",
      copy: plan.detail[5],
      taskPrompt: "制作竖版详情页抽取式结构屏。用俯拍、侧拍、手部抽取和桌面摆放四个分区展示同一盒抽纸，表现一张一张顺手拿、桌面不凌乱；只表达抽取便利，不做参数表，不新增未提供的层数/张数以外卖点。"
    },
    {
      role: "detail",
      index: 7,
      title: "家庭省心",
      aspectRatio: "9:16",
      copy: plan.detail[6],
      taskPrompt: "制作竖版详情页家庭决策理由屏。画面展示家庭主妇或成年女性在厨房台面/餐桌旁用纸巾擦手、擦桌面或整理小水渍，同一盒抽纸在前景清楚；动作真实克制，不做夸张脏污对比，不写强力去油、抗菌或除菌。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: plan.detail[7],
      taskPrompt: "制作竖版详情页品牌收尾屏。回到干净客厅茶几或餐桌的产品英雄画面，同一盒织梦抽纸作为中心主体，蓝白花纹、织梦标识、抽出纸张和包装中文信息清楚；构图比第1屏更远、更留白，形成完整系列结束感，不做促销收口。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, `详情页${screen.title}`, screen.index)
  }));
}

function buildMagneticLifterDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const shared = visualSystemToPrompt(visualSystem);
  const plan = buildMagneticLifterCopyPlan(task, points);
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string }> = [
    {
      role: "detail",
      index: 1,
      title: "核心主张",
      aspectRatio: "9:16",
      copy: plan.detail[0],
      taskPrompt: "制作竖版详情页首屏。不要把页面做成普通参数表；用大幅黄色永磁起重机英雄图建立工业设备可信感，银色 U 型吊环、长操作手柄、黄色机身、铭牌/参数标签和底部磁吸面清楚。背景为深灰钢材或户外钢材堆场，商品是第一视觉主体。"
    },
    {
      role: "detail",
      index: 2,
      title: "用户顾虑",
      aspectRatio: "9:16",
      copy: plan.detail[1],
      taskPrompt: "制作竖版详情页顾虑回应屏。画面从起重搬运最怕不稳的真实顾虑切入：黄色永磁起重机吸附在厚钢板上，吊环连接无品牌吊钩，钢板低高度离地；可出现佩戴安全帽手套的成年工人在侧后方观察，但绝不能站在悬吊钢板下方。"
    },
    {
      role: "detail",
      index: 3,
      title: "卖点证明",
      aspectRatio: "9:16",
      copy: plan.detail[2],
      taskPrompt: "制作竖版详情页吸力证明屏。近景展示同一台永磁起重机磁吸底面与钢板牢固接触，钢板被低高度吊起，吊链受力方向清楚；可用局部放大圈展示磁吸接触面和钢板厚度。不新增具体吨位、检测数据、认证编号或绝对安全承诺。"
    },
    {
      role: "detail",
      index: 4,
      title: "场景代入",
      aspectRatio: "9:16",
      copy: plan.detail[3],
      taskPrompt: "制作竖版详情页户外起重场景。拉开镜头展示户外钢材堆场/工地起重区，同一台黄色永磁起重机在钢板、H 型钢或钢管搬运中使用；空间有水泥地、钢材堆、安全围栏和自然光，不能出现电源线或电控箱。商品完整清楚，场景专业不杂乱。"
    },
    {
      role: "detail",
      index: 5,
      title: "细节信任",
      aspectRatio: "9:16",
      copy: plan.detail[4],
      taskPrompt: "制作竖版详情页结构细节屏。超近景展示银色 U 型吊环、长操作手柄、侧面圆柱轴、黑色顶盖螺丝、机身铭牌/参数标签和警示图标，可用局部放大圈和细线标注；另一角度完整设备作为背景层次。不得把机身标签改成乱码或随机英文。"
    },
    {
      role: "detail",
      index: 6,
      title: "多角度证明",
      aspectRatio: "9:16",
      copy: plan.detail[5],
      taskPrompt: "制作竖版详情页规格参数展示屏。用专业工业参数版式展示 200KG/400KG 两种参考规格的设备外观、长宽高示意、适用钢板厚度/长度提示；参数只能来自本地参考图中可见信息：200KG、400KG、10-30MM、20-40MM、600MM、800MM、长160MM、宽63MM、高75MM、净重4KG、毛重4.2KG 等，不能新增其它规格或认证。"
    },
    {
      role: "detail",
      index: 7,
      title: "决策理由",
      aspectRatio: "9:16",
      copy: plan.detail[6],
      taskPrompt: "制作竖版详情页无需用电场景屏。同一台黄色永磁起重机在户外钢材场或无电源车间角落使用，画面明确没有电源线、电池包、电控箱；工人手部操作长手柄或准备吊装钢板，表达无电源场地也能用。动作规范，不出现危险高空或人员站在钢材下方。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: plan.detail[7],
      taskPrompt: "制作竖版详情页工业品牌收尾屏。同一台黄色永磁起重机放在整齐钢材仓储区或深灰工业台面上，旁边少量无品牌吊链、钢板、安全帽/手套；构图比首屏更远更安静，留白充足，形成专业 B2B 工业设备收尾，不做促销收口。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, `详情页${screen.title}`, screen.index)
  }));
}

function buildIntimateApparelDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const shared = visualSystemToPrompt(visualSystem);
  const productName = productDisplayName(task, "精选商品");
  const primaryPoint = points[0] || "优雅红色更有记忆点";
  const materialPoint = points.find((point) => /棉|材质|面料/.test(point)) || points[1] || "棉感材质看得见";
  const comfortPoint = points.find((point) => /轻松|舒适|不紧/.test(point)) || points[2] || "轻松贴身不紧绷";
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string }> = [
    {
      role: "detail",
      index: 1,
      title: "产品首屏",
      aspectRatio: "9:16",
      copy: [primaryPoint, "成熟女性内衣", "一眼看清款式"],
      taskPrompt: "制作竖版详情页首屏。不要出现产品名称“成人红色胸罩”。红色胸罩作为大幅英雄图，必须真实平铺在柔软浅色织物上，或自然垂挂在无品牌衣架上；罩杯、肩带、下围和棉感纹理清楚。标题先建立成熟、优雅、日常可穿的核心主张，不出现虚构 Logo，不把胸罩竖立在柜面或抽屉边缘。"
    },
    {
      role: "detail",
      index: 2,
      title: "用户顾虑",
      aspectRatio: "9:16",
      copy: ["好看也要轻松", "上身自然不紧绷", "日常穿着更自在"],
      taskPrompt: "制作竖版详情页痛点/顾虑屏。用衣帽间或晨间换衣场景表达成熟女性对内衣既要好看也要轻松的需求；必须出现专业躯干模特或成年女性克制上身局部，证明实穿轮廓，不做挑逗姿态。"
    },
    {
      role: "detail",
      index: 3,
      title: "棉感材质",
      aspectRatio: "9:16",
      copy: [materialPoint, "近看纹理清楚", "贴身面料细节"],
      taskPrompt: "制作竖版详情页材质证明屏。以罩杯或下围面料超近景为主，展示细密纹理、柔和光泽和红色棉感；可搭配一件平铺或衣架垂挂的完整商品小图。不要写成分比例、检测数据或认证。禁止让胸罩竖立或悬空。"
    },
    {
      role: "detail",
      index: 4,
      title: "杯型轮廓",
      aspectRatio: "9:16",
      copy: ["上身轮廓直观", "杯型线条清楚", "贴合状态看得见"],
      taskPrompt: "制作竖版详情页版型证明屏。用正面平铺、专业躯干模特或成年女性克制上身局部展示罩杯自然弧度和整体轮廓；画面克制高级，重点是商品版型，不突出身体。"
    },
    {
      role: "detail",
      index: 5,
      title: "肩带下围",
      aspectRatio: "9:16",
      copy: ["肩带下围细节", "调节扣看得清", "车线边缘清楚"],
      taskPrompt: "制作竖版详情页结构细节屏。一主两辅局部特写展示肩带、调节扣、下围车线和边缘收口；只基于商品图可见结构，不虚构无钢圈、聚拢、无痕。"
    },
    {
      role: "detail",
      index: 6,
      title: "日常内搭",
      aspectRatio: "9:16",
      copy: ["日常内搭", "搭配衬衫也自然", "穿前准备更从容"],
      taskPrompt: "制作竖版详情页场景代入屏。红色胸罩必须自然挂在无品牌衣架上，或平放在打开的浅色衣橱抽屉内；旁边搭配无品牌白衬衫、针织衫或丝巾作为内搭联想。商品完整清楚，不出现低俗穿着画面，不把胸罩竖在台面上。"
    },
    {
      role: "detail",
      index: 7,
      title: "衣橱场景",
      aspectRatio: "9:16",
      copy: ["衣橱收纳", "穿前一眼好搭", "日常搭配更从容"],
      taskPrompt: "制作竖版详情页真实衣橱场景屏。打开的浅色衣柜或抽屉中，红色胸罩与叠放整齐的白衬衫、浅色针织、丝巾自然同框；胸罩只能平放在抽屉内或自然挂在衣架上，符合真实收纳和拍摄逻辑。不要写选择建议、尺码建议或参数，不编尺码表。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: [primaryPoint, "日常也轻松", "成熟女性内衣"],
      taskPrompt: "制作竖版详情页品牌收尾屏。回到暖白影棚或衣帽间的商品英雄画面，红色胸罩干净醒目，必须平铺在柔软织物上或自然垂挂在无品牌衣架上；留白充足，有成熟品牌结束感，不做促销收口，不出现不合理竖立摆放。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, `详情页${screen.title}`)
  }));
}

function buildKitchenTextileDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const shared = visualSystemToPrompt(visualSystem);
  const productName = productDisplayName(task, "精选商品");
  const cleanPoint = pickConcretePoint(points, /轻轻一擦就干净/, /擦|干净|水渍|清洁/, "轻轻一擦就干净");
  const washPoint = points.find((point) => /洗|冲/.test(point)) || "一冲一洗更省心";
  const colorPoint = points.find((point) => /多色|颜色|区分/.test(point)) || "多色可选好区分";
  const texturePoint = points.find((point) => /绒|纹理|细密|柔软|吸水/.test(point)) || "细密绒感看得见";
  const specHint = firstUsefulSpec(specs, "按厨房不同用途分开使用");
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string }> = [
    {
      role: "detail",
      index: 1,
      title: "产品首屏",
      aspectRatio: "9:16",
      copy: [productName, cleanPoint, "厨房日常随手用"],
      taskPrompt: "制作竖版详情页首屏。大幅呈现同一组多色厨房毛巾在明亮厨房台面或水槽旁的英雄画面，毛巾叠放层次、颜色和绒毛质感清楚。标题建立“厨房日常随手清洁”的核心主张，不做促销海报，不出现虚构 Logo。"
    },
    {
      role: "detail",
      index: 2,
      title: "用户顾虑",
      aspectRatio: "9:16",
      copy: ["厨房小污渍", "每天都要擦", "顺手才省心"],
      taskPrompt: "制作竖版详情页痛点/顾虑屏。画面用家庭主妇或家人做饭后整理台面的真实视角：台面有少量水渍、汤汁或面粉痕迹，一条毛巾准备擦拭。情绪真实干净，不把厨房拍得过脏，不做恐吓式对比。"
    },
    {
      role: "detail",
      index: 3,
      title: "擦拭证明",
      aspectRatio: "9:16",
      copy: [cleanPoint, "台面水渍随手擦", "擦完更清爽"],
      taskPrompt: "制作竖版详情页核心功能证据屏。用近景展示毛巾擦过厨房台面水渍的动作，画面里要有手部、毛巾、台面水痕和擦拭后清爽区域。不要写去污率、强力去油、抗菌等未提供功效。"
    },
    {
      role: "detail",
      index: 4,
      title: "好洗证明",
      aspectRatio: "9:16",
      copy: [washPoint, "水槽一冲更清爽", "日常清洗不费劲"],
      taskPrompt: "制作竖版详情页好洗证明屏。一条厨房毛巾在白色水槽中被轻轻冲洗或展开清洗，水流透明，旁边挂放其他颜色毛巾作为同组商品证据。画面表达日常清洗省心，不做夸张实验，不写速干或检测数据。"
    },
    {
      role: "detail",
      index: 5,
      title: "绒感细节",
      aspectRatio: "9:16",
      copy: [texturePoint, "靠近看也清楚", "柔软厚实有质感"],
      taskPrompt: "制作竖版详情页材质细节屏。以毛巾表面细密绒感、边缘布边、叠放厚度为主，配一个完整多色叠放小视角；用细线标注真实可见细节，不虚构纯棉、超细纤维、克重或认证。"
    },
    {
      role: "detail",
      index: 6,
      title: "多色分区",
      aspectRatio: "9:16",
      copy: [colorPoint, "擦手擦台分开用", "家务流程更清楚"],
      taskPrompt: "制作竖版详情页多色分区屏。多条不同颜色毛巾分别挂在厨房挂杆、台面或抽屉收纳中，用颜色建立擦手、擦台、擦碗等用途分区联想。画面秩序清楚，不能像杂乱彩虹布堆。"
    },
    {
      role: "detail",
      index: 7,
      title: "厨房收纳",
      aspectRatio: "9:16",
      copy: ["挂放收纳", "伸手就能拿", specHint],
      taskPrompt: "制作竖版详情页收纳/使用建议屏。同一组多色厨房毛巾自然挂放在无品牌挂杆、收纳篮或浅木抽屉中，旁边是干净水槽、碗盘或台面；强调伸手就能拿的日常动线，不写复杂参数表。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: ["干净厨房", "从一条毛巾开始", productName],
      taskPrompt: "制作竖版详情页品牌收尾屏。回到明亮干净的厨房台面，多色毛巾整齐叠放或挂放，水槽和浅木台面形成清爽生活感；留白充足，有完整系列结束感，不做促销收口。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, `详情页${screen.title}`)
  }));
}

function buildSkincareDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const shared = visualSystemToPrompt(visualSystem);
  const productName = productDisplayName(task, "精选商品");
  const gentlePoint = pickConcretePoint(points, /^温和不刺激$/, /温和|刺激|负担|舒缓/, "温和不刺激");
  const moisturePoint = pickConcretePoint(points, /水润保湿感/, /保湿|水润|补水|滋润/, "水润保湿感");
  const texturePoint = points.find((point) => /质地|膏体|肤感/.test(point)) || "水润质地看得见";
  const modelPoint = points.find((point) => /真人|上脸|模特|透亮|状态/.test(point)) || "真人上脸更直观";
  const premiumPoint = points.find((point) => /高端|品质|黑银|包装/.test(point)) || "黑银高级瓶身";
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string }> = [
    {
      role: "detail",
      index: 1,
      title: "产品首屏",
      aspectRatio: "9:16",
      copy: [productName, moisturePoint, "高端护肤质感"],
      taskPrompt: "制作竖版详情页首屏。大幅呈现同一款黑色圆罐保湿霜，黑色罐身、镜面银盖、圆柱比例、瓶身原有文字/图案和高端反射清楚；珍珠白+黑银+香槟金视觉系统。标题建立高端保湿核心主张，不复制外部参考图英文品牌商标，不在背景或装饰上新增随机英文或虚构 Logo。"
    },
    {
      role: "detail",
      index: 2,
      title: "用户顾虑",
      aspectRatio: "9:16",
      copy: ["换季干燥", "护肤更想温和", "上脸不想有负担"],
      taskPrompt: "制作竖版详情页痛点/顾虑屏。用同一名成年女性模特露脸或侧脸，面对镜子轻触脸颊，表达干燥季节想要温和保湿的需求；画面高级克制，不表现红肿、过敏、疾病或医美术后效果。"
    },
    {
      role: "detail",
      index: 3,
      title: "温和保湿",
      aspectRatio: "9:16",
      copy: [gentlePoint, moisturePoint, "日常护肤少负担"],
      taskPrompt: "制作竖版详情页核心卖点证明屏。成年女性模特手指将少量保湿霜轻抹在脸颊或手背，产品罐身在前景清楚可见；用水光和柔和肌理表达保湿感。不能写敏感肌适用、抗敏、医用、屏障修护、测试数据或时长。"
    },
    {
      role: "detail",
      index: 4,
      title: "质地细节",
      aspectRatio: "9:16",
      copy: [texturePoint, "细腻膏体", "轻抹有水润感"],
      taskPrompt: "制作竖版详情页膏体质地屏。打开黑色保湿霜罐，展示浅色细腻膏体、抹刀挑起一小抹或手背轻抹的质地拖痕；一主两辅构图，可用局部放大圈和水滴图形。不要写成分、浓度、功效数据。"
    },
    {
      role: "detail",
      index: 5,
      title: "真人上脸",
      aspectRatio: "9:16",
      copy: [modelPoint, "自然透亮好状态", "可以露脸更真实"],
      taskPrompt: "制作竖版详情页真人上脸屏。同一名成年女性模特正脸或 3/4 侧脸，皮肤真实干净，表情自然高级；模特手持产品或正在轻拍脸颊，产品必须清楚同框。不要夸张磨皮，不做医美前后对比。"
    },
    {
      role: "detail",
      index: 6,
      title: "包装品质",
      aspectRatio: "9:16",
      copy: [premiumPoint, "镜面银盖", "摆在梳妆台也高级"],
      taskPrompt: "制作竖版详情页包装品质屏。超近景展示黑色光泽罐身、镜面银盖、罐口厚度、瓶身原有文字/图案和高端反射，旁边放完整产品；可用香槟金细线和无文字图形增强设计感。不复制外部参考商标，不在背景或装饰上生成随机英文。"
    },
    {
      role: "detail",
      index: 7,
      title: "早晚护肤",
      aspectRatio: "9:16",
      copy: ["早晚护肤", "一抹水润", "日常保湿更从容"],
      taskPrompt: "制作竖版详情页日常场景屏。珍珠白梳妆台或浴室柜前，同一名成年女性模特进行早晚护肤动作，保湿霜罐放在手边清楚可见；旁边可有无品牌化妆棉、镜子、清水杯或浅色丝缎。画面生活化但保持高端，不做复杂步骤教学。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: ["水润好状态", "从日常保湿开始", productName],
      taskPrompt: "制作竖版详情页品牌收尾屏。回到黑色保湿霜罐的高端英雄画面，珍珠白背景、镜面台面、香槟金线条和柔和水光形成完整系列结束感；商品醒目，瓶身原有文字/图案清楚，留白充足，不做促销收口，不新增英文商标。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, `详情页${screen.title}`)
  }));
}

function buildChildCupDetailSpecs(
  task: ProductTask,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  void specs;
  const shared = visualSystemToPrompt(visualSystem);
  const productName = productDisplayName(task, "精选商品");
  const plan = buildChildCupCopyPlan(task, points);
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string; roleLabel?: string; screenIndex: number }> = [
    {
      role: "detail",
      index: 1,
      title: "产品首屏",
      aspectRatio: "9:16",
      copy: plan.detail[0],
      screenIndex: 1,
      roleLabel: "详情页首屏",
      taskPrompt: "制作竖版详情页首屏。不要把产品名称当主标题。用大幅儿童保温杯英雄画面建立第一印象，黄色杯盖、蓝色双把手、米色杯身、杯身卡通图案、JUMP 与 THERMOS 商品本体文字必须清楚；背景为明亮书桌或早餐餐桌。标题先建立“让孩子爱上喝水”的核心主张，不堆参数，不写虚构 Logo。"
    },
    {
      role: "detail",
      index: 2,
      title: "妈妈顾虑",
      aspectRatio: "9:16",
      copy: plan.detail[1],
      screenIndex: 2,
      roleLabel: "详情页用户顾虑",
      taskPrompt: "制作竖版详情页顾虑回应屏。画面用妈妈/家长视角表达给 8-10 岁短黑发男孩选喝水杯时在意耐热、材质和日常放心感：早餐餐桌或厨房桌面上，成人手部拿起同一只儿童保温杯，孩子在旁等待或看向杯子；如果杯子靠近嘴边，黄色杯盖必须翻开并露出杯口/吸饮口。情绪真实克制，不制造危险热水场景，不夸大安全承诺。"
    },
    {
      role: "detail",
      index: 3,
      title: "耐热证明",
      aspectRatio: "9:16",
      copy: plan.detail[2],
      screenIndex: 3,
      roleLabel: "详情页卖点证明",
      taskPrompt: "制作竖版详情页耐热饮用证明屏。以杯盖、杯口和打开动作超近景为主，成人手部正在打开杯盖或倒入温水；配一个完整水杯小视角，杯身卡通图案和原有文字仍可识别。只表达耐热饮用更安心，不写具体温度、保温时长、材质等级或认证。"
    },
    {
      role: "detail",
      index: 4,
      title: "家庭场景",
      aspectRatio: "9:16",
      copy: plan.detail[3],
      screenIndex: 4,
      roleLabel: "详情页场景代入",
      taskPrompt: "制作竖版详情页家庭场景屏。同一名 8-10 岁短黑发男孩在明亮餐桌或书桌旁自然拿杯喝水/放杯，允许露出自然正脸，人物一致；如果正在喝水，黄色杯盖必须翻开，杯口/吸饮口必须露出，孩子嘴巴只能靠近打开的杯口，禁止对着关闭杯盖喝水。商品在前景清楚，蓝色双把手和黄色杯盖可见。画面要和第2屏家长手部顾虑场景不同，空间、角度、动作都要变化。"
    },
    {
      role: "detail",
      index: 5,
      title: "杯盖把手",
      aspectRatio: "9:16",
      copy: plan.detail[4],
      screenIndex: 5,
      roleLabel: "详情页细节信任",
      taskPrompt: "制作竖版详情页细节信任屏。一主两辅局部特写展示黄色杯盖、蓝色双把手、杯口边缘、米色杯身卡通图案以及 JUMP 与 THERMOS 商品本体文字；用局部放大圈和细线增强设计感。文字不要遮挡杯身原有文字，不得把商品文字改成乱码或其他英文。"
    },
    {
      role: "detail",
      index: 6,
      title: "材质结构",
      aspectRatio: "9:16",
      copy: plan.detail[5],
      screenIndex: 6,
      roleLabel: "详情页多角度证明",
      taskPrompt: "制作竖版详情页多角度证明屏。用俯拍、侧拍、杯盖开启、双把手握持四个分区展示同一只儿童保温杯，形成品牌画册式信息版。只表达环保材质更放心和结构看得清，不做参数表，不新增未提供的材质等级、认证或检测数据。"
    },
    {
      role: "detail",
      index: 7,
      title: "上学携带",
      aspectRatio: "9:16",
      copy: plan.detail[6],
      screenIndex: 7,
      roleLabel: "详情页决策理由",
      taskPrompt: "制作竖版详情页上学携带场景屏。不要写选择建议、尺码建议或参数。画面展示同一只儿童保温杯放在无品牌书包侧袋、课桌或学习区旁，8-10 岁儿童伸手取放，表现家里学校都适合；商品完整清楚，背景和第4屏家庭餐桌场景不同。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: plan.detail[7],
      screenIndex: 8,
      roleLabel: "详情页系列收尾",
      taskPrompt: "制作竖版详情页品牌收尾屏。回到干净书桌或早餐桌的生活英雄画面，同一只儿童保温杯作为中心主体，黄色杯盖、蓝色双把手、米色杯身、卡通图案和原有商品文字清楚；构图更远、更留白，区别第1屏大商品近景，有完整系列结束感，不做促销收口。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, screen.roleLabel ?? `详情页${screen.title}`, screen.screenIndex)
  }));
}

function buildChildTemperatureCupDetailSpecs(
  task: ProductTask,
  brand: BrandProfile,
  visualSystem: VisualSystem,
  points: string[],
  specs: string[]
): NativeImageSpec[] {
  const shared = visualSystemToPrompt(visualSystem);
  const productName = productDisplayName(task, "精选商品");
  const primaryPoint = points[0] || "温度显示更直观";
  const secondaryPoint = points[1] || "喝前看一眼水温";
  const schoolPoint = points.find((point) => /上学|课桌|书包/.test(point)) || "课桌书包都适合";
  const detailPoint = points.find((point) => /图案|识别|细节/.test(point)) || "杯身细节清晰";
  const carryPoint = points.find((point) => /握持|携带|日常/.test(point)) || "日常饮水更方便";
  const specHint = firstUsefulSpec(specs, "按孩子日常饮水需求选择");
  const screens: Array<Omit<NativeImageSpec, "prompt"> & { taskPrompt: string }> = [
    {
      role: "detail",
      index: 1,
      title: "产品首屏",
      aspectRatio: "9:16",
      copy: [productName, "喝水前", "先看一眼水温"],
      taskPrompt: "制作竖版详情页首屏。用大幅商品英雄图建立第一印象，水杯完整清楚，杯盖/温显区域和杯身图案可见；背景为明亮书桌或上学前餐桌。标题要像成熟天猫详情页开场，先给核心主张，不要堆参数。"
    },
    {
      role: "detail",
      index: 2,
      title: "用户痛点",
      aspectRatio: "9:16",
      copy: ["孩子喝水", "水温看不清？", "喝前看一眼更直观"],
      taskPrompt: "制作竖版详情页痛点屏。画面用家长视角表达水温不直观的日常顾虑：书桌边的水杯、孩子准备喝水的动作、温显区域成为视觉焦点。情绪真实克制，不制造危险场景，不夸张恐吓。"
    },
    {
      role: "detail",
      index: 3,
      title: "温显证明",
      aspectRatio: "9:16",
      copy: [primaryPoint, secondaryPoint, "屏幕区域清楚可见"],
      taskPrompt: "制作竖版详情页核心功能证明屏。以杯盖/温显屏幕超近景为主，配一个完整水杯小视角；可以用细线局部放大和操作手势证明“看水温”动作。不要写具体温度数字、保温时长或测试数据。"
    },
    {
      role: "detail",
      index: 4,
      title: "上学场景",
      aspectRatio: "9:16",
      copy: ["上学日常", "带着走", schoolPoint],
      taskPrompt: "制作竖版详情页场景代入屏。水杯放在无品牌书包侧袋、课桌或作业本旁，10-15 岁学生自然出现但商品是主体；可露出儿童正脸或侧脸，人物一致、干净自然，不要幼龄化。"
    },
    {
      role: "detail",
      index: 5,
      title: "杯身细节",
      aspectRatio: "9:16",
      copy: [detailPoint, "靠近看也清楚", "孩子自己也好识别"],
      taskPrompt: "制作竖版详情页细节信任屏。展示杯身图案、杯盖、屏幕、杯身轮廓等关键识别点；画面像品牌画册内页，使用一主两辅局部特写，不虚构材质名称和认证。"
    },
    {
      role: "detail",
      index: 6,
      title: "携带收纳",
      aspectRatio: "9:16",
      copy: [carryPoint, "书桌书包都适合", "日常饮水更省心"],
      taskPrompt: "制作竖版详情页使用/收纳屏。场景从家里书桌过渡到书包旁，证明日常放置、取用、携带的关系；水杯完整可见，空间干净，不能用过多道具填满。"
    },
    {
      role: "detail",
      index: 7,
      title: "选择建议",
      aspectRatio: "9:16",
      copy: ["选择建议", specHint, "按实际需求选择合适规格"],
      taskPrompt: "制作竖版详情页规格/选择建议屏。用信息清楚的电商参数区和水杯稳定产品图呈现，不出现虚构容量、材质、保温时长、认证；若没有具体参数，只给温和选择建议。"
    },
    {
      role: "detail",
      index: 8,
      title: "系列收尾",
      aspectRatio: "9:16",
      copy: ["每天喝水", "看得见更安心", productName],
      taskPrompt: "制作竖版详情页品牌收尾屏。回到明亮干净的书桌/上学前场景，同一只水杯作为中心英雄画面；整体温暖可信，有结束感，不做促销收口。"
    }
  ];
  return screens.map((screen) => ({
    role: screen.role,
    index: screen.index,
    title: screen.title,
    aspectRatio: screen.aspectRatio,
    copy: screen.copy,
    prompt: composeDetailScreenPrompt(shared, screen.taskPrompt, screen.copy, `详情页${screen.title}`)
  }));
}

function exactCopyInstruction(copy: string[]): string {
  const cleanCopy = copy.map((line) => line.trim()).filter(Boolean);
  if (isEnglishCopySet(cleanCopy)) {
    return `Visible marketing copy may only use the following exact English text: ${cleanCopy.map((line) => `"${line}"`).join(", ")}. The specified text may be used as headline, subhead, support label, or a small callout, but every word must remain exact: do not add, delete, rewrite, translate, split words, or generate synonyms. Use one clean modern sans-serif family only; hierarchy may differ by size, weight, color, spacing, and layout. Keep any original product/packaging/label/logo text already visible on the uploaded product image unchanged; those original product markings do not count as new marketing copy. Do not add any unspecified Chinese, extra English, numbers, pinyin, tiny legend text, parameter tables, fake review text, rating stars, Best Seller badges, price, sales volume, watermarks, QR codes, or unrelated symbols. If callouts are needed, use wordless thin lines, arrows, dots, simple icons, color blocks, or magnifier circles.`;
  }
  return `营销文案只允许出现以下指定文字：${cleanCopy.map((line) => `「${line}」`).join("、")}。指定文字可以作为主标题、副标题、辅助标签或细线信息条进行版式化处理，但必须逐字准确，不得增删、改写、拆字造词或生成同义词。所有新增营销文案必须只使用同一种中文字体家族，标题、副标题、标签和小字只能用字号、字重、颜色和排版区分层级，不得混用宋体、黑体、手写体、卡通字、花体字或随机英文。商品本体在本地商品图中原本就有的品牌字样、型号、标签、包装文字、瓶身/杯身/鞋身/吊牌文字、图案和标识必须按原样保留，它们不计入新增营销文案。除此之外，不得出现任何未指定的中文、英文、数字、拼音、图例小字、用途列表、参数表、标注标签、角标、水印或无关符号；尤其不得出现“使用场景”“场景代入”“核心主张”“用户顾虑”“转化目标”“案例学习”“页面模块”“真实日常”“自然融入日常”“真实使用更有代入感”“卧室睡眠场景”“户外运动场景”“洗衣场景”或任何“XX场景”类可见文字。如需标注只能使用无文字细线、圆点、箭头、色块、ICON 或局部放大圈。`;
}

function isEnglishCopySet(lines: string[]): boolean {
  return isMostlyEnglishText(lines.join(" "));
}

function isMostlyEnglishText(value: string): boolean {
  const text = String(value || "");
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return latinCount >= 4 && latinCount > cjkCount * 2;
}

async function retry(maxAttempts: number, action: () => Promise<void>): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await action();
      return attempt;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function failure(role: "main" | "detail", index: number, title: string, error: unknown, attempts: number): AssetFailure {
  return { role, index, title, error: error instanceof Error ? error.message : String(error), attempts };
}

function splitList(value: string): string[] {
  return value.split(/[，,、;；\n]/).map((item) => item.trim()).filter(Boolean);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
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

async function clearNativeGeneratedOutputs(outputDir: string, mainDir: string, detailDir: string): Promise<void> {
  await Promise.all([
    clearImageFiles(mainDir),
    clearImageFiles(detailDir),
    ...[
      "5张主图总览.jpg",
      "8张详情页总览.jpg",
      "详情页完整长图.jpg",
      "prompts.json",
      "prompt-audit.json",
      "generation-audit.json",
      "output-visual-audit.json",
      "design-review.json",
      "report.json",
      "analysis.json",
      "package.zip"
    ].map((file) => unlinkIfExists(path.join(outputDir, file)))
  ]);
}

async function clearImageFiles(dirPath: string): Promise<void> {
  let files: string[];
  try {
    files = await fs.readdir(dirPath);
  } catch {
    return;
  }
  await Promise.all(
    files
      .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
      .map((file) => unlinkIfExists(path.join(dirPath, file)))
  );
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function moveInvalidNativeAsset(
  outputPath: string,
  invalidDir: string,
  spec: NativeImageSpec,
  attempt: number
): Promise<void> {
  try {
    await fs.access(outputPath);
  } catch {
    return;
  }

  await ensureDir(invalidDir);
  const ext = path.extname(outputPath) || ".png";
  const target = path.join(
    invalidDir,
    `${spec.role}-${pad(spec.index)}-${safeSegment(spec.title)}-attempt-${attempt}${ext}`
  );
  try {
    await fs.rename(outputPath, target);
  } catch {
    await fs.copyFile(outputPath, target);
    await unlinkIfExists(outputPath);
  }
}

async function hashesFor(assets: GeneratedAsset[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(assets.map(async (asset) => [
    `${asset.role}-${pad(asset.index)}`,
    await sha256File(asset.path)
  ])));
}

function sortAssets(assets: GeneratedAsset[]): void {
  assets.sort((a, b) => a.index - b.index);
}

function nativeSpecKey(role: "main" | "detail", index: number): string {
  return `${role}-${index}`;
}

function buildNativePromptRecord(spec: NativeImageSpec, outputPath: string): NativePromptRecord {
  return {
    role: spec.role,
    index: spec.index,
    title: spec.title,
    aspectRatio: spec.aspectRatio,
    copy: spec.copy,
    prompt: spec.prompt,
    auditSummary: spec.auditSummary,
    creativeFrame: spec.creativeFrame,
    path: outputPath,
    status: "planned"
  };
}

function sortNativePromptRecords(records: NativePromptRecord[]): NativePromptRecord[] {
  return [...records].sort((a, b) => {
    const roleDiff = (a.role === "main" ? 0 : 1) - (b.role === "main" ? 0 : 1);
    return roleDiff || a.index - b.index;
  });
}

function buildDesignReviewReport(
  task: ProductTask,
  brand: BrandProfile,
  analysis: ReferenceAnalysis,
  assets: GeneratedAsset[],
  failures: AssetFailure[],
  sellingPointCoverage: SellingPointCoverage[] = []
): DesignReviewReport {
  const generatedAt = new Date().toISOString();
  const brandVisualLogic = (analysis.brandVisualLogic?.length ? analysis.brandVisualLogic : [
    "全案统一色彩、光线、字体层级和图形语言。",
    "主图先保证商品、品类和第一卖点清楚，再追求氛围。",
    "详情页按销售动线组织，每屏只证明一个购买理由。"
  ]);
  const designReviewRules = (analysis.designReviewRules?.length ? analysis.designReviewRules : [
    "审核首图商品是否为第一视觉主体。",
    "审核套图是否统一视觉系统。",
    "审核每屏是否有明确转化目标和画面证据。",
    "审核每屏是否绑定具体卖点、产品状态、场景、构图和证明方式。",
    "审核相邻图片是否至少改变两项视觉变量，避免只换背景或文案。",
    "审核详情页屏序是否完整。",
    "审核文字和合规禁用项。"
  ]);
  const expectedDetail = task.generateDetail ? 8 : 0;
  const items = assets.map((asset) => reviewAsset(asset, task, analysis, expectedDetail, sellingPointCoverage));
  for (const item of failures) {
    items.push({
      role: item.role,
      index: item.index,
      title: item.title,
      path: "",
      status: "失败",
      checks: [
        {
          id: "generation",
          label: "生成任务完成",
          passed: false,
          evidence: item.error
        }
      ],
      notes: [`尝试 ${item.attempts} 次后失败，需要重新生成或调整提示词。`]
    });
  }
  items.sort((a, b) => a.role.localeCompare(b.role) || a.index - b.index);
  const passed = items.filter((item) => item.status === "通过").length;
  const failed = items.filter((item) => item.status === "失败").length;
  return {
    sku: task.sku,
    brandName: brand.name,
    generatedAt,
    source: "reference-case-learning",
    referenceSummary: analysis.summary,
    brandVisualLogic,
    designReviewRules,
    sellingPointCoverage,
    summary: {
      total: items.length,
      passed,
      needsReview: items.filter((item) => item.status === "需人工复核").length,
      failed
    },
    items
  };
}

function reviewAsset(
  asset: GeneratedAsset,
  task: ProductTask,
  analysis: ReferenceAnalysis,
  expectedDetail: number,
  sellingPointCoverage: SellingPointCoverage[] = []
): DesignReviewItem {
  const prompt = asset.prompt;
  const isMain = asset.role === "main";
  const context = productContext(task);
  const isEnglishMarketplace = context.isEnglishMarketplace;
  const expectedWidth = isMain ? asset.width : asset.width;
  const expectedHeight = isMain ? asset.width : Math.round(asset.width * 16 / 9);
  const checks = [
    {
      id: "dimension",
      label: isMain ? "主图方图尺寸正确" : "详情页 9:16 尺寸正确",
      passed: isMain ? asset.width === asset.height : Math.abs(asset.height / asset.width - 16 / 9) < 0.012,
      evidence: `实际 ${asset.width}x${asset.height}，期望约 ${expectedWidth}x${expectedHeight}`
    },
    {
      id: "brand-system",
      label: "品牌视觉系统进入提示词",
      passed: /全域色彩|品牌化设计逻辑|套图一致性|排版系统|高级文字版式总控|SET ART DIRECTION|Continuity:/.test(prompt),
      evidence: "检查提示词中的全域色彩、品牌化设计逻辑、套图一致性和排版系统。"
    },
    {
      id: "typography-layout",
      label: "高级文字版式规则进入提示词",
      passed: /高级文字版式总控|文字层级|图形承托|排版禁忌|VISIBLE COPY CONTRACT|Typography:/.test(prompt),
      evidence: "检查提示词是否明确主副辅层级、对齐留白、图形承托和排版禁忌。"
    },
    {
      id: "shot-diversity",
      label: isMain ? "主图单屏镜头任务明确" : "详情页镜头差异规则进入提示词",
      passed: isMain ? /画面调度|构图|本屏角色|FRAME EXECUTION|Composition:/.test(prompt) : /详情页镜头差异硬规则|本屏镜头脚本|禁止连续两屏使用同一背景|Difference from adjacent frames:/.test(prompt),
      evidence: isMain ? "主图提示词包含画面调度和构图。" : "详情页提示词要求相邻屏更换镜头距离、角度、动作证据和背景空间。"
    },
    {
      id: "storyboard-brief",
      label: "逐屏分镜包含卖点、状态、场景、构图和证明方式",
      passed: /本屏分镜执行单|本屏必须证明的卖点|产品状态：|场景与辅助元素：|构图类型：|可见证明方式：/.test(prompt) || /本屏画面脚本|本屏角色|画面调度|转化目标/.test(prompt) || /CURRENT FRAME MISSION[\s\S]*Product state\/action:[\s\S]*Scene and interaction:[\s\S]*Composition:[\s\S]*Visible proof:/.test(prompt),
      evidence: "每张图片都应有可执行的逐屏分镜，而不是只复用通用模板。"
    },
    {
      id: "benefit-proof-binding",
      label: "具体卖点与画面证据绑定",
      passed: (/本屏必须证明的卖点：\S+/.test(prompt) && /可见证明方式：\S+/.test(prompt)) || /卖点|转化目标|证据|证明/.test(prompt) || /CURRENT FRAME MISSION[\s\S]*Visible proof:/.test(prompt),
      evidence: "检查卖点是否明确对应产品状态、道具或动作证据。"
    },
    {
      id: "case-layout-learning",
      label: "参考案例只抽象构图和信息组织",
      passed: /优秀案例抽象学习|只学习信息组织和视觉证明方式|CURRENT FRAME MISSION[\s\S]*Visual analysis summary:/.test(prompt),
      evidence: "案例只用于学习英雄图、互动图、细节板、多宫格和收尾节奏，不复制案例商品或文案。"
    },
    {
      id: "reference-learning",
      label: "参考案例分析进入提示词",
      passed: /案例学习|参考案例分析|学习库|设计审核标准/.test(prompt) || Boolean(analysis.brandVisualLogic?.length),
      evidence: analysis.summary || "未提供参考摘要。"
    },
    {
      id: "conversion-goal",
      label: "单屏转化目标明确",
      passed: /转化目标|本张任务|本屏角色|CURRENT FRAME MISSION/.test(prompt),
      evidence: asset.title
    },
    {
      id: "copy-lock",
      label: "限定营销文案并保留商品本体文字",
      passed: ((
        isEnglishMarketplace
          ? /Visible marketing copy may only use|every word must remain exact/.test(prompt)
          : /营销文案只允许出现以下指定文字|必须逐字准确/.test(prompt)
      ) && /产品本体文字锁定|商品本体在本地商品图|original product\/packaging\/label\/logo text/.test(prompt)) || (/VISIBLE COPY CONTRACT/.test(prompt) && /Original text printed on the physical product or packaging is exempt/.test(prompt)),
      evidence: "提示词要求营销文案只出现指定内容，同时保留本地商品图上的原有产品文字。"
    },
    {
      id: "visible-copy-quality",
      label: "消费者文案不是通用模板词",
      passed: !allowedMarketingCopyContainsTemplateTerm(prompt),
      evidence: "检查营销文案白名单，避免把页面模块名当成消费者可见卖点。"
    },
    {
      id: "compliance",
      label: "禁用项和不虚构规则进入提示词",
      passed: /禁止|不虚构|Forbidden:|Do not invent/.test(prompt),
      evidence: task.bannedElements || "使用默认禁用项。"
    }
  ];
  if (isEnglishMarketplace) {
    const allowedCopy = extractAllowedVisibleCopy(prompt);
    checks.push(
      {
        id: "english-language-rule",
        label: "英文语言规则进入提示词",
        passed: /输出语言\s*[：:]\s*English|Language control|Visible marketing copy may only use|Language:\s*English/i.test(prompt),
        evidence: "检查提示词是否按输出语言执行英文可见文案，不把 Amazon 平台风格和英文语言绑定。"
      },
      {
        id: "english-visible-copy-clean",
        label: "英文可见文案无中文和内部字段",
        passed: allowedCopy.length > 0 && allowedCopy.every((line) => cleanEnglishVisibleCopy(line) === line),
        evidence: allowedCopy.join(" | ") || "未解析到英文可见文案白名单。"
      }
    );
  } else {
    const allowedCopy = extractAllowedVisibleCopy(prompt);
    checks.push({
      id: "chinese-visible-copy-clean",
      label: "中文可见文案无英文营销句",
      passed: allowedCopy.length > 0 && allowedCopy.every((line) => !containsEnglishMarketingPhrase(line)),
      evidence: allowedCopy.join(" | ") || "未解析到中文可见文案白名单。"
    });
  }
  if (isMain && asset.index === 1) {
    checks.push({
      id: "hero-main",
      label: "首图商品体量和货架点击逻辑明确",
      passed: /产品占画面约7|商品足够大|3 秒|3秒|第一视觉主体|Product presence:\s*hero presence|clearly identifiable at first glance/.test(prompt),
      evidence: "首图提示词要求大商品、快速识别和第一卖点。"
    });
    const explicitCoverage = sellingPointCoverage.filter((item) => item.source === "explicit");
    if (explicitCoverage.length) {
      checks.push({
        id: "selling-point-coverage",
        label: "用户明确卖点已绑定到逐屏分镜",
        passed: explicitCoverage.every((item) => item.status === "covered"),
        evidence: explicitCoverage.map((item) => `${item.point}: ${item.status} (${item.frameKeys.join("/") || "未分配"})`).join("；")
      });
    }
  }
  if (!isMain && expectedDetail) {
    checks.push({
      id: "detail-sequence",
      label: "详情页屏序符合销售动线",
      passed: asset.index >= 1 && asset.index <= expectedDetail && /详情页节奏|详情页屏序|首屏|顾虑|证据|场景|细节|决策|收尾|CURRENT FRAME MISSION \(DETAIL/.test(prompt),
      evidence: `详情页第 ${asset.index}/${expectedDetail} 屏`
    });
  }
  const notes = [
    "自动审核已覆盖尺寸、提示词结构、品牌系统、参考案例逻辑、文案限定和合规禁用项。",
    "图片内中文是否完全无错字、模特姿态是否足够高级，仍建议人工快速抽查。"
  ];
  const passed = checks.every((check) => check.passed);
  return {
    role: asset.role,
    index: asset.index,
    title: asset.title,
    path: asset.path,
    status: passed ? "通过" : "需人工复核",
    checks,
    notes
  };
}

function allowedMarketingCopyContainsTemplateTerm(prompt: string): boolean {
  const allowedCopy = extractAllowedVisibleCopy(prompt);
  return allowedCopy.some((line) => containsTemplateVisibleCopyTerm(line));
}

export function extractAllowedVisibleCopy(prompt: string): string[] {
  const compactMatch = prompt.match(/Use only these approved marketing lines:\s*([^\n]+)/i);
  if (compactMatch) {
    return [...compactMatch[1].matchAll(/[“"]([^”"]+)[”"]/g)]
      .map((match) => match[1].trim())
      .filter(Boolean);
  }
  const chineseMatch = prompt.match(/营销文案只允许出现以下指定文字：([^。]+)。/);
  if (chineseMatch) {
    return [...chineseMatch[1].matchAll(/「([^」]+)」/g)]
      .map((match) => match[1].trim())
      .filter(Boolean);
  }
  const englishMatch = prompt.match(/Visible marketing copy may only use the following exact English text:\s*([\s\S]*?)\.\s*The specified text may be used/i);
  if (!englishMatch) return [];
  return [...englishMatch[1].matchAll(/"([^"]+)"/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function containsEnglishMarketingPhrase(value: string): boolean {
  const withoutKnownAcronyms = value.replace(/\b(AI|LED|USB|IP|WiFi|APP|PPSU|ABS|PVC|PE|PP|HD|UV)\b/gi, "");
  return /\b[a-z]{4,}\s+[a-z]{3,}\b/i.test(withoutKnownAcronyms);
}

function attachDesignReviewToAssets(assets: GeneratedAsset[], report: DesignReviewReport): void {
  const reviewByKey = new Map(report.items.map((item) => [`${item.role}-${item.index}`, item]));
  for (const asset of assets) {
    asset.designReview = reviewByKey.get(`${asset.role}-${asset.index}`);
  }
}

function referenceImagePathsFromAnalysis(analysis: ReferenceAnalysis): string[] {
  const paths = new Set<string>();
  for (const reference of analysis.references) {
    if (reference.mainImagePath) paths.add(reference.mainImagePath);
    if (reference.detailScreenshotPath) paths.add(reference.detailScreenshotPath);
  }
  return [...paths];
}

export async function composeLongDetailImage(detailImages: GeneratedAsset[], outputPath: string): Promise<string> {
  const sorted = [...detailImages].sort((a, b) => a.index - b.index);
  if (!sorted.length) throw new Error("没有可拼接的详情页图片。");
  const metadata = await Promise.all(sorted.map((asset) => sharp(asset.path).metadata()));
  const width = Math.max(...metadata.map((item) => item.width ?? 0));
  const totalHeight = metadata.reduce((sum, item) => sum + (item.height ?? 0), 0);
  if (!width || !totalHeight) throw new Error("详情页图片尺寸无效，无法拼接长图。");
  let top = 0;
  const composites = [];
  for (const [index, asset] of sorted.entries()) {
    const item = metadata[index];
    const height = item.height ?? 0;
    const image = await sharp(asset.path)
      .resize(width, height, { fit: "cover" })
      .toBuffer();
    composites.push({ input: image, left: 0, top });
    top += height;
  }
  await ensureDir(path.dirname(outputPath));
  await sharp({
    create: {
      width,
      height: totalHeight,
      channels: 3,
      background: "#fffdf8"
    }
  })
    .composite(composites)
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outputPath);
  return outputPath;
}

export async function composeContactSheet(
  assets: GeneratedAsset[],
  outputPath: string,
  options: { columns: number; cellWidth: number; background: string; labelLanguage?: "zh" | "en" }
): Promise<string> {
  const sorted = [...assets].sort((a, b) => a.index - b.index);
  if (!sorted.length) throw new Error("没有可拼接的总览图片。");
  const metadata = await Promise.all(sorted.map((asset) => sharp(asset.path).metadata()));
  const first = metadata[0];
  const sourceRatio = (first.height ?? options.cellWidth) / Math.max(1, first.width ?? options.cellWidth);
  const cellHeight = Math.round(options.cellWidth * sourceRatio);
  const gap = 22;
  const labelHeight = 52;
  const columns = options.columns;
  const rows = Math.ceil(sorted.length / columns);
  const width = columns * options.cellWidth + (columns + 1) * gap;
  const height = rows * (cellHeight + labelHeight) + (rows + 1) * gap;
  const composites = [];
  for (const [index, asset] of sorted.entries()) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const left = gap + col * (options.cellWidth + gap);
    const top = gap + row * (cellHeight + labelHeight + gap);
    composites.push({
      input: await sharp(asset.path)
        .resize(options.cellWidth, cellHeight, { fit: "cover", position: "top" })
        .jpeg({ quality: 88 })
        .toBuffer(),
      left,
      top
    });
    composites.push({
      input: Buffer.from(contactSheetLabelSvg(options.cellWidth, labelHeight, `${pad(asset.index)} ${contactSheetTitle(asset, options.labelLanguage ?? "zh")}`)),
      left,
      top: top + cellHeight
    });
  }
  await ensureDir(path.dirname(outputPath));
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: options.background
    }
  })
    .composite(composites)
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(outputPath);
  return outputPath;
}

function contactSheetTitle(asset: GeneratedAsset, language: "zh" | "en"): string {
  if (language !== "en") return asset.title;
  const mainTitles: Record<string, string> = {
    "商品首图": "Hero",
    "核心卖点": "Feature",
    "使用场景": "Lifestyle",
    "细节特写": "Detail",
    "决策收尾": "Decision"
  };
  const detailTitles: Record<string, string> = {
    "核心主张": "Value",
    "用户顾虑": "Concern",
    "卖点证明": "Proof",
    "场景代入": "Lifestyle",
    "细节信任": "Detail",
    "多角度证明": "Angles",
    "决策理由": "Decision",
    "系列收尾": "Closing"
  };
  return asset.role === "main"
    ? mainTitles[asset.title] ?? `Main ${asset.index}`
    : detailTitles[asset.title] ?? `Detail ${asset.index}`;
}

function contactSheetLabelSvg(width: number, height: number, text: string): string {
  return [
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`,
    '<rect width="100%" height="100%" fill="#fffdf8"/>',
    `<text x="20" y="${Math.round(height * 0.64)}" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#2f2527">${escapeXml(text)}</text>`,
    "</svg>"
  ].join("");
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return char;
    }
  });
}

function safeTaskForReport(task: ProductTask): Record<string, unknown> {
  return {
    ...task,
    localProductImages: task.localProductImages.map((item) => path.basename(item)),
    materialDir: path.basename(task.materialDir)
  };
}

function generationRuleManifest(task: ProductTask): GenerationManifest["generationRule"] {
  if (!task.generationRuleProfile && !task.generationRuleName && !task.generationRuleFile) return undefined;
  return {
    profile: task.generationRuleProfile,
    name: task.generationRuleName,
    file: task.generationRuleFile,
    version: task.generationRuleVersion,
    reason: task.generationRuleReason,
    matchedKeywords: task.generationRuleMatchedKeywords ?? []
  };
}

function platformRuleManifest(task: ProductTask): GenerationManifest["platformRule"] {
  if (!task.platformRuleProfile && !task.platformRuleName && !task.platformRuleFile) return undefined;
  return {
    profile: task.platformRuleProfile,
    name: task.platformRuleName,
    file: task.platformRuleFile,
    version: task.platformRuleVersion,
    reason: task.platformRuleReason,
    matchedKeywords: task.platformRuleMatchedKeywords ?? []
  };
}

function languageRuleManifest(task: ProductTask): GenerationManifest["languageRule"] {
  if (!task.languageRuleProfile && !task.languageRuleName && !task.languageRuleFile) return undefined;
  return {
    profile: task.languageRuleProfile,
    name: task.languageRuleName,
    file: task.languageRuleFile,
    version: task.languageRuleVersion,
    reason: task.languageRuleReason,
    matchedKeywords: task.languageRuleMatchedKeywords ?? []
  };
}

function buildReport(
  task: ProductTask,
  brand: BrandProfile,
  mainImages: GeneratedAsset[],
  detailImages: GeneratedAsset[],
  failures: AssetFailure[],
  packagePath: string,
  longDetailPath?: string,
  designReviewPath?: string,
  sellingPointCoverage: SellingPointCoverage[] = []
): string {
  const explicitCoverage = sellingPointCoverage.filter((item) => item.source === "explicit");
  const coverageSummary = explicitCoverage.length
    ? `显式卖点覆盖：${explicitCoverage.filter((item) => item.status === "covered").length}/${explicitCoverage.length}；需复核：${explicitCoverage.filter((item) => item.status !== "covered").map((item) => item.point).join("、") || "无"}`
    : "显式卖点覆盖：未提取到用户明确卖点";
  return [
    `SKU：${task.sku}`,
    `品牌：${brand.name}`,
    `主图：${mainImages.length}/${task.mainImageCount}`,
    `详情模块：${detailImages.length}/${task.generateDetail ? 8 : 0}`,
    longDetailPath ? `详情长图：${longDetailPath}` : "",
    designReviewPath ? `设计审核：${designReviewPath}` : "",
    coverageSummary,
    `失败项：${failures.length}`,
    `打包文件：${packagePath}`
  ].filter(Boolean).join("\n");
}

async function parseOpenAiResponseOrStream(response: Response): Promise<unknown> {
  const text = await response.text();
  if (looksLikeServerSentEvents(text)) {
    if (!response.ok) throw buildOpenAiResponseError(response, text);
    return normalizeOpenAiStreamEvents(parseServerSentEvents(text));
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OpenAI response is not JSON or SSE: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  if (!response.ok) throw buildOpenAiResponseError(response, text, data);
  return data;
}

async function parseOpenAiResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OpenAI 响应不是 JSON：HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  if (!response.ok) throw buildOpenAiResponseError(response, text, data);
  return data;
}

function extractImageBase64(data: unknown): string | null {
  const stack: unknown[] = [data];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    const object = current as Record<string, unknown>;
    for (const key of ["b64_json", "base64", "image_base64", "result"]) {
      if (typeof object[key] === "string" && looksLikeImageBase64(object[key] as string)) {
        return normalizeImageBase64(object[key] as string);
      }
    }
    stack.push(...Object.values(object));
  }
  return null;
}

function looksLikeServerSentEvents(text: string): boolean {
  return /^\s*(event|data):/m.test(text);
}

function parseServerSentEvents(text: string): unknown[] {
  const events: unknown[] = [];
  let dataLines: string[] = [];
  const flush = (): void => {
    if (!dataLines.length) return;
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (!payload || payload === "[DONE]") return;
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push({ raw: payload });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return events;
}

function normalizeOpenAiStreamEvents(events: unknown[]): unknown {
  const completed = [...events].reverse().find((event) => {
    if (!event || typeof event !== "object") return false;
    const object = event as Record<string, unknown>;
    return typeof object.type === "string" && object.type.includes("completed") && Boolean(object.response);
  }) as Record<string, unknown> | undefined;
  const response = completed && completed.response && typeof completed.response === "object"
    ? completed.response as Record<string, unknown>
    : null;
  const deltas = events
    .map((event) => event && typeof event === "object" ? event as Record<string, unknown> : null)
    .filter(Boolean)
    .map((event) => typeof event?.delta === "string" ? event.delta : "")
    .filter(Boolean);
  return {
    ...(response ?? {}),
    output_text: response ? extractOpenAiText(response) : deltas.join("").trim(),
    events
  };
}

function buildOpenAiResponseError(response: Response, text: string, data?: unknown): Error {
  const parsed = data ?? (() => {
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  })();
  const error = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).error : null;
  const message = error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
    ? (error as Record<string, unknown>).message as string
    : text.slice(0, 500);
  const normalized = new Error(`OpenAI API HTTP ${response.status}: ${message}`);
  (normalized as Error & { status?: number }).status = response.status;
  return normalized;
}

function isUnsupportedOpenAiImagesEndpointError(error: unknown): boolean {
  const message = errorMessage(error);
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return /endpoint\s+not\s+supported|unsupported|not\s+supported|not\s+found|unknown\s+endpoint|invalid\s+endpoint/i.test(message) ||
    (typeof status === "number" && [404, 405, 501].includes(status));
}

function looksLikeImageBase64(value: string): boolean {
  const normalized = normalizeImageBase64(value);
  return normalized.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(normalized);
}

function normalizeImageBase64(value: string): string {
  return value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").replace(/\s+/g, "");
}
