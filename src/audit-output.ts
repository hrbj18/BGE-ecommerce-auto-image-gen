import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadConfig } from "./config.ts";
import {
  composeContactSheet,
  composeLongDetailImage,
  OpenAiImageGenerator,
  requestOpenAiGeneratedVisualAudit,
  type NativeImageSpec
} from "./openai-image-generator.ts";
import { writeJson, zipFiles } from "./fs-utils.ts";
import { isActionableGeneratedVisualAuditFailure, type GeneratedVisualAuditReport } from "./output-audit.ts";
import { auditNativePromptSet } from "./prompt-audit.ts";
import type { GeneratedAsset, LocalProductImage, ProductTask } from "./types.ts";

type StoredPromptRecord = NativeImageSpec & {
  path?: string;
  status?: string;
  taskId?: string;
  submittedAt?: string;
  attempts?: number;
  error?: string;
};

async function main(): Promise<void> {
  const outputDir = path.resolve(readOutputDir(process.argv.slice(2)));
  const task = JSON.parse(await fs.readFile(path.join(outputDir, "task.json"), "utf8")) as ProductTask;
  const records = JSON.parse(await fs.readFile(path.join(outputDir, "prompts.json"), "utf8")) as StoredPromptRecord[];
  const specs = records.map(({ role, index, title, aspectRatio, copy, prompt, auditSummary, creativeFrame }) => ({
    role, index, title, aspectRatio, copy, prompt, auditSummary, creativeFrame
  }));
  const trustedVisualEvidence = await readTrustedVisualEvidence(outputDir);
  const promptAudit = auditNativePromptSet(task, specs, { trustedVisualEvidence });
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
  const loadAssets = async (): Promise<GeneratedAsset[]> => Promise.all(records.map(async (record) => {
    const filePath = record.path || path.join(outputDir, record.role, `${String(record.index).padStart(2, "0")}-${record.title}.png`);
    const [metadata, stat] = await Promise.all([sharp(filePath).metadata(), fs.stat(filePath)]);
    return {
      role: record.role,
      index: record.index,
      title: record.title,
      prompt: record.prompt,
      path: filePath,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      bytes: stat.size
    } satisfies GeneratedAsset;
  }));
  const productImages: LocalProductImage[] = task.localProductImages.map((imagePath) => {
    const resolved = path.resolve(imagePath);
    return {
      sourceName: path.basename(resolved),
      path: resolved,
      mimeType: resolved.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg"
    };
  });
  const config = loadConfig();
  let assets = await loadAssets();
  if (process.argv.includes("--local-only")) {
    const visualAudit = JSON.parse(await fs.readFile(path.join(outputDir, "output-visual-audit.json"), "utf8")) as GeneratedVisualAuditReport;
    await refreshDerivedOutput(outputDir, task, assets, visualAudit);
    console.log(JSON.stringify({ outputDir, promptAuditOk: promptAudit.ok, promptAuditWarnings: promptAudit.warnings }, null, 2));
    return;
  }
  const retryFailed = process.argv.includes("--retry-failed");
  let report = retryFailed
    ? JSON.parse(await fs.readFile(path.join(outputDir, "output-visual-audit.json"), "utf8")) as GeneratedVisualAuditReport
    : await requestOpenAiGeneratedVisualAudit(config, task, productImages, specs, assets);
  if (retryFailed) {
    const generator = new OpenAiImageGenerator(config);
    const invalidDir = path.join(outputDir, "raw", "invalid-native");
    for (const item of report.items.filter(isActionableGeneratedVisualAuditFailure)) {
      const record = records.find((candidate) => candidate.role === item.role && candidate.index === item.index);
      if (!record) continue;
      const retrySpec: NativeImageSpec = {
        ...record,
        prompt: `${record.prompt}\n\nVISUAL REVIEW RETRY:\nThe retry must still execute this exact plan:\n${record.auditSummary || "Use the current frame mission above."}\nCorrect only the rejected quality issues while preserving the product identity and all approved constraints. Review notes: ${item.reasons.join("; ")}`
      };
      const candidatePath = path.join(outputDir, "raw", `manual-review-${retrySpec.role}-${String(retrySpec.index).padStart(2, "0")}-${Date.now()}.png`);
      const generation = await generator.generateValidatedNativeAsset({
        spec: retrySpec,
        outputPath: candidatePath,
        productImages,
        task,
        invalidDir,
        attemptNumber: 300 + item.index
      });
      const finalPath = record.path || path.join(outputDir, record.role, `${String(record.index).padStart(2, "0")}-${record.title}.png`);
      await fs.copyFile(candidatePath, finalPath);
      await fs.rm(candidatePath, { force: true });
      record.status = "completed";
      Object.assign(record, {
        taskId: generation.taskId,
        submittedAt: generation.submittedAt,
        attempts: generation.attempts,
        error: undefined
      });
      console.log(`[output-repair] completed ${record.role}-${String(record.index).padStart(2, "0")} ${record.title}`);
    }
    await writeJson(path.join(outputDir, "prompts.json"), records);
    assets = await loadAssets();
    report = await requestOpenAiGeneratedVisualAudit(config, task, productImages, specs, assets);
    await refreshDerivedOutput(outputDir, task, assets, report);
  }
  await writeJson(path.join(outputDir, "output-visual-audit.json"), report);
  console.log(JSON.stringify({
    outputDir,
    passed: report.passed,
    responseItemCount: report.responseItemCount,
    matchedItemCount: report.matchedItemCount,
    failures: report.items.filter((item) => !item.passed).map(({ role, index, title, reasons }) => ({ role, index, title, reasons })),
    warnings: report.warnings
  }, null, 2));
}

async function readTrustedVisualEvidence(outputDir: string): Promise<string> {
  try {
    const analysis = JSON.parse(await fs.readFile(path.join(outputDir, "analysis.json"), "utf8")) as {
      productVisualInsight?: { summary?: string; productFacts?: string[] };
    };
    return [analysis.productVisualInsight?.summary, ...(analysis.productVisualInsight?.productFacts ?? [])].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

async function refreshDerivedOutput(
  outputDir: string,
  task: ProductTask,
  assets: GeneratedAsset[],
  visualAudit: GeneratedVisualAuditReport
): Promise<void> {
  const mainImages = assets.filter((asset) => asset.role === "main").sort(assetOrder);
  const detailImages = assets.filter((asset) => asset.role === "detail").sort(assetOrder);
  const longDetailPath = detailImages.length ? await composeLongDetailImage(detailImages, path.join(outputDir, "详情页完整长图.jpg")) : undefined;
  const english = /^en(?:glish)?$/i.test(task.outputLanguage?.trim() ?? "");
  const mainPreviewPath = mainImages.length ? await composeContactSheet(mainImages, path.join(outputDir, "5张主图总览.jpg"), { columns: 2, cellWidth: 720, background: "#f4f0ea", labelLanguage: english ? "en" : "zh" }) : undefined;
  const detailPreviewPath = detailImages.length ? await composeContactSheet(detailImages, path.join(outputDir, "8张详情页总览.jpg"), { columns: 2, cellWidth: 520, background: "#f4f0ea", labelLanguage: english ? "en" : "zh" }) : undefined;
  const generationAuditPath = path.join(outputDir, "generation-audit.json");
  const generationAudit = JSON.parse(await fs.readFile(generationAuditPath, "utf8")) as Record<string, unknown>;
  Object.assign(generationAudit, { generatedAt: new Date().toISOString(), visualAudit });
  await writeJson(generationAuditPath, generationAudit);
  const packageFiles = [
    ...mainImages.map((asset) => ({ filePath: asset.path, archivePath: `main/${path.basename(asset.path)}` })),
    ...detailImages.map((asset) => ({ filePath: asset.path, archivePath: `detail/${path.basename(asset.path)}` })),
    ...(longDetailPath ? [{ filePath: longDetailPath, archivePath: path.basename(longDetailPath) }] : []),
    ...(mainPreviewPath ? [{ filePath: mainPreviewPath, archivePath: path.basename(mainPreviewPath) }] : []),
    ...(detailPreviewPath ? [{ filePath: detailPreviewPath, archivePath: path.basename(detailPreviewPath) }] : []),
    ...["prompts.json", "generation-audit.json", "output-visual-audit.json", "design-review.json", "report.json", "analysis.json"]
      .map((name) => ({ filePath: path.join(outputDir, name), archivePath: name }))
  ];
  await writeJson(path.join(outputDir, "output-visual-audit.json"), visualAudit);
  await zipFiles(packageFiles, path.join(outputDir, "package.zip"));
}

function assetOrder(left: GeneratedAsset, right: GeneratedAsset): number {
  return left.index - right.index;
}

function readOutputDir(args: string[]): string {
  const dirArg = args.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length);
  if (dirArg) return dirArg;
  const dirIndex = args.indexOf("--dir");
  if (dirIndex >= 0 && args[dirIndex + 1]) return args[dirIndex + 1]!;
  throw new Error("Usage: node src/audit-output.ts --dir <completed-output-directory>");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
