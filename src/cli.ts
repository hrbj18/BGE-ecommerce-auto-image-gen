import { loadConfig } from "./config.ts";
import { OpenApiFeishuClient } from "./feishu-client.ts";
import { OpenAiImageGenerator } from "./openai-image-generator.ts";
import { EcommerceImageWorker } from "./worker.ts";
import { Logger } from "./logger.ts";
import { ExcelTaskSource } from "./excel-task-source.ts";
import { LocalExcelWorker } from "./local-worker.ts";
import { FolderTaskSource } from "./folder-task-source.ts";
import type { ReferenceSearcher } from "./types.ts";

const logger = new Logger();

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const config = loadConfig();
  const searcher = createDisabledReferenceSearcher();

  if (command === "excel" || command === "run") {
    const taskSource = new ExcelTaskSource({
      workbookPath: config.worker.taskWorkbookPath,
      workspaceDir: config.paths.workspaceDir,
      requireLogo: config.openai.imageCompositionMode === "template"
    });
    const worker = new LocalExcelWorker({
      config,
      taskSource,
      searcher,
      generator: new OpenAiImageGenerator(config),
      logger
    });
    const summary = await worker.runPending();
    logger.info(`本次处理 ${summary.processed} 个任务，完成 ${summary.completed} 个，失败 ${summary.failed} 个。`);
    return;
  }

  if (command === "folder" || command === "drop") {
    const taskSource = new FolderTaskSource({
      inputDir: config.worker.dropInputDir,
      outputDir: config.worker.dropOutputDir,
      workspaceDir: config.paths.workspaceDir,
      forceRegenerate: config.worker.forceRegenerate
    });
    const worker = new LocalExcelWorker({
      config,
      taskSource,
      searcher,
      generator: new OpenAiImageGenerator(config),
      logger
    });
    const summary = await worker.runPending();
    logger.info(`本次处理 ${summary.processed} 个商品，完成 ${summary.completed} 个，失败 ${summary.failed} 个。`);
    return;
  }

  assertFeishuConfigured(config);
  const feishu = new OpenApiFeishuClient(config);
  const generator = new OpenAiImageGenerator(config);
  const worker = new EcommerceImageWorker({
    config,
    feishu,
    searcher,
    generator,
    logger
  });

  if (command === "feishu:worker" || command === "worker") {
    await worker.runForever();
    return;
  }

  if (command === "feishu:once" || command === "once") {
    const sku = parseSku(process.argv.slice(3));
    if (sku) {
      await worker.runSku(sku);
    } else {
      await worker.runOnePoll();
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseSku(args: string[]): string | null {
  for (const [index, arg] of args.entries()) {
    if (arg === "--sku") {
      return args[index + 1] ?? null;
    }
    if (arg.startsWith("--sku=")) {
      return arg.slice("--sku=".length);
    }
  }
  return null;
}

function printHelp(): void {
  console.log(`Usage:
  node src/cli.ts folder
  node src/cli.ts excel
  node src/cli.ts feishu:worker
  node src/cli.ts feishu:once [--sku=SKU001]

Environment:
  Copy .env.example to .env and configure the image provider.
`);
}

function createDisabledReferenceSearcher(): ReferenceSearcher {
  const message = "外部参考搜索已关闭：当前版本只使用本地商品图、需求文档和参考案例学习库。";
  return {
    async ensureLogin() {
      throw new Error("当前版本已移除淘宝登录入口，不需要登录淘宝。");
    },
    async search() {
      throw new Error(message);
    }
  };
}

function assertFeishuConfigured(config: ReturnType<typeof loadConfig>): void {
  const missing = Object.entries(config.feishu).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw new Error(`飞书模式缺少配置：${missing.join(", ")}`);
  }
}

main().catch((error) => {
  logger.error("Command failed", error);
  process.exitCode = 1;
});
