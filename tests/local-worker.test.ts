import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AppConfig,
  BrandProfile,
  ImageGenerator,
  ProductOutput,
  ProductTask,
  ReferenceAnalysis,
  ReferenceSearcher,
  TaskSource,
  TaskStatus
} from "../src/types.ts";
import { LocalExcelWorker } from "../src/local-worker.ts";

test("local worker soft-fails reference search and writes completed status", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-image-worker-"));
  const productPath = path.join(tmp, "product.png");
  await fs.writeFile(productPath, Buffer.alloc(32_000, 1));
  const task = makeTask(tmp, productPath);
  const updates: Array<{ status?: TaskStatus; errorMessage?: string }> = [];

  const taskSource: TaskSource = {
    async listPendingTasks() {
      return [task];
    },
    async updateTask(_task, fields) {
      updates.push(fields);
    },
    async getBrand() {
      return makeBrand(productPath);
    }
  };
  const searcher: ReferenceSearcher = {
    async ensureLogin() {},
    async search() {
      throw new Error("外部参考不可用");
    }
  };
  const generator: ImageGenerator = {
    async generate(_task, _brand, _images, analysis, outputDir): Promise<ProductOutput> {
      assert.match(analysis.summary, /外部参考不可用/);
      await fs.mkdir(outputDir, { recursive: true });
      const analysisPath = path.join(outputDir, "analysis.json");
      const packagePath = path.join(outputDir, "package.zip");
      await fs.writeFile(analysisPath, "{}");
      await fs.writeFile(packagePath, "zip");
      return {
        sku: task.sku,
        outputDir,
        mainImages: [],
        detailImages: [],
        analysisPath,
        packagePath,
        report: "完成",
        status: "已完成",
        failures: []
      };
    }
  };

  const worker = new LocalExcelWorker({
    config: makeConfig(tmp),
    taskSource,
    searcher,
    generator
  });
  const summary = await worker.runPending();
  assert.deepEqual(summary, { processed: 1, completed: 1, failed: 0 });
  assert.equal(updates[0].status, "处理中");
  assert.equal(updates.at(-1)?.status, "已完成");
  await assert.rejects(fs.access(path.join(tmp, ".automation.lock")));
});

test("local worker marks a failed task and releases lock", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-image-worker-"));
  const productPath = path.join(tmp, "product.png");
  await fs.writeFile(productPath, Buffer.alloc(32_000, 1));
  const task = makeTask(tmp, productPath);
  const statuses: Array<TaskStatus | undefined> = [];
  const taskSource: TaskSource = {
    async listPendingTasks() { return [task]; },
    async updateTask(_task, fields) { statuses.push(fields.status); },
    async getBrand() { throw new Error("品牌 Logo 不存在"); }
  };
  const searcher: ReferenceSearcher = {
    async ensureLogin() {},
    async search(): Promise<ReferenceAnalysis> {
      throw new Error("should not run");
    }
  };
  const generator: ImageGenerator = {
    async generate() { throw new Error("should not run"); }
  };
  const worker = new LocalExcelWorker({
    config: makeConfig(tmp),
    taskSource,
    searcher,
    generator
  });
  const summary = await worker.runPending();
  assert.deepEqual(summary, { processed: 1, completed: 0, failed: 1 });
  assert.deepEqual(statuses, ["处理中", "失败"]);
  await assert.rejects(fs.access(path.join(tmp, ".automation.lock")));
});

test("local worker removes stale lock and continues", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-image-worker-"));
  const lockPath = path.join(tmp, ".automation.lock");
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" }));
  const taskSource: TaskSource = {
    async listPendingTasks() { return []; },
    async updateTask() {},
    async getBrand() { return makeBrand(lockPath); }
  };
  const searcher: ReferenceSearcher = {
    async ensureLogin() {},
    async search(): Promise<ReferenceAnalysis> {
      throw new Error("should not run");
    }
  };
  const generator: ImageGenerator = {
    async generate() { throw new Error("should not run"); }
  };
  const worker = new LocalExcelWorker({
    config: makeConfig(tmp),
    taskSource,
    searcher,
    generator
  });
  const summary = await worker.runPending();
  assert.deepEqual(summary, { processed: 0, completed: 0, failed: 0 });
  await assert.rejects(fs.access(lockPath));
});

test("local worker keeps active lock and explains the running process", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-image-worker-"));
  const lockPath = path.join(tmp, ".automation.lock");
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const taskSource: TaskSource = {
    async listPendingTasks() { return []; },
    async updateTask() {},
    async getBrand() { return makeBrand(lockPath); }
  };
  const searcher: ReferenceSearcher = {
    async ensureLogin() {},
    async search(): Promise<ReferenceAnalysis> {
      throw new Error("should not run");
    }
  };
  const generator: ImageGenerator = {
    async generate() { throw new Error("should not run"); }
  };
  const worker = new LocalExcelWorker({
    config: makeConfig(tmp),
    taskSource,
    searcher,
    generator
  });
  await assert.rejects(
    worker.runPending(),
    new RegExp(`已有自动化任务正在运行.*${process.pid}`)
  );
  await fs.access(lockPath);
});

function makeTask(tmp: string, productPath: string): ProductTask {
  return {
    recordId: "excel:2",
    sku: "SKU001",
    brandId: "BRAND_A",
    productName: "测试商品",
    targetAudience: "家庭用户",
    targetPlatform: "淘宝/天猫",
    category: "家居",
    productImages: [],
    localProductImages: [productPath],
    referenceImageUrls: [],
    referenceProductUrls: [],
    materialDir: tmp,
    mainProductImage: path.basename(productPath),
    outputDir: path.join(tmp, "output", "SKU001"),
    sellingPoints: "耐用；易清洁",
    specs: "尺寸：10cm",
    bannedElements: "",
    referenceKeywords: "",
    notes: "",
    briefPath: undefined,
    mainImageCount: 5,
    generateDetail: true,
    imageRatio: "1:1"
  };
}

function makeBrand(logoPath: string): BrandProfile {
  return {
    id: "BRAND_A",
    name: "品牌 A",
    logoPath,
    primaryColor: "#14213d",
    secondaryColor: "#fca311",
    backgroundColor: "#f7f4ef",
    titleFont: "PingFang SC",
    bodyFont: "PingFang SC",
    positioning: "测试定位",
    visualKeywords: ["干净"],
    slogan: "测试口号",
    referenceImagePaths: [],
    bannedElements: ""
  };
}

function makeConfig(tmp: string): AppConfig {
  return {
    feishu: { appId: "", appSecret: "", baseAppToken: "", tableId: "", chatId: "" },
    openai: {
      apiKey: "test",
      baseUrl: "https://api.openai.com/v1",
      imageModel: "gpt-image-2",
      textModel: "gpt-5-mini",
      imageProvider: "openai",
      imageCompositionMode: "template",
      aiEchoBaseUrl: "http://localhost:8080",
      aiEchoActivationCode: "",
      aiEchoResolution: "2k",
      imageTunnelProvider: "cloudflared"
    },
    worker: {
      pollIntervalMinutes: 5,
      maxReferences: 5,
      concurrency: 1,
      taskWorkbookPath: path.join(tmp, "tasks.xlsx"),
      skipReferenceSearch: false,
      forceRegenerate: false,
      dropInputDir: path.join(tmp, "待作图"),
      dropOutputDir: path.join(tmp, "已完成")
    },
    paths: {
      workspaceDir: tmp,
      dataDir: path.join(tmp, "data"),
      outputDir: path.join(tmp, "output")
    }
  };
}
