import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { FolderTaskSource } from "../src/folder-task-source.ts";
import { LocalExcelWorker } from "../src/local-worker.ts";
import { OpenAiImageGenerator } from "../src/openai-image-generator.ts";
import { Logger } from "../src/logger.ts";
import type { ProductTask, ReferenceSearcher, TaskSource } from "../src/types.ts";

const logger = new Logger();

async function main(): Promise<void> {
  const targetTaskId = process.argv[2]?.trim();
  if (!targetTaskId) {
    throw new Error("Usage: node scripts/run-three-image-workflow.ts <source-task-id>");
  }

  const config = loadConfig();
  const source = new FolderTaskSource({
    inputDir: config.worker.dropInputDir,
    outputDir: config.worker.dropOutputDir,
    workspaceDir: config.paths.workspaceDir,
    forceRegenerate: true
  });

  const previousTarget = process.env.TARGET_TASK_ID;
  process.env.TARGET_TASK_ID = targetTaskId;
  const [sourceTask] = await source.listPendingTasks(1);
  if (previousTarget === undefined) delete process.env.TARGET_TASK_ID;
  else process.env.TARGET_TASK_ID = previousTarget;
  if (!sourceTask) throw new Error(`未找到历史任务：${targetTaskId}`);

  const now = new Date();
  const testTaskId = `${formatBeijingTimestamp(now)}-${randomBytes(3).toString("hex")}`;
  const outputFolderName = `${testTaskId}_三图复测_${safeName(sourceTask.productName)}`;
  const task: ProductTask = {
    ...sourceTask,
    recordId: `folder:${outputFolderName}`,
    taskId: testTaskId,
    submittedAt: now.toISOString(),
    submittedAtLocal: formatBeijingLocal(now),
    inputFolderName: sourceTask.inputFolderName,
    outputFolderName,
    sku: outputFolderName,
    outputDir: path.join(config.worker.dropOutputDir, outputFolderName),
    mainImageCount: 3,
    generateDetail: false,
    imageRatio: "1:1"
  };

  const taskSource: TaskSource = {
    async listPendingTasks() {
      return [task];
    },
    async updateTask(current, fields) {
      await source.updateTask(current, fields);
    },
    async getBrand(brandId) {
      return source.getBrand(brandId);
    }
  };
  const searcher: ReferenceSearcher = {
    async ensureLogin() {},
    async search() {
      throw new Error("本次复测按项目配置使用本地参考图与案例学习库。");
    }
  };

  const worker = new LocalExcelWorker({
    config,
    taskSource,
    searcher,
    generator: new OpenAiImageGenerator(config),
    logger
  });
  const summary = await worker.runPending();
  console.log(JSON.stringify({ sourceTaskId: targetTaskId, testTaskId, outputDir: task.outputDir, ...summary }, null, 2));
  if (summary.completed !== 1) process.exitCode = 1;
}

function formatBeijingTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date).replace(/\D/g, "").slice(0, 14);
}

function formatBeijingLocal(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, "-").slice(0, 48) || "商品";
}

main().catch((error) => {
  logger.error("三图工作流复测失败", error);
  process.exitCode = 1;
});
