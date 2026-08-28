import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AppConfig, FeishuAttachment, FeishuClient, FeishuUploadedFile, ImageGenerator, ProductOutput, ProductTask, RawFeishuRecord, ReferenceAnalysis, ReferenceSearcher } from "../src/types.ts";
import { EcommerceImageWorker } from "../src/worker.ts";
import { ensureDir, zipFiles } from "../src/fs-utils.ts";

test("worker processes one pending record and writes completion fields", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ecommerce-worker-"));
  const sourceImage = path.join(tmp, "source.jpg");
  await fs.writeFile(sourceImage, Buffer.alloc(32_000, 1));

  const updates: Record<string, unknown>[] = [];
  const record: RawFeishuRecord = {
    recordId: "rec1",
    recordUrl: "https://example.test/record",
    fields: {
      SKU: "SKU001",
      商品名称: "测试商品",
      人群: "家庭用户",
      商品图: [{ file_token: "product-token", name: "product.jpg" }],
      状态: "待生成"
    }
  };

  const config = testConfig(tmp);
  const feishu: FeishuClient = {
    async listPendingTasks() {
      return [record];
    },
    async findTaskBySku() {
      return record;
    },
    async updateRecord(_recordId, fields) {
      updates.push(fields);
    },
    async downloadAttachment(_attachment: FeishuAttachment, destinationPath: string) {
      await ensureDir(path.dirname(destinationPath));
      await fs.copyFile(sourceImage, destinationPath);
    },
    async uploadBitableFile(filePath: string): Promise<FeishuUploadedFile> {
      return { fileToken: `uploaded-${path.basename(filePath)}`, name: path.basename(filePath) };
    },
    async uploadMessageImage() {
      return "image-key";
    },
    async sendImageMessage() {},
    async sendTextMessage() {}
  };

  const searcher: ReferenceSearcher = {
    async ensureLogin() {},
    async search(): Promise<ReferenceAnalysis> {
      return {
        query: "测试商品",
        references: [{ title: "参考商品", url: "https://example.test/item" }],
        summary: "1. 参考商品",
        visualPatterns: ["干净主图"],
        sellingPointPatterns: ["卖点短句"],
        detailPagePatterns: ["先卖点后参数"]
      };
    }
  };

  const generator: ImageGenerator = {
    async generate(task: ProductTask, _brand, _productImages, _analysis, outputDir: string): Promise<ProductOutput> {
      const mainDir = path.join(outputDir, "main");
      const detailDir = path.join(outputDir, "detail");
      await ensureDir(mainDir);
      await ensureDir(detailDir);
      const mainPath = path.join(mainDir, "01.jpg");
      const detailPath = path.join(detailDir, "detail.jpg");
      const analysisPath = path.join(outputDir, "analysis.json");
      const packagePath = path.join(outputDir, "package.zip");
      await fs.writeFile(mainPath, Buffer.alloc(32_000, 2));
      await fs.writeFile(detailPath, Buffer.alloc(40_000, 3));
      await fs.writeFile(analysisPath, "{}\n", "utf8");
      await zipFiles(
        [
          { filePath: mainPath, archivePath: "main/01.jpg" },
          { filePath: detailPath, archivePath: "detail/detail.jpg" }
        ],
        packagePath
      );
      return {
        sku: task.sku,
        outputDir,
        mainImages: [
          {
            role: "main",
            index: 1,
            title: "主图",
            prompt: "prompt",
            path: mainPath,
            width: 800,
            height: 800,
            bytes: 32_000
          }
        ],
        detailImages: [
          {
            role: "detail",
            index: 1,
            title: "详情",
            prompt: "prompt",
            path: detailPath,
            width: 750,
            height: 1800,
            bytes: 40_000
          }
        ],
        detailImage: {
          role: "detail",
          index: 1,
          title: "详情",
          prompt: "prompt",
          path: detailPath,
          width: 750,
          height: 1800,
          bytes: 40_000
        },
        analysisPath,
        packagePath,
        report: "ok"
      };
    }
  };

  const worker = new EcommerceImageWorker({ config, feishu, searcher, generator });
  await worker.runOnePoll();

  assert.equal(updates[0].状态, "处理中");
  const finalUpdate = updates.at(-1) as Record<string, unknown>;
  assert.equal(finalUpdate.状态, "已完成");
  assert.equal(finalUpdate.竞品参考摘要, "1. 参考商品");
  assert.ok(String(finalUpdate.本地归档路径).includes("SKU001"));
});

function testConfig(tmp: string): AppConfig {
  return {
    feishu: {
      appId: "app",
      appSecret: "secret",
      baseAppToken: "base",
      tableId: "table",
      chatId: "chat"
    },
    openai: {
      apiKey: "key",
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
