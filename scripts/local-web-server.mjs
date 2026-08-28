import { createReadStream, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { selectGenerationRule } from "./generation-rule-loader.mjs";
import {
  buildConcreteBriefSections,
  briefExpansionQualityIssues,
  detectProductIdentityConflict,
  genericBriefPhrasesForPrompt,
  inferProductIdentity,
  inferBriefSellingPoints,
  inferEvidenceBasedEnglishDisplayName,
} from "./brief-expansion-rules.mjs";
import { inferCategoryFromSource } from "./category-inference.mjs";
import { parseNativeProgressLines } from "./generation-progress.mjs";
import { createPnpmCommand } from "./runtime-commands.mjs";

const rootDir = process.cwd();
const inputRoot = path.join(rootDir, "待作图");
const outputRoot = path.join(rootDir, "已完成");
const exampleRoot = path.join(rootDir, "优秀案例");
const localStateRoot = path.join(rootDir, ".local-web");
const taskRoot = path.join(localStateRoot, "tasks");
const taskStorePath = path.join(taskRoot, "tasks.json");
const taskMetadataFilename = "任务信息.json";
const port = Number(process.env.LOCAL_WEB_PORT || 8787);
const jobs = new Map();
const briefExpansionJobs = new Map();
let activeJobId = null;
let taskPersistTimer = null;

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const promptFileExtensions = new Set([".md", ".txt"]);
const fixedSuiteRatio = "主图 1:1 / 详情页 9:16";
const internalBriefPhrases = [
  "用户当前输入",
  "用户原始输入",
  "产品图视觉识别摘要",
  "请优先围绕",
  "扩写备注",
  "识别备注",
  "本地规则扩写",
  "后续生图",
  "案例学习库",
  "参考案例分析",
  "内部流程",
  "页面模块",
  "工作流",
  "接口",
  "prompt",
  "schema",
];
const knownBriefHeadings = new Set([
  "商品作图需求模板",
  "产品名称",
  "商品名称",
  "原始商品名",
  "可见展示名",
  "目标平台",
  "输出语言",
  "套图比例",
  "人群",
  "目标人群",
  "类目",
  "生成详情页",
  "核心卖点",
  "用户卖点提取与改写",
  "可用画面证据",
  "风险与禁写",
  "卖点证明矩阵",
  "画面要求",
  "主图规划",
  "详情页规划",
  "视觉风格参考",
  "本次硬要求",
  "可用文案方向",
  "禁用元素",
  "规格参数",
  "补充说明",
  "要求",
]);

loadDotEnv();
await fs.mkdir(inputRoot, { recursive: true });
await fs.mkdir(outputRoot, { recursive: true });
await fs.mkdir(exampleRoot, { recursive: true });
await fs.mkdir(taskRoot, { recursive: true });
await cleanupStagingDirectories();
await loadPersistedTasks();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return sendNoContent(res);
    setCors(res);
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        service: "local-web-api",
        port,
        uptimeSeconds: Math.floor(process.uptime()),
        activeJobs: jobs.size,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const client = getRequestClient(req);
      console.log(`[api/jobs] submission received at ${new Date().toISOString()} client=${client.address} host=${client.host}`);
      return handleCreateJob(req, res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) return handleGetJob(url, res);
    if (req.method === "GET" && url.pathname === "/api/tasks") return await handleListTasks(res);
    if (req.method === "GET" && url.pathname.startsWith("/api/tasks/")) return await handleGetTask(url, res);
    if (req.method === "DELETE" && url.pathname.startsWith("/api/tasks/")) return await handleDeleteTask(url, res);
    if (req.method === "POST" && url.pathname === "/api/brief-expansions") return handleCreateBriefExpansion(req, res);
    if (req.method === "GET" && url.pathname.startsWith("/api/brief-expansions/")) return handleGetBriefExpansion(url, res);
    if (req.method === "GET" && url.pathname === "/api/examples") return handleListExamples(res);
    if (req.method === "GET" && url.pathname.startsWith("/api/examples/")) return handleGetExample(url, res);
    if (req.method === "GET" && url.pathname === "/api/outputs") return handleListOutputs(res);
    if (req.method === "POST" && url.pathname.startsWith("/api/outputs/") && url.pathname.endsWith("/download")) {
      return handleDownloadSelection(req, url, res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/outputs/")) return handleGetOutput(url, res);
    if (req.method === "DELETE" && url.pathname.startsWith("/api/outputs/")) return handleDeleteOutput(url, res);
    if (req.method === "GET" && url.pathname.startsWith("/example-assets/")) return handleExampleAsset(url, res);
    if (req.method === "GET" && url.pathname.startsWith("/outputs/")) return handleOutputFile(url, res);
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("error", (error) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN";
  console.error(`[local-web-server] failed to listen on port ${port}: ${code}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Local ecommerce API listening on http://0.0.0.0:${port}`);
});

function getRequestClient(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return {
    address: forwarded || req.socket.remoteAddress || "unknown",
    host: String(req.headers["x-forwarded-host"] || req.headers.host || "unknown"),
    origin: String(req.headers.origin || ""),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 240),
  };
}

function loadDotEnv(filePath = path.join(rootDir, ".env"), options = {}) {
  if (!existsSync(filePath)) return;
  const override = Boolean(options.override);
  const contents = readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && (override || !process.env[key])) process.env[key] = value;
  }
}

async function loadPersistedTasks() {
  const store = await readJson(taskStorePath);
  const tasks = Array.isArray(store?.tasks) ? store.tasks : [];
  let changed = false;
  for (const item of tasks) {
    if (!item?.id) continue;
    const job = normalizePersistedJob(item);
    if (["queued", "running", "submitting"].includes(job.status)) {
      job.status = "failed";
      job.message = "服务曾经重启，这个任务没有可恢复的运行进程，请重新生成。";
      job.updatedAt = new Date().toISOString();
      addJobEvent(job, "interrupted", "服务重启后恢复任务记录，但运行进程已中断。");
      changed = true;
    }
    jobs.set(job.id, job);
  }
  if (changed) await persistTasks();
}

function normalizePersistedJob(item) {
  return {
    id: String(item.id),
    taskId: text(item.taskId) || String(item.id),
    kind: item.kind || "generation",
    productName: text(item.productName) || "未命名任务",
    outputId: text(item.outputId) || text(item.outputFolderName) || text(item.output?.id) || text(item.productName),
    inputFolderName: text(item.inputFolderName),
    outputFolderName: text(item.outputFolderName) || text(item.outputId) || text(item.output?.id),
    materialDir: text(item.materialDir),
    outputDir: text(item.outputDir),
    materialFiles: Array.isArray(item.materialFiles) ? item.materialFiles.map((name) => String(name)).slice(0, 80) : [],
    referenceCount: Number(item.referenceCount || 0),
    referenceNames: Array.isArray(item.referenceNames) ? item.referenceNames.map((name) => String(name)).slice(0, 20) : [],
    briefSource: text(item.briefSource),
    briefFallbackReason: text(item.briefFallbackReason),
    briefPreview: text(item.briefPreview),
    templateName: text(item.templateName),
    rawBriefText: text(item.rawBriefText),
    expandedBriefText: text(item.expandedBriefText),
    finalBriefText: text(item.finalBriefText),
    visibleProductName: text(item.visibleProductName),
    targetPlatform: text(item.targetPlatform),
    outputLanguage: text(item.outputLanguage),
    suiteRatio: text(item.suiteRatio),
    briefFocus: text(item.briefFocus),
    briefDiagnostics: normalizeBriefDiagnostics(item.briefDiagnostics),
    submissionClient: item.submissionClient && typeof item.submissionClient === "object"
      ? {
          address: text(item.submissionClient.address),
          host: text(item.submissionClient.host),
          origin: text(item.submissionClient.origin),
          userAgent: text(item.submissionClient.userAgent),
        }
      : null,
    commonRuleProfile: text(item.commonRuleProfile),
    commonRuleName: text(item.commonRuleName),
    commonRuleFile: text(item.commonRuleFile),
    commonRuleVersion: text(item.commonRuleVersion),
    commonRuleReason: text(item.commonRuleReason),
    commonRuleMatchedKeywords: Array.isArray(item.commonRuleMatchedKeywords)
      ? item.commonRuleMatchedKeywords.map((name) => String(name)).slice(0, 30)
      : [],
    platformRuleProfile: text(item.platformRuleProfile),
    platformRuleName: text(item.platformRuleName),
    platformRuleFile: text(item.platformRuleFile),
    platformRuleVersion: text(item.platformRuleVersion),
    platformRuleReason: text(item.platformRuleReason),
    platformRuleMatchedKeywords: Array.isArray(item.platformRuleMatchedKeywords)
      ? item.platformRuleMatchedKeywords.map((name) => String(name)).slice(0, 30)
      : [],
    languageRuleProfile: text(item.languageRuleProfile),
    languageRuleName: text(item.languageRuleName),
    languageRuleFile: text(item.languageRuleFile),
    languageRuleVersion: text(item.languageRuleVersion),
    languageRuleReason: text(item.languageRuleReason),
    languageRuleMatchedKeywords: Array.isArray(item.languageRuleMatchedKeywords)
      ? item.languageRuleMatchedKeywords.map((name) => String(name)).slice(0, 30)
      : [],
    generationRuleProfile: text(item.generationRuleProfile),
    generationRuleName: text(item.generationRuleName),
    generationRuleFile: text(item.generationRuleFile),
    generationRuleVersion: text(item.generationRuleVersion),
    generationRuleReason: text(item.generationRuleReason),
    generationRuleMatchedKeywords: Array.isArray(item.generationRuleMatchedKeywords)
      ? item.generationRuleMatchedKeywords.map((name) => String(name)).slice(0, 30)
      : [],
    submittedAtLocal: text(item.submittedAtLocal),
    filesDeletedAt: text(item.filesDeletedAt),
    status: text(item.status) || "failed",
    message: text(item.message),
    progress: parseNativeProgressLines(`[native-progress] ${JSON.stringify(item.progress || {})}`) || null,
    timing: item.timing && typeof item.timing === "object" ? {
      workflowStartedAt: text(item.timing.workflowStartedAt),
      firstPreviewAt: text(item.timing.firstPreviewAt),
      firstPreviewElapsedMs: Number(item.timing.firstPreviewElapsedMs || 0) || 0,
    } : null,
    createdAt: text(item.createdAt) || new Date().toISOString(),
    updatedAt: text(item.updatedAt) || text(item.createdAt) || new Date().toISOString(),
    output: item.output || null,
    log: trimLog(text(item.log)),
    events: Array.isArray(item.events) ? item.events.slice(-80) : [],
  };
}

async function taskSummary(job) {
  const promptInfo = await promptInfoForJob(job);
  return {
    id: job.id,
    productName: job.productName,
    taskId: job.taskId || job.id,
    outputId: job.output?.id || job.outputId || job.outputFolderName || job.productName,
    outputFolderName: job.outputFolderName || job.output?.id || "",
    inputFolderName: job.inputFolderName || path.basename(job.materialDir || ""),
    status: job.status,
    message: job.message,
    progress: job.progress || null,
    timing: job.timing || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    submittedAtLocal: job.submittedAtLocal || formatBeijingDateTime(job.createdAt),
    referenceCount: job.referenceCount || 0,
    submissionClient: job.submissionClient || null,
    briefSource: job.briefSource || "",
    briefFallbackReason: job.briefFallbackReason || "",
    briefDiagnostics: normalizeBriefDiagnostics(job.briefDiagnostics),
    visibleProductName: job.visibleProductName || "",
    targetPlatform: job.targetPlatform || "",
    outputLanguage: job.outputLanguage || "",
    suiteRatio: job.suiteRatio || fixedSuiteRatio,
    commonRuleProfile: job.commonRuleProfile || "",
    commonRuleName: job.commonRuleName || "",
    commonRuleFile: job.commonRuleFile || "",
    commonRuleVersion: job.commonRuleVersion || "",
    commonRuleReason: job.commonRuleReason || "",
    commonRuleMatchedKeywords: Array.isArray(job.commonRuleMatchedKeywords) ? job.commonRuleMatchedKeywords : [],
    platformRuleProfile: job.platformRuleProfile || "",
    platformRuleName: job.platformRuleName || "",
    platformRuleFile: job.platformRuleFile || "",
    platformRuleVersion: job.platformRuleVersion || "",
    platformRuleReason: job.platformRuleReason || "",
    platformRuleMatchedKeywords: Array.isArray(job.platformRuleMatchedKeywords) ? job.platformRuleMatchedKeywords : [],
    languageRuleProfile: job.languageRuleProfile || "",
    languageRuleName: job.languageRuleName || "",
    languageRuleFile: job.languageRuleFile || "",
    languageRuleVersion: job.languageRuleVersion || "",
    languageRuleReason: job.languageRuleReason || "",
    languageRuleMatchedKeywords: Array.isArray(job.languageRuleMatchedKeywords) ? job.languageRuleMatchedKeywords : [],
    generationRuleProfile: job.generationRuleProfile || "",
    generationRuleName: job.generationRuleName || "",
    generationRuleFile: job.generationRuleFile || "",
    generationRuleVersion: job.generationRuleVersion || "",
    generationRuleReason: job.generationRuleReason || "",
    generationRuleMatchedKeywords: Array.isArray(job.generationRuleMatchedKeywords) ? job.generationRuleMatchedKeywords : [],
    progress: job.progress || null,
    timing: job.timing || null,
    promptAvailable: promptInfo.available,
    promptComplete: promptInfo.available,
    promptSource: promptInfo.source,
    promptLength: promptInfo.length,
    outputProductName: job.output?.productName || job.productName,
    outputDisplayName: outputDisplayName(job.output || job),
    hasOutput: Boolean(job.output && hasVisibleOutput(job.output)),
    eventCount: Array.isArray(job.events) ? job.events.length : 0,
    latestEvent: Array.isArray(job.events) ? job.events.at(-1) || null : null,
  };
}

async function taskDetail(job) {
  const recoveredPrompt = fullPromptTextFromJob(job) ? "" : await readTaskPromptFile(job);
  if (recoveredPrompt && !job.finalBriefText && !job.expandedBriefText && !job.rawBriefText) {
    job.finalBriefText = recoveredPrompt;
    job.briefPreview = job.briefPreview || previewText(recoveredPrompt);
    addJobEvent(job, "prompt-recovered", "从待作图需求模板恢复了完整历史提示词。");
    schedulePersistTasks();
  }
  const summary = await taskSummary(job);
  return {
    ...summary,
    materialFiles: job.materialFiles || [],
    briefPreview: job.briefPreview || "",
    templateName: job.templateName || "",
    referenceNames: job.referenceNames || [],
    rawBriefText: job.rawBriefText || "",
    expandedBriefText: job.expandedBriefText || "",
    finalBriefText: job.finalBriefText || "",
    visibleProductName: job.visibleProductName || "",
    targetPlatform: job.targetPlatform || "",
    outputLanguage: job.outputLanguage || "",
    suiteRatio: job.suiteRatio || fixedSuiteRatio,
    briefFocus: job.briefFocus || "",
    briefDiagnostics: normalizeBriefDiagnostics(job.briefDiagnostics),
    briefFallbackReason: job.briefFallbackReason || "",
    commonRuleProfile: job.commonRuleProfile || "",
    commonRuleName: job.commonRuleName || "",
    commonRuleFile: job.commonRuleFile || "",
    commonRuleVersion: job.commonRuleVersion || "",
    commonRuleReason: job.commonRuleReason || "",
    commonRuleMatchedKeywords: Array.isArray(job.commonRuleMatchedKeywords) ? job.commonRuleMatchedKeywords : [],
    platformRuleProfile: job.platformRuleProfile || "",
    platformRuleName: job.platformRuleName || "",
    platformRuleFile: job.platformRuleFile || "",
    platformRuleVersion: job.platformRuleVersion || "",
    platformRuleReason: job.platformRuleReason || "",
    platformRuleMatchedKeywords: Array.isArray(job.platformRuleMatchedKeywords) ? job.platformRuleMatchedKeywords : [],
    languageRuleProfile: job.languageRuleProfile || "",
    languageRuleName: job.languageRuleName || "",
    languageRuleFile: job.languageRuleFile || "",
    languageRuleVersion: job.languageRuleVersion || "",
    languageRuleReason: job.languageRuleReason || "",
    languageRuleMatchedKeywords: Array.isArray(job.languageRuleMatchedKeywords) ? job.languageRuleMatchedKeywords : [],
    generationRuleProfile: job.generationRuleProfile || "",
    generationRuleName: job.generationRuleName || "",
    generationRuleFile: job.generationRuleFile || "",
    generationRuleVersion: job.generationRuleVersion || "",
    generationRuleReason: job.generationRuleReason || "",
    generationRuleMatchedKeywords: Array.isArray(job.generationRuleMatchedKeywords) ? job.generationRuleMatchedKeywords : [],
    output: job.output || null,
    log: job.log || "",
    events: job.events || [],
  };
}

function addJobEvent(job, type, message, detail = {}) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    message,
    detail,
    createdAt: new Date().toISOString(),
  };
  job.events = [...(Array.isArray(job.events) ? job.events : []), event].slice(-80);
  job.updatedAt = event.createdAt;
  schedulePersistTasks();
  return event;
}

function schedulePersistTasks() {
  if (taskPersistTimer) clearTimeout(taskPersistTimer);
  taskPersistTimer = setTimeout(() => {
    taskPersistTimer = null;
    persistTasks().catch((error) => {
      console.warn(`保存任务记录失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, 220);
}

async function persistTasks() {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    tasks: [...jobs.values()]
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 200)
      .map((job) => ({
        id: job.id,
        taskId: job.taskId || job.id,
        kind: job.kind || "generation",
        productName: job.productName,
        outputId: job.output?.id || job.outputId || job.outputFolderName || "",
        inputFolderName: job.inputFolderName || "",
        outputFolderName: job.outputFolderName || "",
        materialDir: job.materialDir,
        outputDir: job.outputDir || "",
        materialFiles: job.materialFiles || [],
        referenceCount: job.referenceCount || 0,
        referenceNames: job.referenceNames || [],
        submissionClient: job.submissionClient || null,
        briefSource: job.briefSource || "",
        briefFallbackReason: job.briefFallbackReason || "",
        briefPreview: job.briefPreview || "",
        templateName: job.templateName || "",
        rawBriefText: job.rawBriefText || "",
        expandedBriefText: job.expandedBriefText || "",
        finalBriefText: job.finalBriefText || "",
        visibleProductName: job.visibleProductName || "",
        targetPlatform: job.targetPlatform || "",
        outputLanguage: job.outputLanguage || "",
        suiteRatio: job.suiteRatio || fixedSuiteRatio,
        briefFocus: job.briefFocus || "",
        briefDiagnostics: normalizeBriefDiagnostics(job.briefDiagnostics),
        commonRuleProfile: job.commonRuleProfile || "",
        commonRuleName: job.commonRuleName || "",
        commonRuleFile: job.commonRuleFile || "",
        commonRuleVersion: job.commonRuleVersion || "",
        commonRuleReason: job.commonRuleReason || "",
        commonRuleMatchedKeywords: Array.isArray(job.commonRuleMatchedKeywords) ? job.commonRuleMatchedKeywords : [],
        platformRuleProfile: job.platformRuleProfile || "",
        platformRuleName: job.platformRuleName || "",
        platformRuleFile: job.platformRuleFile || "",
        platformRuleVersion: job.platformRuleVersion || "",
        platformRuleReason: job.platformRuleReason || "",
        platformRuleMatchedKeywords: Array.isArray(job.platformRuleMatchedKeywords) ? job.platformRuleMatchedKeywords : [],
        languageRuleProfile: job.languageRuleProfile || "",
        languageRuleName: job.languageRuleName || "",
        languageRuleFile: job.languageRuleFile || "",
        languageRuleVersion: job.languageRuleVersion || "",
        languageRuleReason: job.languageRuleReason || "",
        languageRuleMatchedKeywords: Array.isArray(job.languageRuleMatchedKeywords) ? job.languageRuleMatchedKeywords : [],
        generationRuleProfile: job.generationRuleProfile || "",
        generationRuleName: job.generationRuleName || "",
        generationRuleFile: job.generationRuleFile || "",
        generationRuleVersion: job.generationRuleVersion || "",
        generationRuleReason: job.generationRuleReason || "",
        generationRuleMatchedKeywords: Array.isArray(job.generationRuleMatchedKeywords) ? job.generationRuleMatchedKeywords : [],
        submittedAtLocal: job.submittedAtLocal || formatBeijingDateTime(job.createdAt),
        filesDeletedAt: job.filesDeletedAt || "",
        status: job.status,
        message: job.message,
        progress: job.progress || null,
        timing: job.timing || null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        output: job.output || null,
        log: trimLog(job.log || ""),
        events: Array.isArray(job.events) ? job.events.slice(-80) : [],
      })),
  };
  await fs.mkdir(taskRoot, { recursive: true });
  await fs.writeFile(taskStorePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function trimLog(value, maxLength = 120_000) {
  const raw = String(value || "");
  return raw.length > maxLength ? raw.slice(raw.length - maxLength) : raw;
}

function ingestWorkflowProgress(job, chunk) {
  job.progressLogBuffer = `${job.progressLogBuffer || ""}${String(chunk || "")}`.slice(-12_000);
  const progress = parseNativeProgressLines(job.progressLogBuffer);
  if (!progress) return;
  const previousStage = job.progress?.stage;
  job.progress = progress;
  job.message = progress.message;
  job.timing = {
    ...(job.timing || {}),
    ...(progress.firstPreviewAt && !job.timing?.firstPreviewAt
      ? { firstPreviewAt: progress.firstPreviewAt, firstPreviewElapsedMs: progress.firstPreviewElapsedMs || 0 }
      : {}),
  };
  if (previousStage !== progress.stage) {
    addJobEvent(job, `progress-${progress.stage}`, progress.message, {
      stage: progress.stage,
      completed: progress.completed,
      total: progress.total,
      concurrency: progress.concurrency,
    });
  }
}

function previewText(value, maxLength = 520) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

async function promptInfoForJob(job) {
  const storedPrompt = fullPromptTextFromJob(job);
  if (storedPrompt) {
    return { available: true, source: promptSourceForJob(job), length: storedPrompt.length };
  }
  const recoveredPrompt = await readTaskPromptFile(job);
  return {
    available: Boolean(recoveredPrompt),
    source: recoveredPrompt ? "material-template" : "",
    length: recoveredPrompt.length,
  };
}

function fullPromptTextFromJob(job) {
  return validPromptText(job.finalBriefText) || validPromptText(job.expandedBriefText) || validPromptText(job.rawBriefText);
}

function promptSourceForJob(job) {
  if (validPromptText(job.finalBriefText)) return "final-brief";
  if (validPromptText(job.expandedBriefText)) return "expanded-brief";
  if (validPromptText(job.rawBriefText)) return "raw-brief";
  return "";
}

function validPromptText(value) {
  const clean = text(value);
  if (!clean || isTruncatedPreviewText(clean)) return "";
  return clean;
}

function isTruncatedPreviewText(value) {
  const clean = String(value || "").trim();
  return clean.endsWith("...") && !/[\r\n]/.test(clean);
}

async function readTaskPromptFile(job) {
  for (const dir of taskPromptDirectoryCandidates(job)) {
    const fileNames = await taskPromptFileCandidates(job, dir);
    for (const fileName of fileNames) {
      const filePath = path.join(dir, fileName);
      if (!isInside(dir, filePath)) continue;
      const promptText = validPromptText(await fs.readFile(filePath, "utf8").catch(() => ""));
      if (promptText) return promptText;
    }
  }
  return "";
}

function taskPromptDirectoryCandidates(job) {
  const candidates = [
    job.materialDir,
    job.inputFolderName ? path.join(inputRoot, job.inputFolderName) : "",
    job.outputFolderName ? path.join(inputRoot, job.outputFolderName) : "",
    job.outputId ? path.join(inputRoot, job.outputId) : "",
    job.productName ? path.join(inputRoot, job.productName) : "",
  ];
  const unique = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const absolute = path.isAbsolute(candidate) ? candidate : path.join(rootDir, candidate);
    if (!isInside(rootDir, absolute)) continue;
    unique.add(path.resolve(absolute));
  }
  return [...unique];
}

async function taskPromptFileCandidates(job, dir) {
  const fromJob = (Array.isArray(job.materialFiles) ? job.materialFiles : [])
    .filter((name) => promptFileExtensions.has(path.extname(String(name)).toLowerCase()))
    .map((name) => path.basename(String(name)));
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const fromDisk = entries
    .filter((entry) => entry.isFile() && promptFileExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);
  return [...new Set([...fromJob, ...fromDisk])];
}

function buildStructuredBriefInput({ productName = "", targetPlatform = "", outputLanguage = "", suiteRatio = fixedSuiteRatio, briefFocus = "" }) {
  return [
    "结构化作图输入：",
    productName ? `产品名称：${productName}` : "",
    targetPlatform ? `目标平台：${targetPlatform}` : "",
    outputLanguage ? `输出语言：${outputLanguage}` : "",
    suiteRatio ? `套图比例：${suiteRatio}` : "",
    briefFocus ? `用户作图重点：\n${briefFocus}` : "",
  ].filter(Boolean).join("\n");
}

function normalizeTargetPlatform(value) {
  const clean = text(value);
  if (!clean) return "";
  if (/amazon|亚马逊/i.test(clean)) return "Amazon";
  if (/淘宝|天猫|tmall|taobao/i.test(clean)) return "淘宝/天猫";
  if (/国内|通用/i.test(clean)) return "国内通用";
  return clean;
}

function normalizeOutputLanguage(value) {
  const clean = text(value);
  if (!clean) return "";
  if (/english|英文|英语/i.test(clean)) return "English";
  if (/中文|简体|chinese|zh/i.test(clean)) return "简体中文";
  return clean;
}

async function handleCreateJob(req, res) {
  if (activeJobId) {
    return sendJson(res, 409, { error: "当前已有任务在运行，请等待完成后再提交。", activeJobId });
  }

  const submissionClient = getRequestClient(req);
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half",
  });
  const form = await request.formData();
  const references = form.getAll("referenceImages").filter((item) => item && typeof item === "object");
  const template = form.get("template");
  const briefText = text(form.get("briefText"));
  const briefFocus = text(form.get("briefFocus")) || briefText;
  const submittedProductName = text(form.get("productName"));
  const submittedTargetPlatform = normalizeTargetPlatform(text(form.get("targetPlatform")));
  const submittedOutputLanguage = normalizeOutputLanguage(text(form.get("outputLanguage")));
  const suiteRatio = text(form.get("suiteRatio")) || fixedSuiteRatio;
  const shouldExpandBrief = text(form.get("expandBrief")) !== "false";
  if (!references.length) return sendJson(res, 400, { error: "请至少上传一张参考图。" });
  if ((!template || typeof template !== "object") && !briefFocus && !submittedProductName) {
    return sendJson(res, 400, { error: "请填写产品名称、上传需求模板，或在文本框里输入作图重点。" });
  }

  const templateText = template && typeof template === "object" ? await template.text() : "";
  const templateName = template && typeof template === "object" ? template.name : "";
  const referenceNames = references.map((file) => file.name).filter(Boolean);
  const structuredInput = buildStructuredBriefInput({
    productName: submittedProductName,
    targetPlatform: submittedTargetPlatform,
    outputLanguage: submittedOutputLanguage,
    suiteRatio,
    briefFocus,
  });
  const rawBriefText = [templateText, structuredInput].filter(Boolean).join("\n\n");
  const generationRule = await selectGenerationRule(rootDir, [
    rawBriefText,
    templateName,
    referenceNames.join("\n")
  ].filter(Boolean).join("\n\n"), {
    targetPlatform: submittedTargetPlatform,
    outputLanguage: submittedOutputLanguage,
  });
  const fallbackProductName =
    submittedProductName ||
    inferProductName({ rawBriefText, referenceNames }) ||
    (templateName ? stripExtension(templateName) : "") ||
    `前端任务-${Date.now()}`;
  const expansionResult = shouldExpandBrief
    ? await withTimeout(
        expandDemandBrief(rawBriefText, {
          fallbackProductName,
          referenceNames,
          generationRule,
        }),
        briefSubmitTimeoutMs(),
        "brief expansion timeout",
      ).catch((error) => createBriefFallbackResult({
        fallback: defaultDemandBrief({ productName: fallbackProductName, rawBriefText, referenceNames, generationRule }),
        source: "safe-fallback",
        reasonCode: "submit_timeout",
        reasonMessage: "提交任务时文本模型处理超时，已使用本地智能模板。",
        error,
      }))
    : {
      text: rawBriefText,
      source: "user-confirmed",
      fallbackReason: "",
      diagnostics: createBriefDiagnostics({ source: "user-confirmed", status: "user-confirmed" }),
    };
  const expandedBrief = typeof expansionResult === "string"
    ? expansionResult
    : String(expansionResult?.text || "").trim();
  const productName = safeSegment(inferProductName({
    rawBriefText: expandedBrief,
    productName: fallbackProductName,
    referenceNames,
  }));
  const createdAt = new Date().toISOString();
  const jobId = createTaskId(createdAt);
  const submittedAtLocal = formatBeijingDateTime(createdAt);
  const taskFolderName = safeSegment(`${jobId}_${productName}`);
  const materialDir = path.join(inputRoot, taskFolderName);
  const stagingMaterialDir = path.join(inputRoot, `.staging-${jobId}`);
  const outputDir = path.join(outputRoot, taskFolderName);
  const finalBriefText = expandedBrief || defaultDemandBrief({ productName, rawBriefText, referenceNames, generationRule });
  const visibleProductName = extractBriefField(finalBriefText, ["可见展示名", "展示名", "visible product name", "display name"]) || inferVisibleProductName({
    rawBriefText: finalBriefText || rawBriefText,
    productName: submittedProductName || fallbackProductName || productName,
    productImageAnalysis: "",
    outputLanguage: generationRule.outputLanguage,
  });
  try {
    await resetDirectory(stagingMaterialDir);
    await fs.writeFile(path.join(stagingMaterialDir, "需求模板.md"), finalBriefText);
  } catch (error) {
    await fs.rm(stagingMaterialDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    return sendJson(res, 500, {
      error: `Failed to prepare task materials: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const metadata = {
    id: jobId,
    taskId: jobId,
    productName,
    inputFolderName: taskFolderName,
    outputFolderName: taskFolderName,
    materialDir: path.relative(rootDir, materialDir),
    outputDir: path.relative(rootDir, outputDir),
    submittedAt: createdAt,
    submittedAtLocal,
    originalProductName: submittedProductName || fallbackProductName || productName,
    visibleProductName,
    targetPlatform: extractBriefField(finalBriefText, ["目标平台", "平台", "target platform", "platform"]) || generationRule.targetPlatform,
    outputLanguage: extractBriefField(finalBriefText, ["输出语言", "language"]) || generationRule.outputLanguage,
    suiteRatio,
    briefFocus,
    submissionClient,
    briefDiagnostics: expansionResult.diagnostics || null,
    briefFallbackReason: expansionResult.fallbackReason || "",
    commonRuleProfile: generationRule.commonRuleProfile,
    commonRuleName: generationRule.commonRuleName,
    commonRuleFile: generationRule.commonRuleFile,
    commonRulePath: generationRule.commonRulePath,
    commonRuleVersion: generationRule.commonRuleVersion,
    commonRuleReason: generationRule.commonRuleReason,
    commonRuleMatchedKeywords: generationRule.commonRuleMatchedKeywords,
    commonRuleText: generationRule.commonRuleText,
    platformRuleProfile: generationRule.platformRuleProfile,
    platformRuleName: generationRule.platformRuleName,
    platformRuleFile: generationRule.platformRuleFile,
    platformRulePath: generationRule.platformRulePath,
    platformRuleVersion: generationRule.platformRuleVersion,
    platformRuleReason: generationRule.platformRuleReason,
    platformRuleMatchedKeywords: generationRule.platformRuleMatchedKeywords,
    platformRuleText: generationRule.platformRuleText,
    languageRuleProfile: generationRule.languageRuleProfile,
    languageRuleName: generationRule.languageRuleName,
    languageRuleFile: generationRule.languageRuleFile,
    languageRulePath: generationRule.languageRulePath,
    languageRuleVersion: generationRule.languageRuleVersion,
    languageRuleReason: generationRule.languageRuleReason,
    languageRuleMatchedKeywords: generationRule.languageRuleMatchedKeywords,
    languageRuleText: generationRule.languageRuleText,
    generationRuleProfile: generationRule.ruleProfile,
    generationRuleName: generationRule.ruleName,
    generationRuleFile: generationRule.ruleFile,
    generationRulePath: generationRule.rulePath,
    generationRuleVersion: generationRule.ruleVersion,
    generationRuleReason: generationRule.ruleReason,
    generationRuleMatchedKeywords: generationRule.matchedKeywords,
    generationRuleDecisionFile: generationRule.decisionFile,
    generationRuleText: generationRule.ruleText,
    briefSource: shouldExpandBrief ? expansionResult.source || "auto-expanded" : "user-confirmed",
    templateName,
    referenceNames,
  };
  try {
    await fs.writeFile(path.join(stagingMaterialDir, taskMetadataFilename), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  } catch (error) {
    await fs.rm(stagingMaterialDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    return sendJson(res, 500, {
      error: `Failed to save task metadata: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const materialFiles = ["需求模板.md", taskMetadataFilename];
  try {
    for (const [index, file] of references.entries()) {
      const extension = imageExtensions.has(path.extname(file.name).toLowerCase())
        ? path.extname(file.name).toLowerCase()
        : ".png";
      const filename = safeFilename(file.name) || `参考图${index + 1}${extension}`;
      await fs.writeFile(path.join(stagingMaterialDir, filename), Buffer.from(await file.arrayBuffer()));
      materialFiles.push(filename);
    }
  } catch (error) {
    await fs.rm(stagingMaterialDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    return sendJson(res, 500, {
      error: `Failed to save task references: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  await fs.rm(materialDir, { recursive: true, force: true });
  try {
    await fs.rename(stagingMaterialDir, materialDir);
  } catch (error) {
    await fs.rm(stagingMaterialDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(materialDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    return sendJson(res, 500, {
      error: `Failed to finalize task materials: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const job = {
    id: jobId,
    taskId: jobId,
    kind: "generation",
    productName,
    outputId: taskFolderName,
    inputFolderName: taskFolderName,
    outputFolderName: taskFolderName,
    materialDir,
    outputDir,
    materialFiles,
    referenceCount: references.length,
    referenceNames,
    briefSource: expansionResult.source || (shouldExpandBrief ? "auto-expanded" : "user-confirmed"),
    briefPreview: previewText(finalBriefText || rawBriefText || ""),
    templateName,
    rawBriefText,
    expandedBriefText: expandedBrief || "",
    finalBriefText,
    originalProductName: submittedProductName || fallbackProductName || productName,
    visibleProductName,
    targetPlatform: generationRule.targetPlatform,
    outputLanguage: generationRule.outputLanguage,
    suiteRatio,
    briefFocus,
    submissionClient,
    briefDiagnostics: expansionResult.diagnostics || null,
    briefFallbackReason: expansionResult.fallbackReason || "",
    commonRuleProfile: generationRule.commonRuleProfile,
    commonRuleName: generationRule.commonRuleName,
    commonRuleFile: generationRule.commonRuleFile,
    commonRuleVersion: generationRule.commonRuleVersion,
    commonRuleReason: generationRule.commonRuleReason,
    commonRuleMatchedKeywords: generationRule.commonRuleMatchedKeywords,
    platformRuleProfile: generationRule.platformRuleProfile,
    platformRuleName: generationRule.platformRuleName,
    platformRuleFile: generationRule.platformRuleFile,
    platformRuleVersion: generationRule.platformRuleVersion,
    platformRuleReason: generationRule.platformRuleReason,
    platformRuleMatchedKeywords: generationRule.platformRuleMatchedKeywords,
    languageRuleProfile: generationRule.languageRuleProfile,
    languageRuleName: generationRule.languageRuleName,
    languageRuleFile: generationRule.languageRuleFile,
    languageRuleVersion: generationRule.languageRuleVersion,
    languageRuleReason: generationRule.languageRuleReason,
    languageRuleMatchedKeywords: generationRule.languageRuleMatchedKeywords,
    generationRuleProfile: generationRule.ruleProfile,
    generationRuleName: generationRule.ruleName,
    generationRuleFile: generationRule.ruleFile,
    generationRuleVersion: generationRule.ruleVersion,
    generationRuleReason: generationRule.ruleReason,
    generationRuleMatchedKeywords: generationRule.matchedKeywords,
    status: "queued",
    message: "任务已提交，等待本地工作流启动。",
    progress: { stage: "planning", message: "任务已提交，正在等待工作流启动。", total: 13, completed: 0, mainCompleted: 0, detailCompleted: 0, retries: 0, backpressureCount: 0, concurrency: 0, updatedAt: createdAt },
    timing: { workflowStartedAt: "", firstPreviewAt: "", firstPreviewElapsedMs: 0 },
    createdAt,
    updatedAt: createdAt,
    submittedAtLocal,
    output: null,
    log: "",
    events: [],
  };
  addJobEvent(job, "queued", "任务已提交，素材和需求模板已保存。", {
    productName,
    referenceCount: references.length,
    commonRuleName: generationRule.commonRuleName,
    platformRuleName: generationRule.platformRuleName,
    languageRuleName: generationRule.languageRuleName,
    generationRuleName: generationRule.ruleName,
    generationRuleReason: generationRule.ruleReason,
  });
  jobs.set(jobId, job);
  try {
    await persistTasks();
  } catch (error) {
    jobs.delete(jobId);
    await fs.rm(materialDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(stagingMaterialDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    return sendJson(res, 500, {
      error: `Failed to persist task record: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  activeJobId = jobId;
  console.log(`[api/jobs] task queued id=${jobId} product=${productName}`);
  runWorkflow(job);
  sendJson(res, 202, job);
}

function handleGetJob(url, res) {
  const jobId = decodeURIComponent(url.pathname.replace("/api/jobs/", ""));
  const job = jobs.get(jobId);
  if (!job) return sendJson(res, 404, { error: "任务不存在。" });
  sendJson(res, 200, job);
}

async function handleListTasks(res) {
  const jobsToSummarize = [...jobs.values()];
  await Promise.all(jobsToSummarize.map((job) => reconcileTaskFromOutput(job)));
  const tasks = await Promise.all(jobsToSummarize.map((job) => taskSummary(job)));
  tasks.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  sendJson(res, 200, { tasks, activeJobId });
}

async function handleGetTask(url, res) {
  const jobId = decodeURIComponent(url.pathname.replace("/api/tasks/", ""));
  const job = jobs.get(jobId);
  await reconcileTaskFromOutput(job);
  if (!job) return sendJson(res, 404, { error: "任务不存在。" });
  sendJson(res, 200, await taskDetail(job));
}

async function reconcileTaskFromOutput(job) {
  if (!job) return false;
  const completedStatus = String.fromCodePoint(0x5df2, 0x5b8c, 0x6210);
  const recoveredPrompt = await readTaskPromptFile(job);
  const candidates = outputDirectoriesForJob(job);
  for (const candidate of candidates) {
    const outputId = path.basename(candidate);
    if (!outputId) continue;
    const output = await describeOutput(outputId);
    if (!output || output.status !== completedStatus || !hasVisibleOutput(output)) continue;
    const alreadySynced = job.status === "done" && job.output?.id === output.id;
    job.output = output;
    job.outputId = output.id;
    job.outputFolderName = output.folderName;
    job.outputDir = output.outputDir;
    if (!alreadySynced) {
      job.status = "done";
      job.message = output.status;
      job.error = "";
      addJobEvent(job, "output-reconciled", "Output folder reconciled with task state.", { outputId });
    }
    if (recoveredPrompt && recoveredPrompt !== fullPromptTextFromJob(job)) {
      job.finalBriefText = recoveredPrompt;
      job.expandedBriefText = recoveredPrompt;
      job.briefPreview = previewText(recoveredPrompt);
      job.briefSource = "material-template";
      schedulePersistTasks();
    }
    return true;
  }
  return false;
}

async function handleDeleteTask(url, res) {
  const jobId = decodeURIComponent(url.pathname.replace("/api/tasks/", ""));
  const job = jobs.get(jobId);
  if (!job) return sendJson(res, 404, { error: "任务不存在。" });
  if (activeJobId === job.id || ["submitting", "queued", "running"].includes(job.status)) {
    return sendJson(res, 409, { error: "这个任务正在生成中，完成后再删除。" });
  }

  const deleted = [];
  const inputCandidates = inputDirectoriesForJob(job);
  const outputCandidates = outputDirectoriesForJob(job);

  for (const inputDir of inputCandidates) {
    const removed = await removeDirectoryInside(inputRoot, inputDir);
    if (removed) deleted.push("input");
  }
  for (const outputDir of outputCandidates) {
    const removed = await removeDirectoryInside(outputRoot, outputDir);
    if (removed) deleted.push("output");
  }

  jobs.delete(job.id);
  await persistTasks();
  sendJson(res, 200, { ok: true, taskId: job.id, deleted: [...new Set([...deleted, "task"])] });
}

async function handleCreateBriefExpansion(req, res) {
  const submissionClient = getRequestClient(req);
  console.log(`[api/brief-expansions] submission received at ${new Date().toISOString()} client=${submissionClient.address} host=${submissionClient.host}`);
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half",
  });
  const form = await request.formData();
  const references = form.getAll("referenceImages").filter((item) => item && typeof item === "object");
  const template = form.get("template");
  const briefText = text(form.get("briefText"));
  const briefFocus = text(form.get("briefFocus")) || briefText;
  const submittedProductName = text(form.get("productName"));
  const submittedTargetPlatform = normalizeTargetPlatform(text(form.get("targetPlatform")));
  const submittedOutputLanguage = normalizeOutputLanguage(text(form.get("outputLanguage")));
  const suiteRatio = text(form.get("suiteRatio")) || fixedSuiteRatio;
  if (!references.length) return sendJson(res, 400, { error: "请先上传产品图片。" });

  const templateText = template && typeof template === "object" ? await template.text() : "";
  const referenceNames = references.map((file) => file.name).filter(Boolean);
  const templateName = template && typeof template === "object" ? template.name : "";
  const structuredInput = buildStructuredBriefInput({
    productName: submittedProductName,
    targetPlatform: submittedTargetPlatform,
    outputLanguage: submittedOutputLanguage,
    suiteRatio,
    briefFocus,
  });
  const rawBriefText = [
    templateText ? `用户上传模板：${templateName || "未命名模板"}\n${templateText}` : "",
    structuredInput || "用户当前输入：请根据产品图片和文件名自行分析。",
  ].filter(Boolean).join("\n\n");
  const generationRule = await selectGenerationRule(rootDir, [
    rawBriefText,
    templateName,
    referenceNames.join("\n")
  ].filter(Boolean).join("\n\n"), {
    targetPlatform: submittedTargetPlatform,
    outputLanguage: submittedOutputLanguage,
  });
  const fallbackProductName =
    submittedProductName ||
    inferProductName({ rawBriefText, referenceNames }) ||
    (templateName ? stripExtension(templateName) : "") ||
    `AI扩写-${Date.now()}`;
  const jobId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const job = {
    id: jobId,
    status: "queued",
    message: "扩写任务已提交，等待 AI 整理需求。",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    snapshot: {
      briefText,
      templateName,
      referenceNames,
      fallbackProductName,
      targetPlatform: generationRule.targetPlatform,
      outputLanguage: generationRule.outputLanguage,
      suiteRatio,
      briefFocus,
      commonRuleName: generationRule.commonRuleName,
      platformRuleName: generationRule.platformRuleName,
      languageRuleName: generationRule.languageRuleName,
      generationRuleName: generationRule.ruleName,
      generationRuleFile: generationRule.ruleFile,
      generationRuleReason: generationRule.ruleReason,
      submissionClient,
    },
    generationRuleProfile: generationRule.ruleProfile,
    generationRuleName: generationRule.ruleName,
    generationRuleFile: generationRule.ruleFile,
    generationRuleVersion: generationRule.ruleVersion,
    generationRuleReason: generationRule.ruleReason,
    generationRuleMatchedKeywords: generationRule.matchedKeywords,
    commonRuleProfile: generationRule.commonRuleProfile,
    commonRuleName: generationRule.commonRuleName,
    commonRuleFile: generationRule.commonRuleFile,
    commonRuleVersion: generationRule.commonRuleVersion,
    commonRuleReason: generationRule.commonRuleReason,
    commonRuleMatchedKeywords: generationRule.commonRuleMatchedKeywords,
    platformRuleProfile: generationRule.platformRuleProfile,
    platformRuleName: generationRule.platformRuleName,
    platformRuleFile: generationRule.platformRuleFile,
    platformRuleVersion: generationRule.platformRuleVersion,
    platformRuleReason: generationRule.platformRuleReason,
    platformRuleMatchedKeywords: generationRule.platformRuleMatchedKeywords,
    languageRuleProfile: generationRule.languageRuleProfile,
    languageRuleName: generationRule.languageRuleName,
    languageRuleFile: generationRule.languageRuleFile,
    languageRuleVersion: generationRule.languageRuleVersion,
    languageRuleReason: generationRule.languageRuleReason,
    languageRuleMatchedKeywords: generationRule.languageRuleMatchedKeywords,
    imageAnalysis: "",
    resultText: "",
    error: "",
    submissionClient,
    diagnostics: createBriefDiagnostics({ source: "pending", status: "queued" }),
  };
  briefExpansionJobs.set(jobId, job);
  runBriefExpansion(job, rawBriefText, references, {
    fallbackProductName,
    referenceNames,
    generationRule,
    submissionClient,
  });
  sendJson(res, 202, job);
}

function handleGetBriefExpansion(url, res) {
  const jobId = decodeURIComponent(url.pathname.replace("/api/brief-expansions/", ""));
  const job = briefExpansionJobs.get(jobId);
  if (!job) return sendJson(res, 404, { error: "扩写任务不存在。" });
  sendJson(res, 200, job);
}

async function runBriefExpansion(job, rawBriefText, references, context) {
  job.status = "running";
  job.message = "AI 正在识别产品图特征。";
  job.updatedAt = new Date().toISOString();
  try {
    const imageAnalysis = await analyzeProductImages(references, context);
    job.imageAnalysis = imageAnalysis;
    const identityConflict = detectProductIdentityConflict({
      productName: context.fallbackProductName,
      productImageAnalysis: imageAnalysis,
    });
    if (identityConflict.conflicts) throw new Error(identityConflict.message);
    job.message = "AI 正在把图片特征和输入重点整理成完整作图需求。";
    job.updatedAt = new Date().toISOString();
    const expansion = await expandDemandBrief(rawBriefText, {
      ...context,
      productImageAnalysis: imageAnalysis,
    });
    job.resultText = expansion.text;
    job.expansionSource = expansion.source;
    job.fallbackReason = expansion.fallbackReason || "";
    job.diagnostics = expansion.diagnostics || createBriefDiagnostics({ source: expansion.source || "unknown", status: "done" });
    job.status = "done";
    job.message = expansion.source === "model"
      ? "模型扩写完成，可以检查后使用。"
      : "模型结果不可用，已生成可编辑的本地智能模板。";
    console.log(`[api/brief-expansions] completed id=${job.id} source=${job.expansionSource} reason=${job.diagnostics.reasonCode || "none"} attempts=${job.diagnostics.attempts || 0}`);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.diagnostics = createBriefDiagnostics({
      source: "failed",
      status: "failed",
      reasonCode: "local_validation_failed",
      reasonMessage: "本地安全模板也未通过完整性校验，请检查产品名称和卖点后重试。",
      error,
    });
    job.message = "AI 扩写失败，请稍后重试。";
    console.warn(`[api/brief-expansions] failed id=${job.id} reason=${job.diagnostics.reasonCode}`);
  } finally {
    job.updatedAt = new Date().toISOString();
  }
}

async function handleListExamples(res) {
  const definitions = await readExampleDefinitions();
  const examples = [];
  for (const definition of definitions) {
    const example = await describeExample(definition, { includeTemplate: false });
    if (example) examples.push(example);
  }
  sendJson(res, 200, { examples });
}

async function handleGetExample(url, res) {
  const id = decodeURIComponent(url.pathname.replace("/api/examples/", ""));
  const definitions = await readExampleDefinitions();
  const definition = definitions.find((item) => item.id === id);
  if (!definition) return sendJson(res, 404, { error: "未找到这个优秀案例。" });
  const example = await describeExample(definition, { includeTemplate: true });
  if (!example) return sendJson(res, 404, { error: "优秀案例素材不存在或配置不完整。" });
  sendJson(res, 200, example);
}

async function handleExampleAsset(url, res) {
  const parts = url.pathname
    .replace("/example-assets/", "")
    .split("/")
    .map((part) => decodeURIComponent(part))
    .filter(Boolean);
  const [id, group, rawIndex] = parts;
  const index = Number(rawIndex || 0);
  const definitions = await readExampleDefinitions();
  const definition = definitions.find((item) => item.id === id);
  const asset = definition ? exampleAssetDefinition(definition, group, index) : null;
  if (!asset?.path) return sendJson(res, 404, { error: "未找到案例图片。" });
  const absolute = resolveProjectAssetPath(asset.path);
  if (!absolute) return sendJson(res, 403, { error: "Forbidden" });
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) return sendJson(res, 404, { error: "File not found" });
  res.writeHead(200, { "Content-Type": contentType(absolute), "Cache-Control": "no-store" });
  createReadStream(absolute).pipe(res);
}

async function handleListOutputs(res) {
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => []);
  const outputs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const productName = entry.name;
    const output = await describeOutput(productName);
    if (output && output.materialExists && hasVisibleOutput(output)) outputs.push(output);
  }
  outputs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  sendJson(res, 200, { outputs });
}

function hasVisibleOutput(output) {
  return Boolean(
    output.files.main.length ||
      output.files.detail.length ||
      output.files.mainOverview ||
      output.files.detailOverview ||
      output.files.longDetail
  );
}

function inputDirectoriesForJob(job) {
  return directoryCandidates(inputRoot, [
    job.materialDir,
    job.inputFolderName,
    job.outputFolderName,
    job.outputId,
    job.output?.id,
    job.output?.folderName,
    job.productName,
  ]);
}

function outputDirectoriesForJob(job) {
  return directoryCandidates(outputRoot, [
    job.outputDir,
    job.outputFolderName,
    job.outputId,
    job.output?.id,
    job.output?.folderName,
    job.inputFolderName,
    job.productName,
  ]);
}

function directoryCandidates(baseRoot, values) {
  const candidates = new Set();
  for (const value of values) {
    const raw = text(value);
    if (!raw) continue;
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootDir, raw);
    if (isInside(baseRoot, resolved)) candidates.add(resolved);
    const named = path.resolve(baseRoot, path.basename(raw));
    if (isInside(baseRoot, named)) candidates.add(named);
  }
  return [...candidates];
}

async function removeDirectoryInside(baseRoot, dir) {
  const absolute = path.resolve(dir);
  if (!isInside(baseRoot, absolute)) return false;
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isDirectory()) return false;
  await fs.rm(absolute, { recursive: true, force: true });
  return true;
}

async function handleGetOutput(url, res) {
  const outputId = decodeURIComponent(url.pathname.replace("/api/outputs/", ""));
  const output = await describeOutput(outputId);
  if (!output || !output.materialExists) return sendJson(res, 404, { error: "未找到待作图和已完成同名的成品图。" });
  sendJson(res, 200, output);
}

async function handleDeleteOutput(url, res) {
  const outputId = decodeURIComponent(url.pathname.replace("/api/outputs/", ""));
  const activeJob = activeJobId ? jobs.get(activeJobId) : null;
  if (activeJob && jobMatchesOutputId(activeJob, outputId)) {
    return sendJson(res, 409, { error: "这个商品正在生成中，完成后再删除。" });
  }
  const output = await describeOutput(outputId);
  const outputDir = path.resolve(outputRoot, outputId);
  if (!isInside(outputRoot, outputDir)) return sendJson(res, 403, { error: "Forbidden" });
  const outputStat = await fs.stat(outputDir).catch(() => null);
  if (!outputStat?.isDirectory()) return sendJson(res, 404, { error: "未找到要删除的已完成作品。" });

  const matchedJobs = [...jobs.values()].filter((job) => jobMatchesOutputId(job, outputId));
  const inputCandidates = new Set();
  for (const job of matchedJobs) {
    if (job.materialDir) inputCandidates.add(path.resolve(job.materialDir));
  }
  if (output?.materialDir) inputCandidates.add(path.resolve(rootDir, output.materialDir));
  inputCandidates.add(path.resolve(inputRoot, outputId));

  const deleted = [];
  await fs.rm(outputDir, { recursive: true, force: true });
  deleted.push("output");
  for (const inputDir of inputCandidates) {
    if (!isInside(inputRoot, inputDir)) continue;
    const inputStat = await fs.stat(inputDir).catch(() => null);
    if (!inputStat?.isDirectory()) continue;
    await fs.rm(inputDir, { recursive: true, force: true });
    deleted.push("input");
  }
  for (const job of jobs.values()) {
    if (!jobMatchesOutputId(job, outputId)) continue;
    job.output = null;
    job.filesDeletedAt = new Date().toISOString();
    job.message = "这个任务的待作图素材和已完成作品已被删除，历史提示词仍保留。";
    addJobEvent(job, "task-files-deleted", "用户删除了这个任务对应的待作图素材和已完成作品。", { outputId, deleted });
  }
  schedulePersistTasks();
  sendJson(res, 200, { ok: true, outputId, deleted });
}

async function handleDownloadSelection(req, url, res) {
  const prefix = "/api/outputs/";
  const suffix = "/download";
  const outputId = decodeURIComponent(url.pathname.slice(prefix.length, -suffix.length));
  const dir = path.resolve(outputRoot, outputId);
  if (!isInside(outputRoot, dir)) return sendJson(res, 403, { error: "Forbidden" });
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) return sendJson(res, 404, { error: "未找到这个商品的已完成作品。" });

  const body = await readJsonBody(req);
  const requestedItems = Array.isArray(body?.items) ? body.items.map((item) => String(item)) : [];
  const ids = [...new Set(requestedItems)].filter(Boolean);
  if (!ids.length) return sendJson(res, 400, { error: "请至少选择一张图片。" });

  const catalog = await outputResourceCatalog(outputId);
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const selected = [];
  const missing = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) selected.push(item);
    else missing.push(id);
  }
  if (missing.length) {
    return sendJson(res, 400, { error: `选择的资源不存在：${missing.slice(0, 5).join("，")}` });
  }

  const archiveFiles = selected.map((item) => ({
    filePath: item.filePath,
    archiveName: item.archiveName,
  }));
  const zip = await createZipBuffer(archiveFiles);
  const output = await describeOutput(outputId);
  const filename = `${outputDisplayName(output || { id: outputId, productName: outputId })}-选中成品图.zip`;
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
  });
  res.end(zip);
}

async function handleOutputFile(url, res) {
  const relative = decodeURIComponent(url.pathname.replace("/outputs/", ""));
  const absolute = path.resolve(outputRoot, relative);
  if (!isInside(outputRoot, absolute)) return sendJson(res, 403, { error: "Forbidden" });
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) return sendJson(res, 404, { error: "File not found" });
  res.writeHead(200, { "Content-Type": contentType(absolute), "Cache-Control": "no-store" });
  createReadStream(absolute).pipe(res);
}

async function outputResourceCatalog(outputId) {
  const dir = path.join(outputRoot, outputId);
  const resources = [];
  const main = await outputFilesInGroup(outputId, "main", "主图");
  const detail = await outputFilesInGroup(outputId, "detail", "详情页");
  resources.push(...main, ...detail);

  const overviewFiles = [
    { id: "overview/main", filename: "5张主图总览.jpg", archiveName: "拼接图/5张主图总览.jpg" },
    { id: "overview/detail", filename: "8张详情页总览.jpg", archiveName: "拼接图/8张详情页总览.jpg" },
    { id: "overview/long", filename: "详情页完整长图.jpg", archiveName: "拼接图/详情页完整长图.jpg" },
  ];
  for (const item of overviewFiles) {
    const filePath = path.join(dir, item.filename);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) {
      resources.push({
        id: item.id,
        filePath,
        archiveName: item.archiveName,
      });
    }
  }
  return resources;
}

async function outputFilesInGroup(outputId, group, archiveDir) {
  const dir = path.join(outputRoot, outputId, group);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
    .map((entry) => ({
      id: `${group}/${entry.name}`,
      filePath: path.join(dir, entry.name),
      archiveName: `${archiveDir}/${entry.name}`,
    }))
    .filter((entry) => isInside(outputRoot, entry.filePath));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function runWorkflow(job) {
  try {
    loadDotEnv(path.join(rootDir, ".env"), { override: true });
    job.status = "submitting";
    job.message = "正在检查素材并启动本地工作流。";
    job.updatedAt = new Date().toISOString();
    addJobEvent(job, "submitting", "正在检查素材并启动本地工作流。");
    await validateWorkflowInput(job);
  } catch (error) {
    finishJobAsFailed(job, error instanceof Error ? error.message : String(error), { stage: "preflight" });
    return;
  }

  job.status = "running";
  job.message = "本地工作流运行中，正在生成主图和详情页。";
  job.timing = { ...(job.timing || {}), workflowStartedAt: new Date().toISOString() };
  job.updatedAt = new Date().toISOString();
  addJobEvent(job, "running", "本地工作流已启动，正在生成主图和详情页。");
  const pnpm = createPnpmCommand(["run", "folder"]);
  const child = spawn(pnpm.command, pnpm.args, {
    cwd: rootDir,
    env: {
      ...process.env,
      DROP_INPUT_DIR: "待作图",
      FORCE_REGENERATE: "false",
      LOCAL_IMAGE_TEST_MODE: "false",
      TARGET_TASK_ID: job.taskId || job.id,
      TARGET_TASK_DIR: job.materialDir,
      TARGET_PRODUCT_NAME: job.productName,
    },
    windowsHide: true,
  });

  child.stdout.on("data", (chunk) => {
    const output = chunk.toString();
    job.log = trimLog(job.log + output);
    ingestWorkflowProgress(job, output);
    job.updatedAt = new Date().toISOString();
    schedulePersistTasks();
  });
  child.stderr.on("data", (chunk) => {
    const output = chunk.toString();
    job.log = trimLog(job.log + output);
    ingestWorkflowProgress(job, output);
    job.updatedAt = new Date().toISOString();
    schedulePersistTasks();
  });
  child.on("error", (error) => {
    finishJobAsFailed(job, `本地工作流启动失败：${error.message}`, { stage: "spawn" });
  });
  child.on("close", async (code) => {
    try {
      const outputId = job.outputFolderName || job.outputId || job.productName;
      const output = await describeOutput(outputId);
      job.output = output;
      if (code === 0 && output?.status === "已完成") {
        job.status = "done";
        job.message = "生成完成，可以查看成品图。";
      } else if (code === 0 && output?.status === "部分失败") {
        job.status = "partial";
        job.message = output?.errorMessage
          ? `部分图片生成失败，已保留成功图片。${output.errorMessage}`
          : "部分图片生成失败，已保留成功图片，可以稍后补跑缺失图片。";
      } else {
        job.status = "failed";
        job.message = output?.errorMessage || friendlyWorkflowFailureMessage(job.log, code);
      }
      addJobEvent(job, job.status, job.message, { exitCode: code, productName: job.productName, outputId });
    } catch (error) {
      job.status = "failed";
      job.message = error instanceof Error ? error.message : String(error);
      addJobEvent(job, "failed", job.message, { productName: job.productName, outputId: job.outputFolderName || job.outputId });
    } finally {
      job.updatedAt = new Date().toISOString();
      activeJobId = null;
      schedulePersistTasks();
    }
  });
}

async function validateWorkflowInput(job) {
  const materialDir = path.resolve(job.materialDir || "");
  if (!materialDir || !isInside(inputRoot, materialDir)) throw new Error("任务素材目录不合法，请重新提交任务。");
  const materialStat = await fs.stat(materialDir).catch(() => null);
  if (!materialStat?.isDirectory()) throw new Error("任务素材目录不存在，请重新上传参考图后再生成。");

  const files = await fs.readdir(materialDir, { withFileTypes: true });
  const imageCount = files.filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())).length;
  if (!imageCount) throw new Error("任务素材目录里没有参考图，请至少上传一张产品参考图。");

  const promptCount = files.filter((entry) => entry.isFile() && promptFileExtensions.has(path.extname(entry.name).toLowerCase())).length;
  if (!promptCount) throw new Error("任务素材目录里没有需求模板，请输入作图重点或重新提交任务。");
}

function finishJobAsFailed(job, message, detail = {}) {
  job.status = "failed";
  job.message = message;
  job.updatedAt = new Date().toISOString();
  activeJobId = null;
  addJobEvent(job, "failed", message, { productName: job.productName, outputId: job.outputFolderName || job.outputId, ...detail });
  schedulePersistTasks();
}

function friendlyWorkflowFailureMessage(log, code) {
  const value = String(log || "");
  if (/已有自动化任务正在运行/.test(value)) {
    return "检测到另一个自动化任务正在运行，当前任务没有开始生图。请等待当前任务完成后再提交；如果没有任务在运行，系统会在下次启动时自动清理陈旧锁。";
  }
  if (/检测到陈旧自动化锁，已自动清理/.test(value)) {
    return "系统已清理上次异常中断留下的旧锁，但本次工作流仍未完整完成，请查看任务日志继续定位。";
  }
  if (/Missing required environment variable: OPENAI_API_KEY/.test(value)) return "缺少 OPENAI_API_KEY，请检查本地 API 配置。";
  if (/Missing required environment variable: AIECHO_ACTIVATION_CODE/.test(value)) return "缺少 aiEcho API 密钥，请检查本地 API 配置。";
  if (/IMAGE_PROVIDER must be/.test(value)) return "图片生成服务配置不合法，请检查 IMAGE_PROVIDER。";
  if (/AIECHO_RESOLUTION must be/.test(value)) return "图片分辨率配置不合法，请检查 AIECHO_RESOLUTION。";
  if (/没有待生成任务/.test(value)) return "没有找到待生成任务，请确认本次提交的素材目录和任务 ID 是否正确。";
  return `工作流结束，但任务未完整完成。退出码：${code}`;
}

async function describeOutput(outputId) {
  const dir = path.join(outputRoot, outputId);
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const statusPath = path.join(dir, "folder-status.json");
  const status = await readJson(statusPath);
  const main = await listImages(path.join(dir, "main"), outputId, "main");
  const detail = await listImages(path.join(dir, "detail"), outputId, "detail");
  const materialDir = resolveMaterialDir(status?.materialDir || status?.inputDir || sourceMaterialDirFromStatus(status), outputId);
  const matchedJob = [...jobs.values()].find((job) => jobMatchesOutputId(job, outputId));
  const submittedAt = text(status?.submittedAt) || matchedJob?.createdAt || stat.birthtime.toISOString();
  const productName = text(status?.productName) || matchedJob?.productName || stripTaskFolderPrefix(outputId);
  const materialExists = await directoryExists(materialDir);
  return {
    id: outputId,
    folderName: outputId,
    productName,
    displayName: productName,
    taskId: text(status?.taskId) || matchedJob?.taskId || "",
    submittedAt,
    submittedAtLocal: text(status?.submittedAtLocal) || matchedJob?.submittedAtLocal || formatBeijingDateTime(submittedAt),
    generationRuleProfile: text(status?.generationRuleProfile) || matchedJob?.generationRuleProfile || "",
    generationRuleName: text(status?.generationRuleName) || matchedJob?.generationRuleName || "",
    generationRuleFile: text(status?.generationRuleFile) || matchedJob?.generationRuleFile || "",
    generationRuleVersion: text(status?.generationRuleVersion) || matchedJob?.generationRuleVersion || "",
    generationRuleReason: text(status?.generationRuleReason) || matchedJob?.generationRuleReason || "",
    generationRuleMatchedKeywords: Array.isArray(status?.generationRuleMatchedKeywords)
      ? status.generationRuleMatchedKeywords
      : (Array.isArray(matchedJob?.generationRuleMatchedKeywords) ? matchedJob.generationRuleMatchedKeywords : []),
    materialDir: path.relative(rootDir, materialDir),
    outputDir: path.relative(rootDir, dir),
    materialExists,
    status: status?.status || (main.length || detail.length ? "已完成" : "未知"),
    errorMessage: status?.errorMessage || "",
    updatedAt: status?.updatedAt || stat.mtime.toISOString(),
    report: status?.report || "",
    files: {
      main,
      detail,
      mainOverview: await fileUrlIfExists(outputId, "5张主图总览.jpg"),
      detailOverview: await fileUrlIfExists(outputId, "8张详情页总览.jpg"),
      longDetail: await fileUrlIfExists(outputId, "详情页完整长图.jpg"),
      packageZip: await fileUrlIfExists(outputId, "package.zip"),
    },
  };
}

async function listImages(dir, outputId, group) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
    .map((entry) => ({
      name: entry.name,
      url: `/outputs/${encodeURIComponent(outputId)}/${group}/${encodeURIComponent(entry.name)}`,
    }));
}

async function fileUrlIfExists(outputId, filename) {
  const filePath = path.join(outputRoot, outputId, filename);
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile() ? `/outputs/${encodeURIComponent(outputId)}/${encodeURIComponent(filename)}` : "";
}

async function directoryExists(dir) {
  const stat = await fs.stat(dir).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function readExampleDefinitions() {
  const definitions = await readJson(path.join(exampleRoot, "examples.json"));
  if (!Array.isArray(definitions)) return [];
  return definitions
    .filter((item) => item && typeof item === "object" && typeof item.id === "string")
    .map((item) => ({
      ...item,
      id: safeSegment(item.id).replace(/\s+/g, "-"),
      title: text(item.title) || item.id,
      category: text(item.category) || "优秀案例",
      summary: text(item.summary),
      style: text(item.style),
      tags: Array.isArray(item.tags) ? item.tags.map((tag) => text(tag)).filter(Boolean).slice(0, 8) : [],
      originalImages: Array.isArray(item.originalImages) ? item.originalImages : [],
      resultImages: Array.isArray(item.resultImages) ? item.resultImages : [],
    }));
}

async function describeExample(definition, { includeTemplate }) {
  const coverPath = definition.coverPath || definition.resultImages[0]?.path || definition.originalImages[0]?.path;
  const originalImages = await describeExampleImages(definition, "originalImages", "original");
  const resultImages = await describeExampleImages(definition, "resultImages", "result");
  const coverExists = coverPath ? await projectAssetExists(coverPath) : false;
  if (!coverExists && !originalImages.length && !resultImages.length) return null;

  const example = {
    id: definition.id,
    title: definition.title,
    category: definition.category,
    summary: definition.summary,
    style: definition.style,
    tags: definition.tags,
    counts: {
      original: originalImages.length,
      result: resultImages.length,
    },
    cover: coverExists
      ? {
          name: "案例封面",
          url: exampleAssetUrl(definition.id, "cover", 0),
        }
      : resultImages[0] || originalImages[0] || null,
    originalImages,
    resultImages,
  };

  if (includeTemplate) {
    const templatePath = resolveProjectAssetPath(definition.templatePath);
    const templateText = templatePath ? await fs.readFile(templatePath, "utf8").catch(() => "") : "";
    example.templatePath = definition.templatePath || "";
    example.templateText = templateText;
  }

  return example;
}

async function describeExampleImages(definition, field, group) {
  const images = [];
  for (const [index, image] of definition[field].entries()) {
    if (!image?.path || !(await projectAssetExists(image.path))) continue;
    images.push({
      name: text(image.name) || `图片 ${index + 1}`,
      kind: text(image.kind) || (group === "original" ? "原图" : "成品图"),
      url: exampleAssetUrl(definition.id, group, index),
    });
  }
  return images;
}

function exampleAssetDefinition(definition, group, index) {
  if (group === "cover") {
    const pathValue = definition.coverPath || definition.resultImages[0]?.path || definition.originalImages[0]?.path;
    return pathValue ? { path: pathValue } : null;
  }
  if (group === "original") return definition.originalImages[index] || null;
  if (group === "result") return definition.resultImages[index] || null;
  return null;
}

function exampleAssetUrl(id, group, index) {
  return `/example-assets/${encodeURIComponent(id)}/${encodeURIComponent(group)}/${index}`;
}

async function projectAssetExists(relativePath) {
  const absolute = resolveProjectAssetPath(relativePath);
  if (!absolute) return false;
  const stat = await fs.stat(absolute).catch(() => null);
  return Boolean(stat?.isFile());
}

function resolveProjectAssetPath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const absolute = path.resolve(rootDir, relativePath);
  return isInside(rootDir, absolute) ? absolute : null;
}

async function analyzeProductImages(references, context) {
  const fallback = defaultProductImageAnalysis(context);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return fallback;

  const images = await prepareVisionImages(references.slice(0, 4));
  if (!images.length) return fallback;

  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_TEXT_MODEL || "gpt-5-mini";
  const timeoutMs = Math.max(5000, Number(process.env.OPENAI_VISION_TIMEOUT_MS || 60_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const prompt = [
    "你是电商商品图视觉识别助手。请只根据用户上传的产品图做视觉分析，用中文输出结构化摘要。",
    "目标：帮助后续生成电商图需求模板，重点识别商品主体，不要编造图片里看不到的参数。",
    "必须输出这些小标题：",
    "1. 商品类型与主体",
    "2. 颜色与材质观感",
    "3. 结构与关键识别点",
    "4. 可被画面证明的卖点方向",
    "5. 生成图片时必须避免的误判",
    "注意：不要写具体重量、尺寸、认证、功效、价格、销量、品牌授权，除非图片或用户文字明确提供。",
    `图片文件名：${context.referenceNames.join("；") || "未提供"}`,
    `用户推测产品名：${context.fallbackProductName}`,
  ].join("\n");

  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              ...images.map((image) => ({
                type: "input_image",
                image_url: image.dataUrl,
              })),
            ],
          },
        ],
      }),
    });
    const data = await readOpenAiResponsePayload(response);
    if (!response.ok) throw new Error(extractApiError(data) || `HTTP ${response.status}`);
    const analysis = extractOpenAiText(data).trim();
    if (analysis.length < 40) return fallback;
    return normalizeImageAnalysis(analysis);
  } catch (error) {
    const reason = error?.name === "AbortError" ? `视觉识别超过 ${Math.round(timeoutMs / 1000)} 秒未响应` : "视觉识别接口暂不可用";
    return `${fallback}\n\n识别备注：${reason}，本次扩写会继续根据用户输入和图片文件名整理需求。`;
  } finally {
    clearTimeout(timeout);
  }
}

async function prepareVisionImages(files) {
  const images = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const mimeType = imageMimeType(file);
    if (!mimeType) continue;
    const data = Buffer.from(await file.arrayBuffer());
    if (!data.length) continue;
    images.push({
      name: file.name || "product-image",
      dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
    });
  }
  return images;
}

function imageMimeType(file) {
  const declared = typeof file.type === "string" ? file.type.toLowerCase() : "";
  if (declared.startsWith("image/")) return declared;
  const ext = path.extname(file.name || "").toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "";
}

function defaultProductImageAnalysis(context) {
  return [
    "产品图视觉识别摘要",
    "",
    `图片文件名：${context.referenceNames.join("；") || "未提供"}`,
    `推测产品名称：${context.fallbackProductName || "未命名商品"}`,
    "当前视觉模型不可用或未返回稳定识别结果；本次只能基于图片文件名、用户输入和模板信息整理需求。",
    "生成图片时仍必须以用户上传的产品图为主体参照，保持颜色、结构、比例、材质观感和关键细节稳定，不得编造看不到的参数。",
  ].join("\n");
}

function normalizeImageAnalysis(analysis) {
  let clean = analysis.replace(/^```(?:markdown)?/i, "").replace(/```$/i, "").trim();
  if (!clean.startsWith("产品图视觉识别摘要")) {
    clean = `产品图视觉识别摘要\n\n${clean}`;
  }
  return clean;
}

async function expandDemandBrief(rawBriefText, context) {
  const fallback = defaultDemandBrief({
    productName: context.fallbackProductName,
    rawBriefText,
    referenceNames: context.referenceNames,
    productImageAnalysis: context.productImageAnalysis,
    generationRule: context.generationRule,
  });
  // The fallback is deliberately local and editable. It must never be blocked by the
  // stricter model-output quality gate, otherwise a transient provider issue turns
  // into a user-visible hard failure instead of a recoverable result.
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const provider = briefProviderDescriptor();
  if (!apiKey) {
    return createBriefFallbackResult({
      fallback,
      reasonCode: "missing_api_key",
      reasonMessage: "主机未配置文本模型密钥，已使用基于当前产品身份的本地智能模板。",
      provider,
    });
  }
  const prompt = buildBriefExpansionPrompt(rawBriefText, context, fallback);
  try {
    const response = await requestBriefModel(prompt, apiKey, provider);
    const expanded = response.text;
    const normalizationDiagnostics = { qualityIssues: [], modelOutputLength: 0, modelOutputPreview: "" };
    const normalized = normalizeExpandedBrief(expanded, fallback, { ...context, rawBriefText, normalizationDiagnostics });
    if (normalized === fallback) {
      return createBriefFallbackResult({
        fallback,
        reasonCode: "quality_rejected",
        reasonMessage: normalizationDiagnostics.qualityIssues.length
          ? `模型输出未通过质量校验：${normalizationDiagnostics.qualityIssues.join("；")}`
          : "模型输出未通过产品身份、卖点覆盖或跨品类污染校验，已使用本地智能模板。",
        provider,
        attempts: response.attempts,
        durationMs: response.durationMs,
        qualityIssues: normalizationDiagnostics.qualityIssues,
        modelOutputLength: normalizationDiagnostics.modelOutputLength,
        modelOutputPreview: normalizationDiagnostics.modelOutputPreview,
      });
    }
    return {
      text: normalized,
      source: "model",
      fallbackReason: "",
      diagnostics: createBriefDiagnostics({
        source: "model",
        status: "completed",
        providerHost: provider.providerHost,
        model: provider.model,
        attempts: response.attempts,
        durationMs: response.durationMs,
      }),
    };
  } catch (error) {
    const classified = classifyBriefModelError(error);
    return createBriefFallbackResult({
      fallback,
      reasonCode: classified.code,
      reasonMessage: classified.message,
      provider,
      attempts: Number(error?.attempts || 1),
      durationMs: Number(error?.durationMs || 0),
      error,
    });
  }
}

function briefProviderDescriptor() {
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  let providerHost = "configured-provider";
  try { providerHost = new URL(baseUrl).host || providerHost; } catch {}
  return {
    baseUrl,
    providerHost,
    model: process.env.OPENAI_TEXT_MODEL || "gpt-5-mini",
    timeoutMs: Math.max(3_000, Number(process.env.OPENAI_BRIEF_TIMEOUT_MS || 45_000)),
    maxAttempts: Math.max(1, Math.min(2, Number(process.env.OPENAI_BRIEF_MAX_ATTEMPTS || 2))),
  };
}

function briefSubmitTimeoutMs() {
  const provider = briefProviderDescriptor();
  const configured = Number(process.env.OPENAI_BRIEF_SUBMIT_TIMEOUT_MS || 0);
  const required = provider.timeoutMs * provider.maxAttempts + 12_000;
  return Math.max(10_000, configured || required, required);
}

function createBriefDiagnostics(input = {}) {
  return {
    source: text(input.source) || "pending",
    status: text(input.status) || "pending",
    providerHost: text(input.providerHost),
    model: text(input.model),
    attempts: Math.max(0, Number(input.attempts || 0)),
    durationMs: Math.max(0, Number(input.durationMs || 0)),
    reasonCode: text(input.reasonCode),
    reasonMessage: text(input.reasonMessage).slice(0, 360),
    qualityIssues: Array.isArray(input.qualityIssues) ? input.qualityIssues.map((item) => text(item)).filter(Boolean).slice(0, 12) : [],
    modelOutputLength: Math.max(0, Number(input.modelOutputLength || 0)),
    modelOutputPreview: text(input.modelOutputPreview).slice(0, 600),
    usedFallback: Boolean(input.usedFallback),
    completedAt: text(input.completedAt) || new Date().toISOString(),
  };
}

function normalizeBriefDiagnostics(value) {
  return value && typeof value === "object" ? createBriefDiagnostics(value) : null;
}

function createBriefFallbackResult({ fallback, source = "safe-fallback", reasonCode, reasonMessage, provider = briefProviderDescriptor(), attempts = 0, durationMs = 0, qualityIssues = [], modelOutputLength = 0, modelOutputPreview = "", error = null }) {
  const classified = error ? classifyBriefModelError(error) : null;
  const finalCode = reasonCode || classified?.code || "model_unavailable";
  const finalMessage = reasonMessage || classified?.message || "文本模型暂不可用，已使用本地智能模板。";
  return {
    text: fallback,
    source,
    fallbackReason: finalMessage,
    diagnostics: createBriefDiagnostics({
      source,
      status: "fallback",
      providerHost: provider.providerHost,
      model: provider.model,
      attempts,
      durationMs,
      reasonCode: finalCode,
      reasonMessage: finalMessage,
      qualityIssues,
      modelOutputLength,
      modelOutputPreview,
      usedFallback: true,
    }),
  };
}

async function requestBriefModel(prompt, apiKey, provider) {
  const startedAt = Date.now();
  let lastError = null;
  for (let attempt = 1; attempt <= provider.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs);
    try {
      const response = await fetch(`${provider.baseUrl}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        }),
      });
      const data = await readOpenAiResponsePayload(response);
      if (!response.ok) throw createBriefModelError(response.status, extractApiError(data) || `HTTP ${response.status}`);
      const output = extractOpenAiText(data).trim();
      if (!output) throw createBriefModelError(502, "文本模型未返回可用内容");
      return { text: output, attempts: attempt, durationMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
      const classified = classifyBriefModelError(error);
      if (!classified.retryable || attempt >= provider.maxAttempts) break;
      await briefDelay(700 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  const error = lastError instanceof Error ? lastError : new Error(String(lastError || "文本模型请求失败"));
  error.attempts = provider.maxAttempts;
  error.durationMs = Date.now() - startedAt;
  throw error;
}

function createBriefModelError(httpStatus, message) {
  const error = new Error(message);
  error.httpStatus = Number(httpStatus || 0);
  return error;
}

function classifyBriefModelError(error) {
  const status = Number(error?.httpStatus || error?.status || 0);
  const raw = String(error?.message || error || "文本模型请求失败");
  if (error?.name === "AbortError" || /abort|timeout|timed out/i.test(raw)) {
    return { code: "timeout", message: "文本模型响应超时，已使用本地智能模板。", retryable: true };
  }
  if (status === 401 || status === 403) {
    return { code: "authentication_failed", message: "文本模型鉴权失败，请检查主机模型配置。", retryable: false };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "文本模型暂时限流，已重试后改用本地智能模板。", retryable: true };
  }
  if (status >= 500) {
    return { code: "provider_unavailable", message: "文本模型服务暂时不可用，已重试后改用本地智能模板。", retryable: true };
  }
  if (status >= 400) {
    return { code: "provider_request_rejected", message: "文本模型请求被服务端拒绝，请检查主机模型配置。", retryable: false };
  }
  if (/fetch failed|ECONN|ENOTFOUND|network/i.test(raw)) {
    return { code: "network_error", message: "主机无法连接文本模型服务，已重试后改用本地智能模板。", retryable: true };
  }
  return {
    code: "model_error",
    message: `文本模型结果处理失败：${raw.slice(0, 240)}`,
    retryable: false,
  };
}

function briefDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBriefExpansionPrompt(rawBriefText, context, fallback) {
  const strategy = platformStrategy(rawBriefText, context.generationRule);
  const generationRuleBlock = formatGenerationRuleForBriefPrompt(context.generationRule);
  const productIdentity = inferProductIdentity({
    productName: context.fallbackProductName,
    rawBriefText,
    productImageAnalysis: context.productImageAnalysis,
  });
  const userSeeds = inferBriefSellingPoints({
    productName: context.fallbackProductName,
    rawBriefText,
    productImageAnalysis: context.productImageAnalysis,
    outputLanguage: strategy.outputLanguage,
  });
  const productSpecificExpansionRule = productIdentity.id === "robot"
    ? [
      "当前商品是AI机器人，必须执行‘卖点先于主体出场’：先把用户卖点转换成一个可见的大场景或视觉证据，再决定机器人是主视觉、辅助主体还是只出现在小型插图中。",
      "多语言/方言：画面大元素必须是教室黑板、中文/English/方言语言卡、对话气泡或语言学习道具；机器人可以缩小成授课小老师，不能只放机器人和几行文字。语言示例仅作视觉道具，不得擅自承诺未确认的支持数量。",
      "讲故事/成语接龙：画面大元素必须是绘本、故事卡、成语接龙卡、翻页动作或阅读环境；机器人作为讲故事伙伴出现。",
      "学习答疑：画面大元素必须是课本、问题卡、黑板和孩子提问动作；机器人承担回应或指向动作，不得只写‘学习更方便’。",
      "玩法丰富/多关节可动：用游戏板、动作轨迹、多种姿态、关节放大或舞蹈动作表现变化；禁止13张图重复同一个正面站姿。",
      "联网智能聊天：用云端节点、WiFi连接线、家庭设备和聊天关系图做大视觉元素，机器人可以作为小型连接终端。",
      "长续航：允许不出现完整机器人，使用大型电池能量图、从早到晚时间线和小型机器人轮廓/屏幕插图表现；不得编造续航小时数、电池容量或百分比。",
      "每张机器人图都必须写清：本张卖点、最大视觉元素、机器人出场级别、具体动作/道具证明、与相邻图的差异。不得用‘突出功能’‘展示场景’等空泛句替代。",
    ].join("\n")
    : "";
  return [
    "你是电商商品图需求模板整理助手。请把用户输入和产品图识别依据整理成一份可直接编辑、可直接进入生图流程的 Markdown 需求模板。",
    "只输出用户可见模板正文，不要解释，不要写分析过程，不要写系统备注。",
    "必须严格使用兜底模板的字段顺序和字段名，不要新增内部字段；必须保留“产品名称”和“可见展示名”两个字段。",
    "如果用户没有填写产品名称，必须根据产品图识别摘要和文件名补一个简洁准确的产品名称。",
    "用户输入的卖点是最高优先级硬要求：必须逐条提取、改写并分配到主图规划和详情页规划，不能用通用模板句替代。",
    "主图规划和详情页规划必须写“具体怎么做”，每一张都要包含：卖点、产品形态、可见标题、画面怎么拍、辅助元素或证明方式、禁写内容。",
    "禁止只输出规划原则。不要写“英雄主图：突出商品外观”“功能证明图：用真实动作证明核心卖点”这类空泛句。",
    "必须写入“卖点证明矩阵”：说明本商品有哪些不同形态、静态卖点证据、动态卖点证据、人物/道具互动方式、构图去重要求。",
    "每张图必须按“卖点证明矩阵”分配不同产品形态。不要把所有图片都做成同一主体位置、同一背景、同一打开状态或同一静物构图。",
    "用户卖点如果包含风险表达，例如直接装开水、承重强、便宜、功效等，要转成可画面证明的安全表达，并在“风险与禁写”里写清不得虚构数值或过度承诺。",
    "平台规则只控制画面风格、构图密度和平台禁用项；语言规则只控制所有新增可见营销文案的统一语言，两者不能互相覆盖。",
    "AI 扩写不得擅自改变用户已选择的目标平台、输出语言和套图比例。",
    `目标平台策略：${strategy.platform}`,
    `输出语言策略：${strategy.outputLanguage}`,
    `当前产品身份：${productIdentity.label}（${productIdentity.id}，识别置信度：${productIdentity.confidence}）`,
    "产品身份是扩写边界：不得把其他品类的示例、卖点、道具、产品形态或场景写入当前模板。",
    "本次必须覆盖的卖点方向：",
    userSeeds.map((point) => `- ${point}`).join("\n"),
    generationRuleBlock,
    "公共核心规则必须覆盖所有平台：Amazon 也必须执行同一主体不同形态、独立卖点、独立场景、构图去重和卖点证明矩阵；平台规则只改变信息密度和视觉克制程度。",
    productSpecificExpansionRule,
    "跨品类污染禁止：输出中不得出现任何非当前商品品类的案例词、道具、使用动作或场景描述；如果不确定当前品类，只能依据产品图识别摘要、产品名称和用户作图重点补齐。",
    strategy.kind === "amazon"
      ? "Amazon 平台风格：画面偏 clean marketplace product listing，构图精炼克制，避免夸张促销贴、虚假认证、评分星级、Best Seller 徽章。文案语言必须以输出语言策略为准，不由 Amazon 平台自动决定。"
      : "国内平台风格：画面适合淘宝/天猫/抖音/小红书移动端电商图，信息更丰富、卖点更直接，但避免促销爆炸贴、平台水印和廉价杂乱。文案语言必须以输出语言策略为准，不由国内平台自动决定。",
    strategy.outputLanguage === "English"
      ? "English 语言规则：所有新增可见营销文案、标题、副标题、标签和可见展示名必须是英文；如果原始商品名是中文，必须转成自然英文展示名。"
      : "简体中文语言规则：所有新增可见营销文案、标题、副标题、标签和可见展示名必须是简体中文；如果原始商品名是英文，必须转成自然中文展示名。",
    "禁止出现在输出中的内部词：用户当前输入、用户原始输入、产品图视觉识别摘要、扩写备注、本地规则扩写、接口、prompt、schema、工作流、案例学习库、页面模块。",
    "不得虚构未提供的具体数值、认证、材质等级、检测报告、分贝、重量克数、承重、保温时长、价格、销量、品牌授权。",
    "长期复用规则必须进入画面要求：保持主体特征不变；每张独立场景；每张独立卖点；允许多元素突出卖点；辅助元素只服务卖点；不要只复制同一个产品换背景。",
    "以下泛化内容禁止出现在输出中，出现任意一条都视为扩写失败：",
    genericBriefPhrasesForPrompt(),
    "产品图识别依据仅供你理解，不得原样输出为字段：",
    context.productImageAnalysis || "未提供视觉识别摘要。",
    "用户输入依据仅供你理解，不得原样输出为字段：",
    rawBriefText || "用户未填写，按商品图自行分析。",
    "请按以下模板结构输出，并补齐缺失字段：",
    fallback,
  ].join("\n");
}

function formatGenerationRuleForBriefPrompt(generationRule) {
  if (!generationRule?.ruleText) {
    return "本次未读取到外部生图规则正文，请使用默认商品图规则：主体锁定、独立场景、独立卖点、文案具体、禁用内部词。";
  }
  return [
    "本次命中的生图规则摘要如下。平台规则与语言规则必须同时遵守，但不要把规则命中过程、规则文件名、规则ID或内部判断说明输出到用户可见模板：",
    `组合规则：${generationRule.ruleName || ""}`,
    `公共核心规则：${generationRule.commonRuleName || ""}`,
    "公共核心规则优先级最高：所有平台都必须继承主体锁定、卖点证明矩阵、同一主体不同形态、独立场景、构图去重和生成审核硬规则。",
    "重要：公共规则中的品类案例只用于说明方法，不是当前商品素材；AI扩写必须只围绕当前上传产品图、产品名称和用户输入生成，不得复制任何非当前品类示例词。",
    `平台规则：${generationRule.platformRuleName || ""}`,
    `语言规则：${generationRule.languageRuleName || ""}`,
    `规则版本：${generationRule.ruleVersion || ""}`,
    `判断原因：${generationRule.ruleReason || ""}`,
    "执行摘要：保持主体特征不变；每张图独立卖点和独立场景；画面必须证明卖点；输出语言必须统一；禁止内部流程词、占位句、规则示例串场和虚构参数。",
  ].filter(Boolean).join("\n");
}

function defaultDemandBrief({ productName, rawBriefText, referenceNames = [], productImageAnalysis = "", generationRule = null }) {
  const strategy = platformStrategy(rawBriefText, generationRule);
  const cleanProductName = safeSegment(inferProductName({ rawBriefText, productName, referenceNames, productImageAnalysis, outputLanguage: strategy.outputLanguage }));
  const visibleProductName = inferVisibleProductName({ rawBriefText, productName: cleanProductName, productImageAnalysis, outputLanguage: strategy.outputLanguage });
  const audience = extractBriefField(rawBriefText, ["人群", "目标人群", "audience"]) || inferAudience({
    rawBriefText,
    productImageAnalysis,
    productName: cleanProductName,
    outputLanguage: strategy.outputLanguage,
  }) || strategy.defaultAudience;
  const category = inferCategory({
    rawBriefText,
    productImageAnalysis,
    productName: cleanProductName,
    outputLanguage: strategy.outputLanguage,
  });
  const sellingPoints = inferSellingPoints({
    productName: cleanProductName,
    rawBriefText,
    productImageAnalysis,
    outputLanguage: strategy.outputLanguage,
  });
  const concreteSections = buildConcreteBriefSections({
    productName: cleanProductName,
    visibleProductName,
    sellingPoints,
    rawBriefText,
    productImageAnalysis,
    outputLanguage: strategy.outputLanguage,
  });
  const banned = mergeBriefText(
    extractBriefField(rawBriefText, ["禁用元素", "禁用", "banned elements"]),
    strategy.bannedElements
  );
  const specs = extractBriefField(rawBriefText, ["规格参数", "规格", "参数", "specs"]) || (strategy.outputLanguage === "English"
    ? "Not provided. Do not invent dimensions, test data, certifications, materials, price, sales volume, or performance claims."
    : "未提供。不得自行编造尺寸、检测数据、认证、材质等级、价格、销量或功效参数。");
  const generateDetail = extractBriefField(rawBriefText, ["生成详情页", "详情页", "generate detail"]) || "是";
  return `商品作图需求模板

产品名称：${cleanProductName}
可见展示名：${visibleProductName}
目标平台：${strategy.platform}
输出语言：${strategy.outputLanguage}
套图比例：${fixedSuiteRatio}

人群：${audience}
类目：${category}
生成详情页：${generateDetail}

核心卖点：
${sellingPoints.map((point) => `- ${point}`).join("\n")}

用户卖点提取与改写：
${concreteSections.extractedPoints}

可用画面证据：
${concreteSections.evidence}

风险与禁写：
${concreteSections.risks}

画面要求：
- 保持上传产品图中的主体特征不变，颜色、结构、比例、材质观感、图案、商品本体文字和关键细节都以参考图为准。
- 每张图片必须是独立场景和独立卖点，不允许只复制同一个产品姿态后换背景或换文案。
  - 允许加入人物、手部、道具、室内/户外环境、局部放大圈和多角度结构图；商品是识别锚点，但语言、电量、联网等抽象卖点可以让场景、信息图或道具成为大视觉元素，商品以主图、辅助主体或小型插图形式出现。
- 可见宣传文案必须是消费者能理解的卖点短句，不能出现内部流程词、页面模块名、随机乱码或错误文字。

卖点证明矩阵：
${concreteSections.proofMatrix}

主图规划：
${concreteSections.mainPlan}

详情页规划：
${concreteSections.detailPlan}

禁用元素：
${banned}

规格参数：
${specs}

补充说明：
${strategy.briefNote}`;
}

function normalizeExpandedBrief(expanded, fallback, context) {
  let clean = expanded.replace(/^```(?:markdown)?/i, "").replace(/```$/i, "").trim();
  if (context.normalizationDiagnostics) {
    context.normalizationDiagnostics.modelOutputLength = clean.length;
    context.normalizationDiagnostics.modelOutputPreview = clean.slice(0, 600);
  }
  const bodyMarkers = ["商品作图需求模板", "# 商品作图需求", "产品名称：", "产品名称:"];
  for (const marker of bodyMarkers) {
    const markerIndex = clean.indexOf(marker);
    if (markerIndex > 0) {
      clean = clean.slice(markerIndex).trim();
      break;
    }
  }
  clean = stripInternalBriefContent(clean);
  if (!clean || clean.length < 80) {
    if (context.normalizationDiagnostics) context.normalizationDiagnostics.qualityIssues = ["模型输出为空或过短"];
    return fallback;
  }
  if (!hasRequiredVisibleBriefFields(clean)) {
    if (context.normalizationDiagnostics) context.normalizationDiagnostics.qualityIssues = ["模型输出缺少必需的需求模板字段"];
    return fallback;
  }
  const productName = inferProductName({
    rawBriefText: clean,
    productName: context.fallbackProductName,
    referenceNames: context.referenceNames,
    productImageAnalysis: context.productImageAnalysis,
    outputLanguage: platformStrategy(clean || context.rawBriefText, context.generationRule).outputLanguage,
  });
  clean = ensureBriefField(clean, "产品名称", productName);
  const strategy = platformStrategy(clean || context.rawBriefText, context.generationRule);
  clean = replaceBriefField(clean, "目标平台", strategy.platform);
  clean = replaceBriefField(clean, "输出语言", strategy.outputLanguage, "目标平台");
  clean = replaceBriefField(clean, "可见展示名", inferVisibleProductName({
    rawBriefText: clean || context.rawBriefText,
    productName,
    productImageAnalysis: context.productImageAnalysis,
    outputLanguage: strategy.outputLanguage,
  }), "产品名称");
  clean = replaceBriefField(clean, "套图比例", fixedSuiteRatio, "输出语言");
  clean = replaceBriefField(clean, "人群", inferAudience({
    rawBriefText: context.rawBriefText,
    productImageAnalysis: context.productImageAnalysis,
    productName,
    outputLanguage: strategy.outputLanguage,
  }), "套图比例");
  clean = replaceBriefField(clean, "类目", inferCategory({
    rawBriefText: context.rawBriefText,
    productImageAnalysis: context.productImageAnalysis,
    productName: context.fallbackProductName || productName,
    outputLanguage: strategy.outputLanguage,
  }), "人群");
  clean = ensureBriefField(clean, "规格参数", strategy.outputLanguage === "English"
    ? "Not provided. Do not invent dimensions, test data, certifications, materials, price, sales volume, or performance claims."
    : "未提供。不得自行编造尺寸、检测数据、认证、材质等级、价格、销量或功效参数。");
  const validationContext = {
    rawBriefText: `${context.rawBriefText || ""}\n${context.productImageAnalysis || ""}`,
    // Validate against the trusted task identity, not a model-supplied product
    // name that may have copied a stale category from the pasted template.
    productName: context.fallbackProductName || productName,
    productImageAnalysis: context.productImageAnalysis,
    outputLanguage: strategy.outputLanguage,
  };
  const qualityIssues = briefExpansionQualityIssues(clean, validationContext);
  if (qualityIssues.length) {
    if (context.normalizationDiagnostics) context.normalizationDiagnostics.qualityIssues = qualityIssues;
    const fallbackIssues = briefExpansionQualityIssues(fallback, validationContext);
    if (fallbackIssues.length) {
      throw new Error(`AI扩写与安全兜底均未通过质量校验：${fallbackIssues.join("；")}`);
    }
    return fallback;
  }
  return stripInternalBriefContent(clean);
}

function platformStrategy(rawBriefText = "", generationRule = null) {
  const explicit = extractBriefField(rawBriefText, ["目标平台", "平台", "电商平台", "target platform", "platform"]);
  const explicitLanguage = extractBriefField(rawBriefText, ["输出语言", "language", "output language"]);
  const outputLanguage = normalizeOutputLanguage(generationRule?.outputLanguage || explicitLanguage || (/english|英文|英语/i.test(rawBriefText) ? "English" : "简体中文"));
  const ruleText = [
    generationRule?.platformRuleProfile,
    generationRule?.platformRuleName,
    generationRule?.targetPlatform,
    generationRule?.platformRuleReason,
  ].filter(Boolean).join(" ");
  const ruleIsAmazon = /amazon|亚马逊|overseas marketplace|marketplace product listing/i.test(ruleText);
  if (generationRule && ruleIsAmazon) {
    return {
      kind: "amazon",
      platform: generationRule.targetPlatform || "Amazon",
      outputLanguage,
      defaultAudience: "Amazon shoppers looking for clear product benefits and trustworthy everyday use",
      bannedElements: "competitor logos; platform watermarks; fake certifications; fake reviews; rating stars; Best Seller badges; Amazon Choice badges; coupons; exaggerated sale stickers; QR codes; prices; sales volume; unreadable random text; mixed-language marketing copy; unsupported technical claims",
      briefNote: `平台风格使用 Amazon 精简可信商品图规则；新增可见文案必须统一使用 ${outputLanguage}。平台规则：${generationRule.platformRuleName || "Amazon"}；语言规则：${generationRule.languageRuleName || outputLanguage}。`,
    };
  }
  if (generationRule && generationRule.platformRuleProfile === "domestic-default") {
    return {
      kind: "domestic",
      platform: generationRule.targetPlatform || explicit || "通用电商",
      outputLanguage,
      defaultAudience: "关注实用性、日常使用和性价比的电商用户",
      bannedElements: "竞品商标；平台水印；夸张促销爆炸贴；虚假参数；虚构认证；二维码；价格/销量信息；混合语言营销文案；与商品无关的杂乱背景；内部流程词或页面模块名",
      briefNote: `平台风格使用国内移动端电商规则，信息更丰富、卖点更直接；新增可见文案必须统一使用 ${outputLanguage}。平台规则：${generationRule.platformRuleName || "默认国内平台"}；语言规则：${generationRule.languageRuleName || outputLanguage}。`,
    };
  }
  const haystack = `${explicit}\n${rawBriefText}`.toLowerCase();
  if (/amazon|亚马逊/.test(haystack)) {
    return {
      kind: "amazon",
      platform: "Amazon",
      outputLanguage,
      defaultAudience: "Amazon shoppers looking for practical everyday products",
      bannedElements: "competitor logos; platform watermarks; fake certifications; fake reviews; rating stars; Best Seller badges; exaggerated sale stickers; QR codes; prices; sales volume; unreadable random text; mixed-language marketing copy; unsupported technical claims",
      briefNote: `Use clean Amazon-style product listing images. Newly added visible marketing copy must stay entirely in ${outputLanguage}.`,
    };
  }
  if (/tiktok|tik tok/.test(haystack)) {
    return {
      kind: "tiktok",
      platform: "TikTok Shop",
      outputLanguage,
      defaultAudience: "短视频电商用户",
      bannedElements: "竞品商标；平台水印；虚假认证；夸张促销爆炸贴；二维码；价格/销量信息；随机乱码；错误文字；未提供的功效参数",
      briefNote: "画面应适合短视频电商货架与移动端浏览，卖点短、画面证据强，避免平台水印和夸张促销贴。",
    };
  }
  return {
    kind: "domestic",
    platform: explicit || "通用电商",
    outputLanguage,
    defaultAudience: "关注实用性、日常使用和性价比的电商用户",
    bannedElements: "竞品商标；平台水印；夸张促销爆炸贴；随机英文；错误中文；虚假参数；虚构认证；二维码；价格/销量信息；与商品无关的杂乱背景；内部流程词或页面模块名",
    briefNote: "画面适合移动端电商浏览，文字短、准、大层级，卖点必须能被画面证明。",
  };
}

function parseBriefFieldLines(content = "") {
  const fields = new Map();
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^#{1,6}\s*/, "").replace(/^[-*+]\s+/, "");
    const match = line.match(/^([^:：|]{2,28})\s*[:：]\s*(.*)$/);
    if (!match) continue;
    const key = normalizeBriefKey(match[1]);
    const value = match[2].trim();
    if (!fields.has(key)) fields.set(key, value);
  }
  return fields;
}

function extractBriefField(content, labels) {
  const fields = parseBriefFieldLines(content);
  for (const label of labels) {
    const value = fields.get(normalizeBriefKey(label));
    if (value === undefined) continue;
    return isInvalidBriefFieldValue(value) ? "" : value.trim();
  }
  return "";
}

function isInvalidBriefFieldValue(value) {
  const clean = String(value || "").trim();
  if (!clean) return true;
  if (/请(?:结合|根据)?.*(?:商品图|产品图|用户重点|产品名称|文件名|图片|需求|卖点|信息).*(?:自行分析|自行补充|自行提炼|分析补充)/.test(clean)) return true;
  if (/^(请)?自行(?:分析|补充|判断|提炼)$/.test(clean)) return true;
  const fieldPrefix = clean.match(/^([^:：|]{2,28})\s*[:：]/);
  return Boolean(fieldPrefix && knownBriefHeadings.has(fieldPrefix[1].trim()));
}

function inferProductName({ rawBriefText = "", productName = "", referenceNames = [], productImageAnalysis = "", outputLanguage = "" }) {
  const explicit = extractBriefField(rawBriefText, ["产品名称", "商品名称", "品名", "product name", "name"]);
  // The task-level product name comes from the current submission and outranks
  // any copied field inside a legacy template pasted by the user.
  const direct = cleanProductName(productName) || cleanProductName(explicit);
  if (direct) return direct;

  const strategyLanguage = outputLanguage || platformStrategy(rawBriefText).outputLanguage;
  const source = `${productImageAnalysis}\n${rawBriefText}`;
  if (strategyLanguage === "English") {
    if (/电动车|自行车|车篮|篮筐|前篮|后篮|骑行|bike basket|bicycle basket/i.test(source)) return "Waterproof E-Bike Basket";
    if (/垃圾袋|trash bag|抽绳|艾草|除臭|防臭/i.test(source)) return "Drawstring Odor-Control Trash Bags";
    if (/鞋|shoe|sneaker|footwear|网面|透气/i.test(source)) return "Black Breathable Mesh Walking Shoes";
    if (/雨伞|伞|umbrella/i.test(source)) return "Windproof Folding Umbrella";
    if (/水壶|保温杯|bottle|cup/i.test(source)) return "Portable Insulated Water Bottle";
    if (/椅|凳|chair|stool/i.test(source)) return "Lightweight Rolling Chair";
    if (/机器人|robot/i.test(source)) return "AI Companion Robot";
  }

  const visualName = extractVisualProductName(source);
  if (visualName) return cleanProductName(visualName);

  for (const name of referenceNames) {
    const stripped = cleanProductName(stripExtension(name).replace(/^参考图\d+[-_ ]*/, "").replace(/^(主参考图|细节图|结构图|场景参考)[-_ ]*/, ""));
    if (stripped && !/图片处理需求|参考图|image|photo|product/i.test(stripped)) return stripped;
  }
  return strategyLanguage === "English" ? "Reference Product" : "未命名商品";
}

function cleanProductName(value) {
  const clean = String(value || "")
    .replace(/^产品名称\s*[：:]/, "")
    .replace(/^商品名称\s*[：:]/, "")
    .replace(/[。；;，,]+$/g, "")
    .trim();
  if (!clean || isInvalidBriefFieldValue(clean)) return "";
  if (/^(目标平台|平台|输出语言|人群|类目|生成详情页)\s*[：:]/.test(clean)) return "";
  return clean.slice(0, 60);
}

function inferVisibleProductName({ rawBriefText = "", productName = "", productImageAnalysis = "", outputLanguage = "" }) {
  const explicit = cleanProductName(extractBriefField(rawBriefText, ["可见展示名", "展示名", "visible product name", "display name"]));
  if (explicit) return outputLanguage === "English" ? englishDisplayName(explicit, rawBriefText, productImageAnalysis) : chineseDisplayName(explicit, rawBriefText, productImageAnalysis);
  return outputLanguage === "English"
    ? englishDisplayName(productName, rawBriefText, productImageAnalysis)
    : chineseDisplayName(productName, rawBriefText, productImageAnalysis);
}

function englishDisplayName(productName = "", rawBriefText = "", productImageAnalysis = "") {
  const source = `${productName}\n${rawBriefText}\n${productImageAnalysis}`;
  if (/破壁机|搅拌机|料理机|豆浆机|果汁机|榨汁机|blender|mixer|smoothie/i.test(source)) return "High-Speed Blender";
  if (/电动车|自行车|车篮|篮筐|前篮|后篮|骑行|bike basket|bicycle basket/i.test(source)) return "Waterproof E-Bike Basket";
  if (/ai\s*机器人|机器人|豆包|deepseek|robot|ai companion/i.test(source)) return "AI Companion Robot";
  if (/垃圾袋|抽绳|艾草|除臭|防臭|trash bag/i.test(source)) return "Drawstring Trash Bags";
  if (/雨伞|晴雨伞|折叠伞|umbrella/i.test(source)) return "Folding Umbrella";
  if (/鞋|网面|透气|shoe|sneaker|footwear/i.test(source)) return "Breathable Walking Shoes";
  const supplementName = inferEvidenceBasedEnglishDisplayName({ productName, rawBriefText, productImageAnalysis });
  if (supplementName) return supplementName;
  if (/水壶|保温杯|水杯|water\s*bottle|drinking\s*bottle|drinkware|cup/i.test(source)) return "Insulated Water Bottle";
  if (/椅|凳|chair|stool/i.test(source)) return "Rolling Desk Chair";
  if (/纸巾|抽纸|tissue/i.test(source)) return "Facial Tissue Box";
  const clean = cleanProductName(productName);
  return clean && !containsCjk(clean) ? clean : "Featured Product";
}

function chineseDisplayName(productName = "", rawBriefText = "", productImageAnalysis = "") {
  const source = `${productName}\n${rawBriefText}\n${productImageAnalysis}`;
  const clean = cleanProductName(productName);
  if (clean && containsCjk(clean)) return clean;
  if (/bike basket|bicycle basket|e-bike basket/i.test(source)) return "电动车防水篮筐";
  if (/trash bag|drawstring|odor/i.test(source)) return "艾草祛味垃圾袋";
  if (/robot|ai companion/i.test(source)) return "AI陪伴机器人";
  if (/umbrella/i.test(source)) return "折叠晴雨伞";
  if (/shoe|sneaker|footwear/i.test(source)) return "透气休闲鞋";
  if (/bottle|cup/i.test(source)) return "便携水杯";
  if (/chair|stool/i.test(source)) return "滚轮靠背椅";
  if (/tissue/i.test(source)) return "抽取式面巾纸";
  if (/oregano\s*oil|dietary\s*supplement|supplement|softgels?|capsules?/i.test(source)) return "牛至油膳食补充剂";
  return clean || "精选商品";
}

function containsCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function extractVisualProductName(source) {
  const patterns = [
    /商品为([^。\n；;]+)/,
    /商品类型与主体[\s\S]*?[-*]\s*商品为([^。\n；;]+)/,
    /主体是([^。\n；;]+)/,
    /推测产品名称[：:]\s*([^\n。；;]+)/,
  ];
  for (const pattern of patterns) {
    const match = String(source || "").match(pattern);
    const value = cleanProductName(match?.[1] || "");
    if (value) return value;
  }
  return "";
}

function inferAudience({ rawBriefText = "", productImageAnalysis = "", productName = "", outputLanguage = "" }) {
  const explicit = extractBriefField(rawBriefText, ["人群", "目标人群", "audience"]);
  if (explicit) return explicit;
  const source = `${productName}\n${rawBriefText}\n${productImageAnalysis}`;
  if (/破壁机|搅拌机|料理机|豆浆机|果汁机|榨汁机|blender|mixer|smoothie/i.test(source)) {
    return outputLanguage === "English"
      ? "Home cooks, breakfast drink makers, families, and users who want convenient everyday blending"
      : "家庭早餐用户、喜欢制作饮品的人群、亲子家庭和注重厨房效率的日常用户";
  }
  if (/电动车|自行车|车篮|篮筐|前篮|后篮|骑行|bike basket|bicycle basket/i.test(source)) {
    return outputLanguage === "English"
      ? "E-bike and bicycle commuters, grocery-run riders, delivery users, and daily riders who need waterproof front storage"
      : "电动车/自行车通勤用户、买菜接送用户、外卖配送用户和需要雨天收纳的日常骑行人群";
  }
  if (/垃圾袋|trash bag|抽绳|艾草|除臭|防臭/i.test(source)) return outputLanguage === "English" ? "Household users who need daily kitchen and home cleanup" : "家庭厨房清洁用户、日常厨余处理和高频换袋人群";
  if (/雨伞|伞|umbrella/i.test(source)) return outputLanguage === "English" ? "Commuters and outdoor users who need portable rain and sun protection" : "通勤出行用户、学生和需要晴雨防护的户外人群";
  if (/机器人|robot|AI陪伴|智能对话|LED表情|豆包|deepseek/i.test(source)) return outputLanguage === "English" ? "Families with children, desktop gadget fans, and gift buyers looking for AI companionship" : "儿童亲子家庭、桌面潮玩用户和科技礼物购买人群";
  if (/椅|凳|chair|stool/i.test(source)) return outputLanguage === "English" ? "Home office, study, vanity and compact-space users who need mobile seating" : "居家办公、学习书桌、梳妆台和小户型移动座椅用户";
  if (/鞋|shoe|sneaker|footwear/i.test(source)) return outputLanguage === "English" ? "Daily walking, commuting and casual outfit users" : "日常通勤、休闲出行和关注舒适穿搭的人群";
  if (/牛至油|oregano\s*oil|膳食补充剂|营养补充剂|保健品|软胶囊|胶囊|capsules?|softgels?|dietary\s*supplement|supplement/i.test(source)) {
    return outputLanguage === "English"
      ? "Adults looking for a convenient, clearly presented everyday dietary supplement routine"
      : "关注日常营养补充便利性、配方信息和包装细节的成年消费者";
  }
  if (/水壶|水杯|保温杯|water\s*bottle|drinking\s*bottle|drinkware|cup/i.test(source)) return outputLanguage === "English" ? "Commuters, students and outdoor users who need portable drinkware" : "通勤用户、学生和需要便携饮水的户外人群";
  return outputLanguage === "English" ? "Everyday shoppers who need practical product benefits" : "关注实用性、日常使用和性价比的电商用户";
}

function inferCategory({ rawBriefText = "", productImageAnalysis = "", productName = "", outputLanguage = "" }) {
  const trustedSource = `${productName}\n${productImageAnalysis}`;
  const trustedCategory = inferCategoryFromSource(trustedSource, outputLanguage);
  if (trustedCategory) return trustedCategory;
  const explicit = extractBriefField(rawBriefText, ["类目", "品类", "category"]);
  if (explicit) return explicit;
  return inferCategoryFromSource(rawBriefText, outputLanguage)
    || (outputLanguage === "English" ? "Consumer Product" : "通用电商商品");
}

function inferSellingPoints({ productName = "", rawBriefText = "", productImageAnalysis = "", outputLanguage = "" }) {
  return inferBriefSellingPoints({ productName, rawBriefText, productImageAnalysis, outputLanguage });
}

function splitBriefList(value) {
  return String(value || "")
    .split(/[；;、,\n]/)
    .map((item) => item.replace(/^[-*\d.、\s]+/, "").trim())
    .filter(Boolean);
}

function mergeBriefText(...values) {
  return [...new Set(values.flatMap((value) => splitBriefList(value)))].join("；");
}

function stripInternalBriefContent(content) {
  const lines = String(content || "").split(/\r?\n/);
  const kept = [];
  let skipBlock = false;
  for (const rawLine of lines) {
    const clean = rawLine.trim();
    const normalized = clean.replace(/^#{1,6}\s*/, "").replace(/^[-*+]\s+/, "");
    const hasInternal = internalBriefPhrases.some((phrase) => normalized.includes(phrase));
    if (hasInternal) {
      skipBlock = /[：:]?$/.test(normalized) || normalized.length < 22;
      continue;
    }
    if (skipBlock) {
      const isNextKnownField = /^([^:：|]{2,28})\s*[:：]/.test(normalized) || knownBriefHeadings.has(normalized);
      if (!isNextKnownField) continue;
      skipBlock = false;
    }
    kept.push(rawLine);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function hasRequiredVisibleBriefFields(content) {
  const requiredInlineFields = ["产品名称", "目标平台"];
  const requiredSections = ["核心卖点", "画面要求", "禁用元素", "规格参数"];
  return requiredInlineFields.every((label) => Boolean(extractBriefField(content, [label])))
    && requiredSections.every((label) => new RegExp(`(?:^|\\n)\\s*#{0,6}\\s*${escapeRegExp(label)}\\s*[：:]`, "m").test(content));
}

function ensureBriefField(content, label, value, afterLabel = "") {
  const safeValue = String(value || "").trim();
  if (!safeValue) return content;
  const fieldPattern = new RegExp(`(${escapeRegExp(label)}\\s*[：:]\\s*)([^\\r\\n]*)`);
  if (fieldPattern.test(content)) {
    return content.replace(fieldPattern, (_, prefix, current) => `${prefix}${isInvalidBriefFieldValue(current) ? safeValue : current.trim() || safeValue}`);
  }
  const line = `${label}：${safeValue}`;
  if (afterLabel) {
    const afterPattern = new RegExp(`(${escapeRegExp(afterLabel)}\\s*[：:]\\s*[^\\r\\n]*)(\\r?\\n)`);
    if (afterPattern.test(content)) return content.replace(afterPattern, `$1$2${line}$2`);
  }
  return `${line}\n${content}`;
}

function replaceBriefField(content, label, value, afterLabel = "") {
  const safeValue = String(value || "").trim();
  if (!safeValue) return content;
  const fieldPattern = new RegExp(`(${escapeRegExp(label)}\\s*[：:]\\s*)([^\\r\\n]*)`);
  if (fieldPattern.test(content)) return content.replace(fieldPattern, (_, prefix) => `${prefix}${safeValue}`);
  return ensureBriefField(content, label, safeValue, afterLabel);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractOpenAiText(data) {
  if (data && typeof data === "object" && typeof data.output_text === "string") return data.output_text;
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  for (const choice of choices) {
    const content = choice?.message?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => typeof part?.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  const chunks = [];
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type && item.type !== "message") continue;
    if (item.role && item.role !== "assistant") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type && part.type !== "output_text" && part.type !== "text") continue;
      if (typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

async function readOpenAiResponsePayload(response) {
  const text = await response.text();
  if (/^\s*(event|data):/m.test(text)) {
    return normalizeOpenAiStreamEvents(parseServerSentEvents(text));
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function parseServerSentEvents(text) {
  const events = [];
  let dataLines = [];
  const flush = () => {
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

function normalizeOpenAiStreamEvents(events) {
  const completed = [...events].reverse().find((event) => {
    if (!event || typeof event !== "object") return false;
    return typeof event.type === "string" && event.type.includes("completed") && event.response;
  });
  const response = completed && completed.response && typeof completed.response === "object"
    ? completed.response
    : null;
  const deltas = events
    .map((event) => event && typeof event === "object" && typeof event.delta === "string" ? event.delta : "")
    .filter(Boolean);
  return {
    ...(response || {}),
    output_text: response ? extractOpenAiText(response) : deltas.join("").trim(),
    events,
  };
}

function extractApiError(data) {
  if (!data || typeof data !== "object") return "";
  const error = data.error;
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  if (typeof data.raw === "string") return data.raw.slice(0, 300);
  return "";
}

function createTaskId(value = new Date().toISOString()) {
  const parts = beijingDateParts(value);
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}-${Math.random().toString(16).slice(2, 8)}`;
}

function formatBeijingDateTime(value) {
  const parts = beijingDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function beijingDateParts(value) {
  const date = new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(safeDate);
  const dict = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: dict.year,
    month: dict.month,
    day: dict.day,
    hour: dict.hour,
    minute: dict.minute,
    second: dict.second,
  };
}

function jobMatchesOutputId(job, outputId) {
  const candidates = [
    job.output?.id,
    job.output?.folderName,
    job.outputId,
    job.outputFolderName,
    job.inputFolderName,
    job.materialDir ? path.basename(job.materialDir) : "",
    job.productName,
    job.output?.productName,
  ].map(text).filter(Boolean);
  return candidates.includes(outputId);
}

function resolveMaterialDir(value, outputId) {
  const raw = text(value);
  if (raw) {
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootDir, raw);
    if (isInside(inputRoot, resolved)) return resolved;
  }
  return path.resolve(inputRoot, outputId);
}

function sourceMaterialDirFromStatus(status) {
  const firstSource = Array.isArray(status?.sourceImages) ? text(status.sourceImages[0]) : "";
  if (!firstSource) return "";
  return path.dirname(firstSource);
}

function stripTaskFolderPrefix(value) {
  return String(value || "").replace(/^\d{8}-\d{6}-[a-f0-9]{6}_/i, "") || "未命名商品";
}

function outputDisplayName(output) {
  return text(output?.productName) || text(output?.displayName) || stripTaskFolderPrefix(text(output?.id || output?.folderName));
}

async function resetDirectory(dir) {
  const absolute = path.resolve(dir);
  if (!isInside(inputRoot, absolute)) throw new Error("输入目录路径校验失败。");
  await fs.rm(absolute, { recursive: true, force: true });
  await fs.mkdir(absolute, { recursive: true });
}

async function cleanupStagingDirectories() {
  const entries = await fs.readdir(inputRoot, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".staging-"))
    .map((entry) => fs.rm(path.join(inputRoot, entry.name), { recursive: true, force: true })));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function extractProductName(text) {
  return inferProductName({ rawBriefText: text });
}

function normalizeBriefKey(value) {
  return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
}

function safeSegment(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "未命名商品";
}

function safeFilename(value) {
  const base = path.basename(String(value || "")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
  return base.slice(0, 90);
}

function stripExtension(value) {
  return path.basename(String(value || ""), path.extname(String(value || "")));
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, body) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendNoContent(res) {
  setCors(res);
  res.writeHead(204);
  res.end();
}

async function createZipBuffer(files) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;
  for (const file of files) {
    const data = await fs.readFile(file.filePath);
    const name = Buffer.from(file.archiveName.replace(/\\/g, "/"), "utf8");
    const crc = crc32(data);
    const { time, date } = dosDateTime(new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralDirectory.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...centralDirectory, end]);
}

function dosDateTime(dateValue) {
  const year = Math.max(1980, dateValue.getFullYear());
  const date = ((year - 1980) << 9) | ((dateValue.getMonth() + 1) << 5) | dateValue.getDate();
  const time = (dateValue.getHours() << 11) | (dateValue.getMinutes() << 5) | Math.floor(dateValue.getSeconds() / 2);
  return { date, time };
}

const crc32Table = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".zip") return "application/zip";
  return "image/jpeg";
}
