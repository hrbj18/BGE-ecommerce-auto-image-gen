import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomFillSync } from "node:crypto";
import sharp from "sharp";
import type { AppConfig, BrandProfile, ProductTask, ReferenceAnalysis } from "../src/types.ts";
import { OpenAiImageGenerator } from "../src/openai-image-generator.ts";
import {
  AiEchoTaskLedger,
  createAiEchoTaskFingerprint,
  type AiEchoTaskIdentity
} from "../src/aiecho-task-ledger.ts";

function assertCompactDirectedPromptSet(prompts: string[], expectedCount = 13): void {
  assert.equal(prompts.length, expectedCount);
  for (const prompt of prompts) {
    assert.match(prompt, /^CURRENT FRAME MISSION/);
    assert.match(prompt, /FRAME EXECUTION/);
    assert.match(prompt, /Product state\/action:[\s\S]*Scene and interaction:[\s\S]*Visible proof:/);
    assert.match(prompt, /PRODUCT SOURCE OF TRUTH/);
    assert.match(prompt, /SET ART DIRECTION/);
    assert.match(prompt, /VISIBLE COPY CONTRACT/);
    assert.ok(prompt.length <= 6_000);
  }
}

test("native generator submits visual-controller prompts for five main images", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-prompts-"));
  const productPath = path.join(tmp, "product.png");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    await assert.rejects(
      generator.generate(makeTask(tmp, productPath), makeBrand(), [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.length, 5);
  for (const prompt of prompts) {
    assert.match(prompt, /^CURRENT FRAME MISSION/);
    assert.match(prompt, /FRAME EXECUTION/);
    assert.match(prompt, /PRODUCT SOURCE OF TRUTH/);
    assert.match(prompt, /VISIBLE COPY CONTRACT/);
    assert.ok(prompt.length <= 6_000);
  }
  assert.match(prompts[0], /儿童黄色家居拖鞋/);
  assert.match(prompts[0], /product\.png/);
  assert.match(prompts[0], /Product presence:/);
  assert.match(prompts[0], /Visible proof:/);
  assert.match(prompts[3], /macro|close-up|局部|细节/i);
  assert.match(prompts.join("\n"), /白鞋|运动鞋/);
});

test("openai generator does not retry a gateway capacity rejection", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-openai-capacity-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 640, 640);
  const config = makeConfig(tmp);
  config.openai.imageProvider = "openai";
  config.openai.apiKey = "test-key";
  const task = { ...makeTask(tmp, productPath), mainImageCount: 1, detailImageCount: 0, generateDetail: false };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "No available compatible accounts" } }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      new OpenAiImageGenerator(config).generate(
        task,
        makeBrand(),
        [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
        makeAnalysis(),
        path.join(tmp, "out")
      ),
      /所有主图均生成失败/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native generator delivers every compact suite in local test mode", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-compact-suite-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 640, 640);
  const previousLocalMode = process.env.LOCAL_IMAGE_TEST_MODE;
  process.env.LOCAL_IMAGE_TEST_MODE = "1";
  try {
    const config = makeConfig(tmp);
    config.openai.aiEchoResolution = "1k";
    for (const expected of [
      { id: "compact-1-2", mainImageCount: 1, detailImageCount: 2 },
      { id: "compact-2-3", mainImageCount: 2, detailImageCount: 3 },
      { id: "compact-3-4", mainImageCount: 3, detailImageCount: 4 },
    ]) {
      const outDir = path.join(tmp, expected.id);
      const task = {
        ...makeTask(tmp, productPath),
        generationProfileId: expected.id,
        mainImageCount: expected.mainImageCount,
        detailImageCount: expected.detailImageCount,
        generateDetail: true,
      };
      const result = await new OpenAiImageGenerator(config).generate(
        task,
        makeBrand(),
        [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
        makeAnalysis(),
        outDir,
      );

      assert.equal(result.status, "已完成");
      assert.equal(result.mainImages.length, expected.mainImageCount);
      assert.equal(result.detailImages.length, expected.detailImageCount);
      const promptAudit = JSON.parse(await fs.readFile(path.join(outDir, "prompt-audit.json"), "utf8"));
      assert.equal(promptAudit.expectedCount, expected.mainImageCount + expected.detailImageCount);
      assert.equal(promptAudit.actualCount, expected.mainImageCount + expected.detailImageCount);
      await fs.access(path.join(outDir, `${expected.mainImageCount}张主图总览.jpg`));
      await fs.access(path.join(outDir, `${expected.detailImageCount}张详情页总览.jpg`));
    }
  } finally {
    if (previousLocalMode === undefined) delete process.env.LOCAL_IMAGE_TEST_MODE;
    else process.env.LOCAL_IMAGE_TEST_MODE = previousLocalMode;
  }
});

test("native generator delivers task-specific 720p and 1k dimensions", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-resolution-profiles-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 640, 640);
  const previousLocalMode = process.env.LOCAL_IMAGE_TEST_MODE;
  process.env.LOCAL_IMAGE_TEST_MODE = "1";
  try {
    const config = makeConfig(tmp);
    config.openai.aiEchoResolution = "2k";
    for (const expected of [
      { id: "720p" as const, main: [720, 720], detail: [720, 1280] },
      { id: "1k" as const, main: [1024, 1024], detail: [1024, 1822] },
    ]) {
      const outDir = path.join(tmp, expected.id);
      const task: ProductTask = {
        ...makeTask(tmp, productPath),
        generationProfileId: "compact-1-2",
        mainImageCount: 1,
        detailImageCount: 2,
        generateDetail: true,
        imageResolutionId: expected.id,
      };
      const result = await new OpenAiImageGenerator(config).generate(
        task,
        makeBrand(),
        [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
        makeAnalysis(),
        outDir,
      );
      assert.equal(result.status, "已完成");
      assert.equal(result.mainImages.length, 1);
      assert.equal(result.detailImages.length, 2);
      assert.deepEqual([result.mainImages[0].width, result.mainImages[0].height], expected.main);
      assert.deepEqual([result.detailImages[0].width, result.detailImages[0].height], expected.detail);
      const report = JSON.parse(await fs.readFile(path.join(outDir, "report.json"), "utf8"));
      assert.equal(report.imageResolution.id, expected.id);
      assert.equal(report.imageResolution.providerResolution, "1k");
    }
  } finally {
    if (previousLocalMode === undefined) delete process.env.LOCAL_IMAGE_TEST_MODE;
    else process.env.LOCAL_IMAGE_TEST_MODE = previousLocalMode;
  }
});

test("native generator applies the portrait main ratio without changing detail pages", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-portrait-main-ratio-"));
  const productPath = path.join(tmp, "product.png");
  const outDir = path.join(tmp, "out");
  await writeNoiseImage(productPath, 640, 640);
  const previousLocalMode = process.env.LOCAL_IMAGE_TEST_MODE;
  process.env.LOCAL_IMAGE_TEST_MODE = "1";
  try {
    const config = makeConfig(tmp);
    config.openai.aiEchoResolution = "1k";
    const task: ProductTask = {
      ...makeTask(tmp, productPath),
      generationProfileId: "compact-1-2",
      mainImageCount: 1,
      detailImageCount: 2,
      generateDetail: true,
      imageResolutionId: "1k",
      imageAspectRatioProfileId: "portrait-main",
      suiteRatio: "主图 3:4 / 详情页 9:16",
    };
    const result = await new OpenAiImageGenerator(config).generate(
      task,
      makeBrand(),
      [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
      makeAnalysis(),
      outDir,
    );
    assert.equal(result.status, "已完成");
    assert.deepEqual([result.mainImages[0].width, result.mainImages[0].height], [1024, 1366]);
    assert.deepEqual([result.detailImages[0].width, result.detailImages[0].height], [1024, 1822]);
    const prompts = JSON.parse(await fs.readFile(path.join(outDir, "prompts.json"), "utf8"));
    assert.equal(prompts.find((item: { role: string }) => item.role === "main").aspectRatio, "3:4");
    assert.equal(prompts.find((item: { role: string }) => item.role === "detail").aspectRatio, "9:16");
    const mainPrompt = prompts.find((item: { role: string }) => item.role === "main").prompt;
    assert.match(mainPrompt, /Canvas: 3:4|画布比例.*3:4/);
    assert.doesNotMatch(mainPrompt, /Canvas:\s*1:1|画布[：:]\s*1:1|1:1 主图采用/);
    const report = JSON.parse(await fs.readFile(path.join(outDir, "report.json"), "utf8"));
    assert.equal(report.imageAspectRatio.id, "portrait-main");
    assert.deepEqual([report.imageResolution.mainWidth, report.imageResolution.mainHeight], [1024, 1366]);
  } finally {
    if (previousLocalMode === undefined) delete process.env.LOCAL_IMAGE_TEST_MODE;
    else process.env.LOCAL_IMAGE_TEST_MODE = previousLocalMode;
  }
});

test("native generator builds bike basket prompts without cross-category copy leakage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-bike-basket-"));
  const productPath = path.join(tmp, "bike-basket.png");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 2));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `bike-basket-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task: ProductTask = {
      ...makeTask(tmp, productPath),
      recordId: "folder:bike-basket",
      sku: "电动车防水篮筐",
      productName: "电动车防水篮筐",
      originalProductName: "电动车防水篮筐",
      visibleProductName: "Waterproof E-Bike Basket",
      targetPlatform: "Amazon",
      outputLanguage: "English",
      category: "Bike & E-Bike Storage Accessories",
      targetAudience: "E-bike commuters and grocery-run riders",
      referenceKeywords: "电动车 自行车 车篮 篮筐 防水 通勤 买菜",
      sellingPoints: "防水，大容量，稳固，通勤买菜，性价比高",
      specs: "未提供",
      notes: "保持当前商品图中的篮筐形状、防水盖、固定扣、车把安装关系和装载状态，不虚构承重、防水等级或检测认证。",
      languageRuleName: "English",
      languageRuleText: "Output language: English. All newly added visible marketing copy must be English.",
      platformRuleName: "Amazon",
      platformRuleProfile: "amazon",
      platformRuleText: "Clean marketplace product listing style with restrained copy and practical proof scenes.",
      generationRuleName: "Amazon + English",
      generationRuleReason: "User selected Amazon and English.",
      generationRuleText: [
        "公共核心规则：所有平台都要保持主体锁定、独立场景和卖点证明。",
        "- 垃圾袋示例：未展开卷装堆叠、单只袋身展开、套入垃圾桶、抽绳收口。",
        "- 电动车/自行车篮筐示例：车上安装全貌、打开装载、盖上防水罩、固定结构近景、通勤买菜取放。"
      ].join("\n")
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "bike-basket.png", path: productPath, mimeType: "image/png" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.length, 5);
  assert.match(prompts[0], /^CURRENT FRAME MISSION/);
  assert.match(prompts[0], /Amazon premium marketplace/);
  assert.match(prompts[0], /Waterproof E-Bike Basket/);
  assert.match(prompts[0], /Bike Basket/);
  assert.match(prompts[0], /Water-Resistant Storage/);
  assert.match(prompts[1], /Roomy Front Basket/);
  assert.match(prompts.join("\n"), /安装全貌|opened?|mounted|打开装载/);
  assert.doesNotMatch(prompts.join("\n"), /垃圾袋|垃圾桶|抽绳|厨余/);
  assert.doesNotMatch(prompts.join("\n"), /Everyday Wear|Real-Life Wear/);
});

test("English robot keeps robot-specific scenes while localizing only visible copy", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-english-robot-"));
  const productPath = path.join(tmp, "robot.png");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 9));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `english-robot-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task: ProductTask = {
      ...makeTask(tmp, productPath),
      recordId: "folder:english-robot",
      sku: "豆包AI机器人",
      productName: "豆包AI机器人",
      originalProductName: "豆包AI机器人",
      visibleProductName: "AI Companion Robot",
      targetPlatform: "Amazon",
      outputLanguage: "English",
      category: "AI Companion Robots / Smart Toys",
      targetAudience: "Families with children, desktop gadget fans, and gift buyers",
      referenceKeywords: "黄色黑银圆润机器人，蓝色LED表情屏，多关节",
      sellingPoints: "Multilingual Voice Interaction; Story Time Companion; Movable Joint Play; Connected AI Chat; Long-Lasting Power",
      notes: "Keep the same yellow, black and silver robot identity and use distinct proof scenes.",
      languageRuleName: "English",
      languageRuleText: "All newly added visible marketing copy must be English.",
      platformRuleName: "Amazon",
      platformRuleProfile: "amazon",
      platformRuleText: "Clean marketplace style with practical visual proof."
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "robot.png", path: productPath, mimeType: "image/png" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.length, 5);
  assert.match(prompts[1], /教室黑板|语言卡|classroom|language card/i);
  assert.match(prompts[4], /电池|时间线|battery|timeline/i);
  assert.match(prompts.join("\n"), /Language: English/);
  assert.match(prompts.join("\n"), /Use only these approved marketing lines/);
  assert.doesNotMatch(prompts.join("\n"), /营销文案只允许出现以下指定文字/);
});

test("native generator does not switch domestic rules to Amazon when rule text mentions Amazon", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-domestic-platform-rule-"));
  const productPath = path.join(tmp, "product.png");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 3));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `domestic-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task: ProductTask = {
      ...makeTask(tmp, productPath),
      targetPlatform: "国内通用",
      platformRuleProfile: "domestic-default",
      platformRuleName: "默认国内平台",
      platformRuleText: "画面可以比 Amazon 更丰富，但仍然是国内移动端电商风格。",
      generationRuleName: "公共核心规则 + 默认国内平台 + 简体中文",
      generationRuleText: "国内平台规则说明：允许比 Amazon 更高信息密度，但不是 Amazon marketplace product images。",
      outputLanguage: "简体中文"
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败|鎵€鏈変富鍥惧潎鐢熸垚澶辫触/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(prompts.length > 0);
  assert.doesNotMatch(prompts[0], /目标平台：Amazon marketplace product images|Do not use Taobao\/Tmall|clean product clarity, feature proof/);
});

test("native generator reuses existing valid images and submits only missing ones", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-resume-"));
  const productPath = path.join(tmp, "product.png");
  const outDir = path.join(tmp, "out");
  const mainDir = path.join(outDir, "main");
  await fs.mkdir(mainDir, { recursive: true });
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  await writeNoiseImage(path.join(mainDir, "01-商品首图.png"), 2048, 2048);
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const result = await generator.generate(
      makeTask(tmp, productPath),
      makeBrand(),
      [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
      makeAnalysis(),
      outDir
    );
    assert.equal(result.status, "部分失败");
    assert.equal(result.mainImages.some((image) => image.index === 1 && image.attempts === 0), true);
    assert.equal(typeof result.designReviewPath, "string");
    const review = JSON.parse(await fs.readFile(result.designReviewPath!, "utf8")) as {
      source: string;
      designReviewRules: string[];
      items: Array<{ role: string; index: number; status: string; checks?: Array<{ id: string; passed: boolean }> }>;
    };
    assert.equal(review.source, "reference-case-learning");
    assert.ok(review.designReviewRules.length >= 5);
    assert.equal(review.items.some((item) => item.role === "main" && item.index === 1 && item.status === "通过"), true);
    assert.equal(review.items.some((item) => item.checks?.some((check) => check.id === "typography-layout" && check.passed)), true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The first image is reused; the remaining four fail in the stub and are
  // intentionally sent through the partial-failure recovery queue twice.
  assert.equal(prompts.length, 12);
  assert.equal(prompts.some((prompt) => /本屏角色：产品英雄首图/.test(prompt)), false);
});

test("native generator submits the selected ratio and aiEcho image_urls as one newline-joined item", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-image-urls-"));
  const productPath = path.join(tmp, "product.png");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const submissions: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    submissions.push(body);
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${submissions.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      mainImageCount: 1,
      generateDetail: false,
      imageAspectRatioProfileId: "portrait-main" as const,
      suiteRatio: "主图 3:4 / 详情页 9:16",
      referenceImageUrls: ["https://img.example.test/a.png", "https://img.example.test/b.png"]
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].model, "gpt-2.0");
  assert.equal(submissions[0].aspectRatio, "3:4");
  assert.equal(submissions[0].imageSize, "2K");
  assert.equal(submissions[0].resolution, "2k");
  assert.deepEqual(submissions[0].image_urls, ["https://img.example.test/a.png\nhttps://img.example.test/b.png"]);
});

test("native generator requests provider 1k for a 720p delivery task", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-720p-upstream-"));
  const productPath = path.join(tmp, "product.png");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const submissions: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    submissions.push(body);
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${submissions.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task: ProductTask = {
      ...makeTask(tmp, productPath),
      imageResolutionId: "720p",
      mainImageCount: 1,
      generateDetail: false,
      referenceImageUrls: ["https://img.example.test/product.png"],
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].imageSize, "1K");
  assert.equal(submissions[0].resolution, "1k");
});

test("native generator can upgrade prompt control with OpenAI product visual analysis", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-openai-vision-"));
  const productPath = path.join(tmp, "pants.jpg");
  await writeNoiseImage(productPath, 600, 600);
  const prompts: string[] = [];
  const openAiBaseUrl = "https://api.openai.com/v1";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${openAiBaseUrl}/responses`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.equal(body.model, "gpt-5-mini");
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          summary: "当前商品是一条浅灰色宽松阔腿裤，腰头抽绳和垂坠裤腿明显。",
          productFacts: ["浅灰色宽松阔腿裤", "腰头抽绳清楚", "裤腿垂坠版型"],
          visualSellingPoints: ["宽松版型遮肉显瘦", "抽绳腰头松紧方便", "垂感裤腿日常好搭"],
          promptDirectives: ["文案必须围绕裤装版型和腰头细节", "不得写成空气净化器或母婴用品"],
          warnings: []
        })
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const config = makeConfig(tmp);
    config.openai.apiKey = ["sk", "test-openai-product-vision-key-1234567890"].join("-");
    const generator = new OpenAiImageGenerator(config);
    const task = {
      ...makeTask(tmp, productPath),
      sku: "女士阔腿裤",
      productName: "女士阔腿裤",
      targetAudience: "通勤女性",
      category: "女裤",
      sellingPoints: "请自行分析",
      notes: "",
      mainImageCount: 1,
      generateDetail: false
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "pants.jpg", path: productPath, mimeType: "image/jpeg" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Visual analysis source: openai-vision/);
  assert.match(prompts[0], /Visual analysis summary: 当前商品是一条浅灰色宽松阔腿裤/);
  assert.match(prompts[0], /腰头抽绳清楚/);
  assert.match(prompts[0], /Visual selling-point candidates:[^\n]*宽松版型遮肉显瘦/);
  assert.match(prompts[0], /Visual-analysis directive: 文案必须围绕裤装版型和腰头细节/);
  assert.doesNotMatch(prompts[0], /脚长|鞋底|空气净化器|母婴用品/);
});

test("native generator retries aiEcho execution timeouts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-retry-"));
  const productPath = path.join(tmp, "product.png");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const imageBuffer = await sharp(randomFillSync(Buffer.alloc(1024 * 1024 * 3)), {
    raw: { width: 1024, height: 1024, channels: 3 }
  }).png().toBuffer();
  const imageBytes = new Uint8Array(imageBuffer.length);
  imageBytes.set(imageBuffer);
  const submittedPrompts: string[] = [];
  const resultChecks: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://cdn.example.test/final.png") {
      return new Response(imageBytes, { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/result")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      resultChecks.push(String(body.task_id ?? ""));
      if (body.task_id === "task-1") {
        return new Response(JSON.stringify({
          code: 200,
          data: {
            status: "failed",
            error_msg: "Task execution timed out, please retry | 任务执行超时，请重试"
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        code: 200,
        data: { status: "completed", image_url: "https://cdn.example.test/final.png" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    submittedPrompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${submittedPrompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const result = await generator.generate(
      { ...makeTask(tmp, productPath), mainImageCount: 1, generateDetail: false },
      makeBrand(),
      [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
      makeAnalysis(),
      path.join(tmp, "out")
    );
    assert.equal(result.status, "已完成");
    assert.equal(result.mainImages.length, 1);
    assert.equal(result.mainImages[0].attempts, 2);
    assert.equal(submittedPrompts.length, 2);
    assert.deepEqual(resultChecks, ["task-1", "task-2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native generator builds conversion-led prompts for child temperature cups", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-cup-prompts-"));
  const productPath = path.join(tmp, "cup.png");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      sku: "儿童电子水杯-保温杯",
      productName: "儿童电子水杯/保温杯",
      targetAudience: "10-15岁儿童，购买者是家长",
      category: "保温杯",
      sellingPoints: "请你自行分析",
      specs: "无",
      generateDetail: true
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "cup.png", path: productPath, mimeType: "image/png" }], makeCupAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertCompactDirectedPromptSet(prompts);
  const allPrompts = prompts.join("\n");
  assert.match(allPrompts, /儿童温显水杯重点/);
  assert.match(allPrompts, /温度显示更直观/);
  assert.match(allPrompts, /杯盖|温显屏幕/);
  assert.match(allPrompts, /书包|上学|课桌/);
  assert.match(prompts[5], /CURRENT FRAME MISSION \(DETAIL 1/);
  assert.match(prompts[7], /Canvas: 9:16/);
  assert.match(allPrompts, /不能虚构保温时长、材质等级、防漏测试或安全认证/);
});

test("native generator builds product-specific prompts for non-temperature child cups", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-child-cup-prompts-"));
  const productPath = path.join(tmp, "child-cup.webp");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      sku: "儿童保温杯",
      productName: "儿童保温杯",
      targetAudience: "关心儿童健康的妈妈，适合8-10岁小朋友使用",
      category: "儿童保温杯",
      sellingPoints: "可爱萌趣，耐高温，环保材料",
      specs: "无",
      notes: "儿童家庭场景",
      generateDetail: true
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "child-cup.webp", path: productPath, mimeType: "image/webp" }], makeCupAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertCompactDirectedPromptSet(prompts);
  const allPrompts = prompts.join("\n");
  assert.match(prompts[0], /儿童保温杯重点/);
  assert.match(allPrompts, /黄色杯盖、蓝色双把手、米色杯身/);
  assert.match(allPrompts, /JUMP 与 THERMOS/);
  assert.match(allPrompts, /可爱萌趣孩子爱用/);
  assert.match(allPrompts, /耐热饮用更安心/);
  assert.match(allPrompts, /黄色杯盖必须翻开|杯盖翻开/);
  assert.match(allPrompts, /不能对着关闭的杯盖喝水|禁止对着关闭杯盖喝水/);
  assert.match(allPrompts, /双把手小手好握/);
  assert.match(allPrompts, /环保材质更放心/);
  assert.match(allPrompts, /8-10 岁儿童|8-10 岁小朋友|8-10岁小朋友/);
  assert.doesNotMatch(allPrompts, /儿童温显水杯重点|温度显示更直观|温显屏幕|喝前看一眼水温/);
  assert.doesNotMatch(allPrompts, /Use only these approved marketing lines:[^\n]*(保温时长|材质等级|认证|防漏测试)/);
});

test("native generator builds student backpack prompts from short selling points", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-backpack-prompts-"));
  const productPath = path.join(tmp, "backpack.jpg");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      recordId: "folder:backpack",
      sku: "学生双肩背包",
      productName: "学生双肩背包",
      targetAudience: "上学的孩子",
      category: "学生双肩背包",
      sellingPoints: "质量好，轻便肩负，颜值高",
      specs: "无",
      notes: "上学场景",
      generateDetail: true
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "backpack.jpg", path: productPath, mimeType: "image/jpeg" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertCompactDirectedPromptSet(prompts);
  const allPrompts = prompts.join("\n");
  assert.match(prompts[0], /学生双肩背包重点/);
  assert.match(prompts[0], /当前商品图里的包身颜色、图案、前袋/);
  assert.match(prompts[0], /不得复用旧商品、旧文件夹、旧样例或旧模板里的外观描述/);
  assert.match(allPrompts, /肩带|肩背/);
  assert.match(allPrompts, /课本|作业本/);
  assert.match(allPrompts, /前袋/);
  assert.match(allPrompts, /不写护脊、减负科技、承重测试|不新增防水、防盗、护脊/);
  assert.doesNotMatch(allPrompts, /白色包身、黑色星星满印|白色星星印花|星星印花颜值更高|黑色大前袋、白色星星印花|灰色肩带|小挂包/);
  assert.doesNotMatch(allPrompts, /儿童温显水杯重点|永磁起重机重点|成人女性内衣重点/);
});

test("native generator builds pants prompts and drops stale cross-category notes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-pants-prompts-"));
  const productPath = path.join(tmp, "pants.jpg");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      recordId: "folder:pants",
      sku: "女士宽松阔腿休闲裤",
      productName: "女士宽松阔腿休闲裤",
      targetAudience: "成年女性，日常居家通勤穿搭",
      category: "阔腿裤",
      sellingPoints: "请你自行分析",
      specs: "无",
      notes: "机身、黑色提手、顶部出风口、前置黑色网罩和底座。",
      generateDetail: true
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "pants.jpg", path: productPath, mimeType: "image/jpeg" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertCompactDirectedPromptSet(prompts);
  const allPrompts = prompts.join("\n");
  assert.match(prompts[0], /当前商品图里的真实裤子颜色/);
  assert.match(allPrompts, /宽松版型不拘束|垂顺裤型修饰腿型/);
  assert.match(allPrompts, /走动|坐下|侧身姿态/);
  assert.match(allPrompts, /居家|通勤/);
  assert.match(allPrompts, /腰头抽绳|面料纹理/);
  assert.match(allPrompts, /衣橱|搭配/);
  assert.doesNotMatch(allPrompts, /黑色提手|顶部出风口|前置黑色网罩|用户特殊要求：机身|康养机|风扇|尿布湿|永磁起重机重点/);
  const assignedSellingPointLines = allPrompts
    .split("\n")
    .filter((line) => line.startsWith("CURRENT FRAME MISSION") || line.startsWith("Visual selling-point candidates:"))
    .join("\n");
  assert.doesNotMatch(assignedSellingPointLines, /脚长|鞋底|鞋口/);
  assert.doesNotMatch(allPrompts, /画面里直接看懂|先把核心卖点说清楚/);
});

test("native generator builds visual-controller prompts for adult intimate apparel", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-intimate-prompts-"));
  const productPath = path.join(tmp, "bra.png");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      sku: "成人红色胸罩",
      productName: "成人红色胸罩",
      targetAudience: "38-40岁女性，购买者是女性",
      category: "胸罩",
      sellingPoints: "性感，纯棉材料，穿起来很轻松，需要有模特",
      specs: "无",
      generateDetail: true
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "bra.png", path: productPath, mimeType: "image/png" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.length, 13);
  for (const prompt of prompts) {
    assert.match(prompt, /^CURRENT FRAME MISSION/);
    assert.match(prompt, /Product state\/action:[\s\S]*Scene and interaction:[\s\S]*Visible proof:/);
    assert.match(prompt, /Visible display name: 成人红色胸罩/);
    assert.match(prompt, /成人女性内衣重点/);
    assert.match(prompt, /不做低俗暴露/);
    assert.doesNotMatch(prompt, /儿童家居鞋|孩子在家轻松穿|鞋型|胡萝卜|垃圾袋/);
    assert.ok(prompt.length <= 6_000);
  }
  assert.match(prompts.join("\n"), /棉感|材质/);
  assert.match(prompts.join("\n"), /成年女性|专业躯干模特/);
  assert.match(prompts.join("\n"), /肩带|下围/);
  assert.match(prompts.join("\n"), /衣橱|内搭/);
});

test("native generator builds conversion-led prompts for kitchen towels", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-kitchen-towel-prompts-"));
  const productPath = path.join(tmp, "towel.jpg");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      sku: "厨房毛巾",
      productName: "厨房毛巾",
      targetAudience: "家庭主妇",
      category: "厨房毛巾",
      sellingPoints: "轻轻一猜就干净，好洗，多种颜色可选",
      specs: "无",
      generateDetail: true
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "towel.jpg", path: productPath, mimeType: "image/jpeg" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertCompactDirectedPromptSet(prompts);
  const allPrompts = prompts.join("\n");
  assert.match(prompts[0], /厨房毛巾重点/);
  assert.match(allPrompts, /多色厨房毛巾/);
  assert.match(allPrompts, /轻轻一擦就干净/);
  assert.match(allPrompts, /多色可选好区分/);
  assert.doesNotMatch(allPrompts, /一猜|轻轻一猜/);
  assert.match(allPrompts, /擦拭|厨房小污渍/);
  assert.match(allPrompts, /水槽|冲洗/);
  assert.match(allPrompts, /绒毛纹理/);
  assert.match(allPrompts, /不写强力去油、抗菌|不虚构纯棉、超细纤维、克重或认证/);
  assert.match(allPrompts, /挂放|收纳/);
  assert.doesNotMatch(allPrompts, /胡萝卜|儿童模特|拖鞋|鞋床/);
});

test("native generator builds premium skincare prompts without copying reference logos", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-skincare-prompts-"));
  const productPath = path.join(tmp, "cream.jpg");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      sku: "保湿霜",
      productName: "保湿霜",
      targetAudience: "爱美的女生",
      category: "保湿霜",
      sellingPoints: "温和不刺激皮肤，保湿效果好",
      specs: "无",
      notes: "我需要有模特可以露脸，突出高端品质",
      generateDetail: true
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "cream.jpg", path: productPath, mimeType: "image/jpeg" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertCompactDirectedPromptSet(prompts);
  const allPrompts = prompts.join("\n");
  assert.match(prompts[0], /护肤保湿霜重点/);
  assert.match(prompts[0], /国内高端护肤审美/);
  assert.match(allPrompts, /黑色圆罐保湿霜/);
  assert.match(allPrompts, /水润保湿感/);
  assert.match(allPrompts, /温和不刺激/);
  assert.match(allPrompts, /成年女性模特/);
  assert.match(allPrompts, /打开黑色保湿霜罐|膏体质地/);
  assert.match(allPrompts, /梳妆台|早晚护肤/);
  assert.doesNotMatch(allPrompts, /不生成任何英文|可用抽象金色线条或无字瓶身/);
  assert.match(allPrompts, /干燥季节想要温和保湿/);
  assert.match(allPrompts, /视觉完成度：精修商业摄影/);
  assert.match(allPrompts, /不能虚构成分、浓度、临床数据、医美功效、敏感肌适用、抗老、美白、祛痘/);
  assert.doesNotMatch(allPrompts, /Use only these approved marketing lines:[^\n]*(抗老|美白|祛痘|屏障修护|24 小时保湿|24小时保湿)/);
});

test("native generator upgrades generic copy into product-specific ecommerce selling points", async () => {
  const cases = [
    {
      label: "socks",
      productName: "女士袜子",
      targetAudience: "女生",
      category: "袜子",
      sellingPoints: "纯棉，好看",
      notes: "简约高级，女生穿的",
      expected: [/纯棉好穿也好看/, /纯棉触感更舒服/, /简约好看更百搭/, /女生日常穿搭更省心/],
      forbidden: /营销文案只允许出现以下指定文字：[^。]*(三处日常友好设计|一眼记住的商品细节|日常使用建议|轮廓清晰|体验更直接|把好用|带进每一天|真实场景|选择更简单|一眼看懂)/
    },
    {
      label: "mooncake",
      productName: "礼盒月饼",
      targetAudience: "中秋送礼",
      category: "月饼",
      sellingPoints: "外观高端，适合送礼，人情往来",
      notes: "送礼，一家人团圆吃月饼",
      expected: [/中秋送礼有面子/, /高端礼盒更体面/, /一家人分享更有仪式感/, /人情往来更体面/],
      forbidden: /营销文案只允许出现以下指定文字：[^。]*(三处日常友好设计|一眼记住的商品细节|日常使用建议|轮廓清晰|体验更直接|把好用|带进每一天|真实场景|选择更简单|一眼看懂)/
    },
    {
      label: "pest",
      productName: "蟑螂药",
      targetAudience: "害怕家里有蟑螂的人",
      category: "蟑螂药",
      sellingPoints: "杀蟑螂效果好，对人体无毒",
      notes: "家庭场景",
      expected: [/家里灭蟑更省心/, /灭蟑需求更直接/, /家庭角落都能放/, /按说明使用更安心/],
      forbidden: /营销文案只允许出现以下指定文字：[^。]*(对人体无毒|无毒|三处日常友好设计|一眼记住的商品细节|日常使用建议|轮廓清晰|体验更直接|把好用|带进每一天|真实场景|选择更简单|一眼看懂)/
    },
    {
      label: "fan",
      productName: "手持风扇",
      targetAudience: "户外害怕热的人",
      category: "手持风扇",
      sellingPoints: "小小的好携带，可持续吹风1个小时，充点也很快，颜值高",
      notes: "户外夏天场景",
      expected: [/小巧出门好携带/, /可持续吹风约1小时/, /充电补能更方便/, /高颜值萌趣外观/],
      forbidden: /营销文案只允许出现以下指定文字：[^。]*(充点|三处日常友好设计|一眼记住的商品细节|日常使用建议|轮廓清晰|体验更直接|把好用|带进每一天|真实场景|选择更简单|一眼看懂)/
    },
    {
      label: "pillow",
      productName: "睡眠枕头",
      targetAudience: "容易失眠的人",
      category: "枕头",
      sellingPoints: "有很强的舒适性，睡起来像棉花一样柔软，支撑脖子也很舒服",
      notes: "室内睡眠场景",
      expected: [/柔软睡感更舒服/, /颈部承托更贴合/, /透气孔细节清楚/, /卧室睡眠场景更有代入感/],
      forbidden: /营销文案只允许出现以下指定文字：[^。]*(治疗失眠|颈椎病|医学|助眠数据|三处日常友好设计|一眼记住的商品细节|日常使用建议|轮廓清晰|体验更直接|把好用|带进每一天|真实场景|选择更简单|一眼看懂)/
    },
    {
      label: "laundry",
      productName: "洗衣液",
      targetAudience: "家庭主妇",
      category: "洗衣液",
      sellingPoints: "温和不刺激，清洁力强，洗完之后有香味",
      notes: "室内洗衣场景",
      expected: [/温和洗护不刺激/, /清洁力强更省心/, /洗后淡淡花香/, /瓶身标签细节/],
      forbidden: /营销文案只允许出现以下指定文字：[^。]*(除菌|抑菌|母婴|无荧光剂|去污率|留香时长|三处日常友好设计|一眼记住的商品细节|日常使用建议|轮廓清晰|体验更直接|把好用|带进每一天|真实场景|选择更简单|一眼看懂)/
    },
    {
      label: "sneaker",
      productName: "运动鞋子",
      targetAudience: "喜欢高颜值鞋子的男生",
      category: "鞋子",
      sellingPoints: "高颜值，有很好的舒适性，透气",
      notes: "户外场景",
      expected: [/高颜值日常好搭/, /脚感舒适更轻松/, /鞋面透气更清爽/, /户外穿搭更有型/],
      forbidden: /营销文案只允许出现以下指定文字：[^。]*(宽口好穿|按实际脚长|气垫|增高|防滑等级|联名|三处日常友好设计|一眼记住的商品细节|日常使用建议|轮廓清晰|体验更直接|把好用|带进每一天|真实场景|选择更简单|一眼看懂)/
    }
  ];

  for (const item of cases) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `native-generic-${item.label}-`));
    const productPath = path.join(tmp, `${item.label}.png`);
    await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
    const prompts: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/result")) {
        return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      prompts.push(String(body.prompt ?? ""));
      return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    try {
      const generator = new OpenAiImageGenerator(makeConfig(tmp));
      const task = {
        ...makeTask(tmp, productPath),
        sku: item.productName,
        productName: item.productName,
        targetAudience: item.targetAudience,
        category: item.category,
        sellingPoints: item.sellingPoints,
        specs: "无",
        notes: item.notes,
        generateDetail: true
      };
      await assert.rejects(
        generator.generate(task, makeBrand(), [{ sourceName: `${item.label}.png`, path: productPath, mimeType: "image/png" }], makeAnalysis(), path.join(tmp, "out")),
        /所有主图均生成失败/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assertCompactDirectedPromptSet(prompts);
    const allPrompts = prompts.join("\n");
    for (const expected of item.expected) {
      assert.match(allPrompts, expected, item.label);
    }
    assert.doesNotMatch(allPrompts, item.forbidden, item.label);
    assert.match(prompts[5], /CURRENT FRAME MISSION \(DETAIL 1/, item.label);
    assert.match(allPrompts, /Difference from adjacent frames:/, item.label);
    if (item.label === "socks") {
      assert.match(allPrompts, /手指轻捏袜口|上脚穿搭|衣橱收纳|多场景/);
    }
    if (item.label === "mooncake") {
      assert.match(allPrompts, /开盒|团圆餐桌|节日拜访|多角度/);
    }
    if (item.label === "pest") {
      assert.match(allPrompts, /橱柜底部|成年人手部拿药管|包装信息|家庭重点区域/);
    }
    if (item.label === "fan") {
      assert.match(allPrompts, /手持风扇重点/);
      assert.match(allPrompts, /户外夏日|手持大小对比|充电补能/);
      assert.match(allPrompts, /不虚构档位、风速、静音分贝、电池容量、快充瓦数或认证/);
    }
    if (item.label === "pillow") {
      assert.match(allPrompts, /睡眠枕头重点/);
      assert.match(allPrompts, /卧室床品|手压柔软|颈部承托/);
      assert.match(allPrompts, /不能虚构治疗失眠、治疗颈椎病、医学功效、材质认证、助眠数据/);
    }
    if (item.label === "laundry") {
      assert.match(allPrompts, /洗衣液重点/);
      assert.match(allPrompts, /日常污渍|倒取动作|花香衣物|瓶身标签/);
      assert.match(allPrompts, /不能虚构除菌、抑菌、母婴适用、无荧光剂、检测认证、去污率或留香时长/);
    }
    if (item.label === "sneaker") {
      assert.match(allPrompts, /男生运动鞋重点/);
      assert.match(allPrompts, /透气鞋面|户外上脚|多角度/);
      assert.match(allPrompts, /不虚构气垫、增高、防滑等级、专业跑步性能、联名/);
      assert.doesNotMatch(allPrompts, /宽口好穿|居家走动更轻松|按实际脚长选择尺码/);
    }
  }
});

function makeCupAnalysis(): ReferenceAnalysis {
  return {
    query: "儿童电子水杯",
    references: [],
    summary: "案例学习库",
    visualPatterns: [
      "学习库结论：首图必须先让商品足够大，移动端 3 秒内看清商品、目标人群和第一卖点。",
      "学习库结论：功能型产品要用近景、操作动作或真实使用场景证明卖点，不能只做氛围海报。"
    ],
    sellingPointPatterns: [],
    detailPagePatterns: [
      "杯壶水具要围绕杯盖、杯口、杯身图案、携带/书包/桌面场景建立购买理由。",
      "完整详情页长图要像销售话术一样排序：先立商品价值，再回答顾虑，再证明卖点，最后降低选择成本。"
    ]
  };
}

test("native generator composes a long detail image from reused detail pages", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-long-detail-"));
  const productPath = path.join(tmp, "product.png");
  const outDir = path.join(tmp, "out");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  await writeNoiseImage(path.join(outDir, "main", "01-商品首图.png"), 2048, 2048);
  await writeNoiseImage(path.join(outDir, "detail", "01-核心主张.png"), 2048, 3642);
  await writeNoiseImage(path.join(outDir, "detail", "02-用户顾虑.png"), 2048, 3642);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${String(body.prompt ?? "").length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const task = { ...makeTask(tmp, productPath), generateDetail: true, mainImageCount: 1 };
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const result = await generator.generate(
      task,
      makeBrand(),
      [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
      makeAnalysis(),
      outDir
    );
    assert.equal(result.longDetailPath, path.join(outDir, "详情页完整长图.jpg"));
    const metadata = await sharp(result.longDetailPath).metadata();
    assert.equal(metadata.width, 2048);
    assert.equal(metadata.height, 7284);
    assert.equal(result.detailImages.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native generator builds cup prompts with opened-lid drinking logic", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-cup-open-lid-prompts-"));
  const productPath = path.join(tmp, "trendy-cup.webp");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      sku: "潮流水杯",
      productName: "潮流水杯",
      targetAudience: "喜欢高颜值水杯的年轻人",
      category: "潮流水杯",
      sellingPoints: "环保材质，无异味，隔热不烫手，颜值高",
      notes: "户外喝水场景",
      generateDetail: true
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "trendy-cup.webp", path: productPath, mimeType: "image/webp" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertCompactDirectedPromptSet(prompts);
  const allPrompts = prompts.join("\n");
  assert.match(prompts[0], /水杯类重点/);
  assert.match(allPrompts, /浅蓝翻盖/);
  assert.match(allPrompts, /橙色防滑圈/);
  assert.match(allPrompts, /黄色按钮/);
  assert.match(allPrompts, /杯盖翻开|打开杯盖/);
  assert.match(allPrompts, /禁止对着关闭杯盖喝水|饮用.*符合真实物理逻辑/);
  assert.match(allPrompts, /户外随手喝更方便|随手带去户外/);
  assert.match(allPrompts, /PPSU、500mL、36月\+/);
  assert.doesNotMatch(allPrompts, /脚长|鞋码|鞋长/);
  assert.match(allPrompts, /高颜值杯身更出片/);
  assert.match(allPrompts, /环保材质更放心/);
  assert.match(allPrompts, /隔热握持不烫手/);
  assert.doesNotMatch(allPrompts, /上学日常带着走|课桌书包都适合|孩子自己也好识别/);
  assert.doesNotMatch(allPrompts, /儿童温显水杯重点|儿童保温杯重点|黄色杯盖必须翻开|8-10 岁/);
});

test("native generator builds industrial magnetic lifter prompts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-magnetic-lifter-prompts-"));
  const productPath = path.join(tmp, "magnetic-lifter.jpg");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      sku: "永磁起重机",
      productName: "永磁起重机",
      targetAudience: "需要起重机的人",
      category: "永磁起重机",
      sellingPoints: "3倍吸力，适用于各种起重场景，无需用电",
      notes: "户外起重场景",
      generateDetail: true
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "magnetic-lifter.jpg", path: productPath, mimeType: "image/jpeg" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertCompactDirectedPromptSet(prompts);
  const allPrompts = prompts.join("\n");
  assert.match(prompts[0], /永磁起重机重点/);
  assert.match(allPrompts, /黄色.*机身/);
  assert.match(allPrompts, /银色 U 型吊环/);
  assert.match(allPrompts, /长操作手柄/);
  assert.match(allPrompts, /3倍吸力吊装更稳/);
  assert.match(allPrompts, /钢板.*吊装|钢板吸附/);
  assert.match(allPrompts, /无需用电/);
  assert.match(allPrompts, /机身铭牌\/参数标签/);
  assert.match(prompts[0], /不得把机身小铭牌里的 PML\/1000KGF 等原有小字放大成醒目营销规格/);
  assert.match(allPrompts, /钢板搬运更直接/);
  assert.match(allPrompts, /户外钢材堆场|工地吊装区/);
  assert.match(allPrompts, /不能新增其它规格或认证|不得新增吨位、认证/);
  assert.doesNotMatch(allPrompts, /厨房做饭|菜板|水槽|儿童拖鞋|胸罩|宽口好穿|居家走动更轻松/);
});

test("native generator injects proof-matrix prompts for trash bags", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-trash-bag-prompts-"));
  const productPath = path.join(tmp, "trash-bag.png");
  await fs.writeFile(productPath, Buffer.alloc(260_000, 1));
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({ code: 200, data: { status: "failed", error_msg: "stub failure", is_return: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    prompts.push(String(body.prompt ?? ""));
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: `task-${prompts.length}` } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    const generator = new OpenAiImageGenerator(makeConfig(tmp));
    const task = {
      ...makeTask(tmp, productPath),
      recordId: "folder:trash-bag",
      sku: "艾草除臭垃圾袋",
      productName: "艾草除臭垃圾袋",
      targetAudience: "家庭厨房清洁用户",
      category: "家用垃圾袋",
      sellingPoints: "轻便，大容量，不易破，湿热厨余也能安心承装，承重耐装，500只囤货，性价比高，艾草祛味，抽绳自动收口",
      notes: "绿色卷装抽绳垃圾袋，包装有 500只、防臭、抽绳自动收口。",
      generateDetail: true
    };
    await assert.rejects(
      generator.generate(task, makeBrand(), [{ sourceName: "trash-bag.png", path: productPath, mimeType: "image/png" }], makeAnalysis(), path.join(tmp, "out")),
      /所有主图均生成失败/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(prompts.length, 13);
  assert.match(prompts[0], /卖点证明矩阵/);
  assert.match(prompts[0], /未展开卷装堆叠/);
  assert.match(prompts[0], /左边卷装 \+ 右边打开袋\/垃圾桶/);
  assert.match(prompts[1], /白色抽绳/);
  assert.match(prompts[1], /不能再做卷装堆叠英雄图/);
  assert.match(prompts[2], /单只袋身完整展开/);
  assert.match(prompts[3], /抽绳袋口、袋身边缘和袋底|袋口抽绳、袋身边缘、袋底/);
  assert.match(prompts[4], /收纳柜\/厨房抽屉/);
  assert.match(prompts[7], /抽绳动作屏/);
  assert.doesNotMatch(prompts.slice(0, 5).join("\n"), /本屏角色：详情页/);
});

test("native generator retries only one bad asset in a full 5+8 set and preserves the other twelve hashes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-dimension-retry-"));
  const productPath = path.join(tmp, "product.png");
  const outDir = path.join(tmp, "out");
  await writeNoiseImage(productPath, 600, 600);
  const squareImages = await Promise.all(
    ["#dce8c5", "#f0d9c2", "#c8dff0", "#ead0df", "#d9d2ef"]
      .map((background) => largeImageBuffer(1024, 1024, background))
  );
  const detailImages = await Promise.all(
    ["#d7e6c4", "#f2dfbf", "#c4dff2", "#ebcddd", "#d8d0ef", "#cce8e1", "#eed5c6", "#d1dcf0"]
      .map((background) => largeImageBuffer(1024, 1822, background))
  );
  const wrongDetailImage = await largeImageBuffer(512, 768, "#ffccaa");
  const taskMeta = new Map<string, { role: "main" | "detail"; index: number; attempt: number }>();
  const promptMeta = new Map<string, { role: "main" | "detail"; index: number; attempts: number }>();
  let submissionCount = 0;
  let mainPromptCount = 0;
  let detailPromptCount = 0;
  let hashesBeforeRetry: Map<string, string> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { task_id?: string };
      return new Response(JSON.stringify({ code: 200, data: { status: "completed", image_url: `https://images.example/${body.task_id}.png` } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.startsWith("https://images.example/")) {
      const taskId = url.split("/").pop()?.replace(/\.png$/, "") ?? "";
      const meta = taskMeta.get(taskId);
      assert.ok(meta);
      const shouldReturnWrongDetail = meta.role === "detail" && meta.index === 3 && meta.attempt === 1;
      if (shouldReturnWrongDetail) {
        return new Response(new Uint8Array(wrongDetailImage), {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      }
      const image = meta.role === "main" ? squareImages[meta.index - 1] : detailImages[meta.index - 1];
      return new Response(new Uint8Array(image), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { aspectRatio?: string; prompt?: string };
    submissionCount += 1;
    const taskId = `task-${submissionCount}`;
    const prompt = String(body.prompt ?? "");
    let meta = promptMeta.get(prompt);
    if (!meta) {
      const role = body.aspectRatio === "9:16" ? "detail" : "main";
      meta = {
        role,
        index: role === "main" ? ++mainPromptCount : ++detailPromptCount,
        attempts: 0
      };
      promptMeta.set(prompt, meta);
    }
    meta.attempts += 1;
    taskMeta.set(taskId, { role: meta.role, index: meta.index, attempt: meta.attempts });
    if (meta.role === "detail" && meta.index === 3 && meta.attempts === 2) {
      hashesBeforeRetry = await hashNativePngOutputs(outDir);
      assert.equal(hashesBeforeRetry.size, 12);
      assert.equal(Array.from(hashesBeforeRetry.keys()).some((key) => /^detail\/03-/.test(key)), false);
    }
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: taskId } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const config = makeConfig(tmp);
    config.openai.aiEchoResolution = "1k";
    const generator = new OpenAiImageGenerator(config);
    const result = await generator.generate(
      { ...makeTask(tmp, productPath), mainImageCount: 5, generateDetail: true },
      makeBrand(),
      [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
      makeAnalysis(),
      outDir
    );

    assert.equal(result.failures?.length ?? 0, 0);
    assert.equal(result.mainImages.length, 5);
    assert.equal(result.detailImages.length, 8);
    assert.equal(submissionCount, 14);
    assert.ok(hashesBeforeRetry);
    assert.deepEqual(await hashNativePngOutputs(outDir, /^detail\/03-/), hashesBeforeRetry);
    const retriedDetail = result.detailImages.find((image) => image.index === 3);
    assert.ok(retriedDetail);
    assert.equal(retriedDetail.attempts, 2);
    const metadata = await sharp(retriedDetail.path).metadata();
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, 1822);
    const prompts = JSON.parse(await fs.readFile(result.promptsPath!, "utf8")) as Array<Record<string, unknown>>;
    assert.equal(prompts.length, 13);
    const detailPrompt = prompts.find((item) => item.role === "detail" && item.index === 3);
    assert.equal(detailPrompt?.status, "completed");
    assert.equal(detailPrompt?.attempts, 2);
    const invalidFiles = await fs.readdir(path.join(outDir, "raw", "invalid-native"));
    assert.equal(invalidFiles.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native generator keeps failed prompt records when wrong dimensions keep failing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-dimension-failure-record-"));
  const productPath = path.join(tmp, "product.png");
  const outDir = path.join(tmp, "out");
  await writeNoiseImage(productPath, 600, 600);
  const squareImage = await largeImageBuffer(1024, 1024);
  const detailImage = await largeImageBuffer(1024, 1822);
  const wrongDetailImage = await largeImageBuffer(512, 768);
  const taskMeta = new Map<string, { role: "main" | "detail"; shouldFail?: boolean }>();
  let submissionCount = 0;
  let detailSubmissionCount = 0;
  let failingPrompt = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/result")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { task_id?: string };
      return new Response(JSON.stringify({ code: 200, data: { status: "completed", image_url: `https://images.example/${body.task_id}.png` } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.startsWith("https://images.example/")) {
      const taskId = url.split("/").pop()?.replace(/\.png$/, "") ?? "";
      const meta = taskMeta.get(taskId);
      return new Response(new Uint8Array(meta?.shouldFail ? wrongDetailImage : meta?.role === "main" ? squareImage : detailImage), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { aspectRatio?: string; prompt?: string };
    submissionCount += 1;
    const taskId = `task-${submissionCount}`;
    if (body.aspectRatio === "9:16") {
      detailSubmissionCount += 1;
      if (detailSubmissionCount === 2) failingPrompt = String(body.prompt ?? "");
      taskMeta.set(taskId, { role: "detail", shouldFail: String(body.prompt ?? "") === failingPrompt });
    } else {
      taskMeta.set(taskId, { role: "main" });
    }
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: taskId } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const config = makeConfig(tmp);
    config.openai.aiEchoResolution = "1k";
    const generator = new OpenAiImageGenerator(config);
    const result = await generator.generate(
      { ...makeTask(tmp, productPath), mainImageCount: 1, generateDetail: true },
      makeBrand(),
      [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
      makeAnalysis(),
      outDir
    );

    assert.equal(result.failures?.length, 1);
    assert.equal(result.detailImages.length, 7);
    // Three normal attempts plus two single-item recovery attempts keep trying
    // the failed page without regenerating the eight successful assets.
    assert.equal(submissionCount, 13);
    const prompts = JSON.parse(await fs.readFile(result.promptsPath!, "utf8")) as Array<Record<string, unknown>>;
    assert.equal(prompts.length, 9);
    const failedPrompt = prompts.find((item) => item.role === "detail" && item.index === 2);
    assert.equal(failedPrompt?.status, "failed");
    // Prompt records keep the primary scheduler attempt count; recovery retries
    // are reflected in submissionCount and failure metadata instead.
    assert.equal(failedPrompt?.attempts, 3);
    assert.match(String(failedPrompt?.error ?? ""), /validation|尺寸|比例|dimension|ratio/i);
    await assert.rejects(fs.access(String(failedPrompt?.path)));
    const invalidFiles = await fs.readdir(path.join(outDir, "raw", "invalid-native"));
    // Every rejected render is quarantined for diagnosis: three scheduler
    // attempts plus two recovery attempts.
    assert.equal(invalidFiles.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native OpenAI provider falls back to Responses image_generation when image endpoint is unsupported", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-openai-responses-image-"));
  const productPath = path.join(tmp, "product.png");
  const generatedPath = path.join(tmp, "generated.png");
  await writeNoiseImage(productPath, 600, 600);
  await writeNoiseImage(generatedPath, 1024, 1024);
  const generatedBase64 = (await fs.readFile(generatedPath)).toString("base64");
  const responsesBodies: Array<Record<string, unknown>> = [];
  let imageEditsCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/images/edits")) {
      imageEditsCalls += 1;
      return new Response(JSON.stringify({ error: { message: "codex channel: endpoint not supported" } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.endsWith("/responses")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      responsesBodies.push(body);
      const sse = [
        "event: response.created",
        `data: ${JSON.stringify({ type: "response.created", response: { status: "in_progress" } })}`,
        "",
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [{ type: "image_generation_call", result: generatedBase64 }]
          }
        })}`,
        "",
        "data: [DONE]",
        ""
      ].join("\n");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;
  try {
    const config = makeConfig(tmp);
    config.openai.imageProvider = "openai";
    config.openai.apiKey = "test-key";
    config.openai.textModel = "gpt-5.5";
    const generator = new OpenAiImageGenerator(config);
    const result = await generator.generate(
      {
        ...makeTask(tmp, productPath),
        mainImageCount: 1,
        generateDetail: false
      },
      makeBrand(),
      [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
      makeAnalysis(),
      path.join(tmp, "out")
    );

    assert.equal(result.mainImages.length, 1);
    assert.equal(result.failures?.length ?? 0, 0);
    assert.equal(imageEditsCalls, 1);
    assert.equal(responsesBodies.length, 1);
    assert.equal(responsesBodies[0].stream, false);
    assert.equal(responsesBodies[0].store, false);
    assert.equal((responsesBodies[0].tools as Array<Record<string, unknown>>)[0].type, "image_generation");
    assert.equal((responsesBodies[0].tools as Array<Record<string, unknown>>)[0].model, "gpt-image-2");
    assert.equal((responsesBodies[0].tools as Array<Record<string, unknown>>)[0].size, "1024x1024");
    const metadata = await sharp(result.mainImages[0].path).metadata();
    assert.equal(metadata.width, 2048);
    assert.equal(metadata.height, 2048);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native OpenAI provider can use Responses image_generation directly", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-openai-direct-responses-image-"));
  const productPath = path.join(tmp, "product.png");
  const generatedPath = path.join(tmp, "generated.png");
  await writeNoiseImage(productPath, 600, 600);
  await writeNoiseImage(generatedPath, 1024, 1024);
  const generatedBase64 = (await fs.readFile(generatedPath)).toString("base64");
  const responsesBodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  const originalMode = process.env.OPENAI_IMAGE_API_MODE;
  const originalResponseModel = process.env.OPENAI_IMAGE_RESPONSE_MODEL;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/images/edits")) throw new Error("Images endpoint must not be called");
    if (url.endsWith("/responses")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      responsesBodies.push(body);
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "image_generation_call", result: generatedBase64 }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;
  process.env.OPENAI_IMAGE_API_MODE = "responses";
  process.env.OPENAI_IMAGE_RESPONSE_MODEL = "relay-driver-model";

  try {
    const config = makeConfig(tmp);
    config.openai.imageProvider = "openai";
    config.openai.apiKey = "test-key";
    const result = await new OpenAiImageGenerator(config).generate(
      { ...makeTask(tmp, productPath), mainImageCount: 1, generateDetail: false },
      makeBrand(),
      [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
      makeAnalysis(),
      path.join(tmp, "out")
    );

    assert.equal(result.mainImages.length, 1);
    assert.equal(result.failures?.length ?? 0, 0);
    assert.equal(responsesBodies.length, 1);
    assert.equal(responsesBodies[0].model, "relay-driver-model");
    assert.equal((responsesBodies[0].tools as Array<Record<string, unknown>>)[0].model, "gpt-image-2");
  } finally {
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("OPENAI_IMAGE_API_MODE", originalMode);
    restoreTestEnvironment("OPENAI_IMAGE_RESPONSE_MODEL", originalResponseModel);
  }
});

test("native OpenAI provider standardizes Responses vertical images to detail-page size", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-openai-responses-detail-size-"));
  const productPath = path.join(tmp, "product.png");
  const squarePath = path.join(tmp, "square.png");
  const verticalPath = path.join(tmp, "vertical.png");
  await writeNoiseImage(productPath, 600, 600);
  await writeNoiseImage(squarePath, 1024, 1024);
  await writeNoiseImage(verticalPath, 1024, 1536);
  const squareBase64 = (await fs.readFile(squarePath)).toString("base64");
  const verticalBase64 = (await fs.readFile(verticalPath)).toString("base64");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/images/edits")) {
      return new Response(JSON.stringify({ error: { message: "endpoint not supported" } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.endsWith("/responses")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: Array<{ size?: string }> };
      const size = body.tools?.[0]?.size ?? "";
      const result = size === "1024x1536" ? verticalBase64 : squareBase64;
      const sse = [
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [{ type: "image_generation_call", result }]
          }
        })}`,
        "",
        "data: [DONE]",
        ""
      ].join("\n");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;
  try {
    const config = makeConfig(tmp);
    config.openai.imageProvider = "openai";
    config.openai.apiKey = "test-key";
    config.openai.textModel = "gpt-5.5";
    const generator = new OpenAiImageGenerator(config);
    const result = await generator.generate(
      {
        ...makeTask(tmp, productPath),
        mainImageCount: 1,
        generateDetail: true
      },
      makeBrand(),
      [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
      makeAnalysis(),
      path.join(tmp, "out")
    );

    assert.equal(result.failures?.length ?? 0, 0);
    assert.equal(result.mainImages.length, 1);
    assert.equal(result.detailImages.length, 8);
    const detailMeta = await sharp(result.detailImages[0].path).metadata();
    assert.equal(detailMeta.width, 2048);
    assert.equal(detailMeta.height, 3642);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reuse validation standardizes a candidate without modifying the formal image when quality fails", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-reuse-candidate-"));
  const productPath = path.join(tmp, "product.png");
  const outputPath = path.join(tmp, "out", "main", "01-商品首图.png");
  await writeNoiseImage(productPath, 600, 600);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const original = await largeImageBuffer(512, 512, "#8b5d3b");
  await fs.writeFile(outputPath, original);
  const originalHash = createHash("sha256").update(original).digest("hex");
  const options = makeDirectAiEchoAssetOptions(tmp, productPath, outputPath);
  const generator = new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp));
  const reuseGenerator = generator as unknown as {
    reuseNativeAsset(spec: typeof options.spec, formalPath: string): Promise<unknown | null>;
  };

  const reused = await reuseGenerator.reuseNativeAsset(options.spec, outputPath);

  assert.equal(reused, null);
  const preserved = await fs.readFile(outputPath);
  assert.equal(createHash("sha256").update(preserved).digest("hex"), originalHash);
  assert.equal((await sharp(outputPath).metadata()).width, 512);
  const leftovers = (await fs.readdir(path.dirname(outputPath))).filter((name) => name.endsWith(".reuse.part"));
  assert.deepEqual(leftovers, []);
});

test("aiEcho generator persists a task id before polling interruption and restart does not POST again", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-restart-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const imageBuffer = await largeImageBuffer(1024, 1024);
  const options = makeDirectAiEchoAssetOptions(tmp, productPath);
  const ledgerPath = path.join(tmp, "out", "raw", "aiecho-tasks.json");
  const originalFetch = globalThis.fetch;
  const originalPollInterval = process.env.AIECHO_IMAGE_POLL_INTERVAL_MS;
  let submitCount = 0;
  let pollingInterrupted = true;
  process.env.AIECHO_IMAGE_POLL_INTERVAL_MS = "250";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://cdn.example.test/restart.png") {
      return new Response(new Uint8Array(imageBuffer), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/result")) {
      return pollingInterrupted
        ? new Response(JSON.stringify({ code: 200, data: { status: "interrupted-after-persist" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
        : new Response(JSON.stringify({
          code: 200,
          data: { status: "completed", image_url: "https://cdn.example.test/restart.png" }
        }), { status: 200, headers: { "content-type": "application/json" } });
    }
    submitCount += 1;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: "persisted-task-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options),
      /未知状态/
    );
    const interruptedEntry = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(interruptedEntry.status, "polling");
    assert.equal(interruptedEntry.localTaskId, "persisted-task-id");
    assert.equal(interruptedEntry.attempts, 1);

    pollingInterrupted = false;
    const result = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp))
      .generateValidatedNativeAsset(options);
    assert.equal(result.taskId, "persisted-task-id");
    assert.equal(submitCount, 1);
    const completedEntry = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(completedEntry.status, "completed");
    assert.equal(completedEntry.attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("AIECHO_IMAGE_POLL_INTERVAL_MS", originalPollInterval);
  }
});

test("aiEcho generator keeps one POST across a pending local wait timeout and restart", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-timeout-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const imageBuffer = await largeImageBuffer(1024, 1024);
  const options = makeDirectAiEchoAssetOptions(tmp, productPath);
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const originalPollInterval = process.env.AIECHO_IMAGE_POLL_INTERVAL_MS;
  const originalTimeout = process.env.AIECHO_IMAGE_TIMEOUT_MS;
  let submitCount = 0;
  let pending = true;
  process.env.AIECHO_IMAGE_POLL_INTERVAL_MS = "250";
  process.env.AIECHO_IMAGE_TIMEOUT_MS = "60000";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://cdn.example.test/pending-timeout.png") {
      return new Response(new Uint8Array(imageBuffer), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/result")) {
      return pending
        ? new Response(JSON.stringify({ code: 200, data: { status: "pending" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
        : new Response(JSON.stringify({
          code: 200,
          data: { status: "completed", image_url: "https://cdn.example.test/pending-timeout.png" }
        }), { status: 200, headers: { "content-type": "application/json" } });
    }
    submitCount += 1;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: "pending-task-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const baseNow = originalDateNow();
    let nowCalls = 0;
    Date.now = () => baseNow + (nowCalls++ < 2 ? 0 : 60_001);
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options),
      /aiEcho 生图超时/
    );
    Date.now = originalDateNow;
    pending = false;

    const result = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp))
      .generateValidatedNativeAsset(options);
    assert.equal(result.taskId, "pending-task-id");
    assert.equal(submitCount, 1);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("AIECHO_IMAGE_POLL_INTERVAL_MS", originalPollInterval);
    restoreTestEnvironment("AIECHO_IMAGE_TIMEOUT_MS", originalTimeout);
  }
});

test("aiEcho generator retries a polling network interruption without a second POST", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-network-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const imageBuffer = await largeImageBuffer(1024, 1024);
  const options = makeDirectAiEchoAssetOptions(tmp, productPath);
  const originalFetch = globalThis.fetch;
  const originalPollInterval = process.env.AIECHO_IMAGE_POLL_INTERVAL_MS;
  let submitCount = 0;
  let resultChecks = 0;
  process.env.AIECHO_IMAGE_POLL_INTERVAL_MS = "250";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://cdn.example.test/network-resume.png") {
      return new Response(new Uint8Array(imageBuffer), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/result")) {
      resultChecks += 1;
      if (resultChecks === 1) {
        throw Object.assign(new Error("poll socket reset"), { cause: { code: "ECONNRESET" } });
      }
      return new Response(JSON.stringify({
        code: 200,
        data: { status: "completed", image_url: "https://cdn.example.test/network-resume.png" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    submitCount += 1;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: "network-task-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const result = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp))
      .generateValidatedNativeAsset(options);
    assert.equal(result.taskId, "network-task-id");
    assert.equal(resultChecks, 2);
    assert.equal(submitCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("AIECHO_IMAGE_POLL_INTERVAL_MS", originalPollInterval);
  }
});

test("aiEcho generator keeps the same task after a local Sharp decode failure", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-sharp-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const validImage = await largeImageBuffer(1024, 1024);
  const options = makeDirectAiEchoAssetOptions(tmp, productPath);
  const ledgerPath = path.join(tmp, "out", "raw", "aiecho-tasks.json");
  const originalFetch = globalThis.fetch;
  const originalPollInterval = process.env.AIECHO_IMAGE_POLL_INTERVAL_MS;
  let submitCount = 0;
  let serveInvalidImage = true;
  process.env.AIECHO_IMAGE_POLL_INTERVAL_MS = "250";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://cdn.example.test/sharp-resume.png") {
      return new Response(
        serveInvalidImage ? new Uint8Array([1, 2, 3, 4, 5, 6]) : new Uint8Array(validImage),
        { status: 200, headers: { "content-type": "image/png" } }
      );
    }
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({
        code: 200,
        data: { status: "completed", image_url: "https://cdn.example.test/sharp-resume.png" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    submitCount += 1;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: "sharp-task-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options)
    );
    await assert.rejects(fs.access(options.outputPath));
    assert.equal((await fs.stat(`${options.outputPath}.part`)).isFile(), true);
    const failedLocally = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(failedLocally.status, "validating");
    assert.equal(failedLocally.localTaskId, "sharp-task-id");
    assert.equal(failedLocally.attempts, 1);

    serveInvalidImage = false;
    const recovered = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp))
      .generateValidatedNativeAsset(options);
    assert.equal(recovered.taskId, "sharp-task-id");
    assert.equal(submitCount, 1);
    assert.equal((await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0].status, "completed");
  } finally {
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("AIECHO_IMAGE_POLL_INTERVAL_MS", originalPollInterval);
  }
});

test("aiEcho generator leaves a partial candidate on response stream interruption and resumes the same task", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-stream-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const validImage = await largeImageBuffer(1024, 1024);
  const partialBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const options = makeDirectAiEchoAssetOptions(tmp, productPath);
  const ledgerPath = path.join(tmp, "out", "raw", "aiecho-tasks.json");
  const originalFetch = globalThis.fetch;
  const originalPollInterval = process.env.AIECHO_IMAGE_POLL_INTERVAL_MS;
  let submitCount = 0;
  let interruptStream = true;
  process.env.AIECHO_IMAGE_POLL_INTERVAL_MS = "250";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://cdn.example.test/stream-resume.png") {
      if (interruptStream) {
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(partialBytes);
              return;
            }
            controller.error(new Error("injected response stream interruption"));
          }
        });
        return new Response(stream, { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(new Uint8Array(validImage), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({
        code: 200,
        data: { status: "completed", image_url: "https://cdn.example.test/stream-resume.png" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    submitCount += 1;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: "stream-task-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options),
      /stream interruption/
    );
    await assert.rejects(fs.access(options.outputPath));
    assert.equal((await fs.stat(`${options.outputPath}.part`)).size, partialBytes.byteLength);
    const interrupted = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(interrupted.status, "downloading");
    assert.equal(interrupted.localTaskId, "stream-task-id");

    interruptStream = false;
    const recovered = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp))
      .generateValidatedNativeAsset(options);
    assert.equal(recovered.taskId, "stream-task-id");
    assert.equal(submitCount, 1);
    await assert.rejects(fs.access(`${options.outputPath}.part`));
  } finally {
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("AIECHO_IMAGE_POLL_INTERVAL_MS", originalPollInterval);
  }
});

test("aiEcho generator recovers a known task id when backup succeeds and the primary write fails", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-submit-window-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const validImage = await largeImageBuffer(1024, 1024);
  const options = makeDirectAiEchoAssetOptions(tmp, productPath);
  const ledgerPath = path.join(tmp, "out", "raw", "aiecho-tasks.json");
  let failNextPrimary = false;
  const ledger = new AiEchoTaskLedger(ledgerPath, {
    beforeAtomicWrite(target) {
      if (target === "primary" && failNextPrimary) {
        failNextPrimary = false;
        throw new Error("injected primary failure after backup");
      }
    }
  });
  const identity: AiEchoTaskIdentity = {
    fingerprint: createAiEchoTaskFingerprint({
      stableProductInput: { sku: "submit-window" },
      referenceImageHashes: ["a".repeat(64)],
      role: "main",
      index: 1,
      aspectRatio: "1:1",
      model: "gpt-2.0",
      resolution: "1k"
    }),
    role: "main",
    index: 1,
    aspectRatio: "1:1",
    model: "gpt-2.0",
    resolution: "1k"
  };
  await ledger.ensureEntries([identity]);
  options.aiEchoLedger = { ledger, identity };
  const originalFetch = globalThis.fetch;
  const originalPollInterval = process.env.AIECHO_IMAGE_POLL_INTERVAL_MS;
  let submitCount = 0;
  process.env.AIECHO_IMAGE_POLL_INTERVAL_MS = "250";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://cdn.example.test/submit-window.png") {
      return new Response(new Uint8Array(validImage), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({
        code: 200,
        data: { status: "completed", image_url: "https://cdn.example.test/submit-window.png" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    submitCount += 1;
    failNextPrimary = true;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: "backup-window-task-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const result = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp))
      .generateValidatedNativeAsset(options);
    assert.equal(result.taskId, "backup-window-task-id");
    assert.equal(submitCount, 1);
    const completed = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(completed.status, "completed");
    assert.equal(completed.localTaskId, "backup-window-task-id");
    assert.equal(completed.attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("AIECHO_IMAGE_POLL_INTERVAL_MS", originalPollInterval);
  }
});

test("aiEcho generator keeps an interrupted download as part and restart resumes the same task", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-download-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const imageBuffer = await largeImageBuffer(1024, 1024);
  const outputPath = path.join(tmp, "out", "main", "01-商品首图.png");
  const options = makeDirectAiEchoAssetOptions(tmp, productPath, outputPath);
  const ledgerPath = path.join(tmp, "out", "raw", "aiecho-tasks.json");
  const originalFetch = globalThis.fetch;
  const originalPollInterval = process.env.AIECHO_IMAGE_POLL_INTERVAL_MS;
  let submitCount = 0;
  let imageDownloads = 0;
  process.env.AIECHO_IMAGE_POLL_INTERVAL_MS = "250";
  await fs.mkdir(outputPath, { recursive: true });
  const renameBlockerPath = path.join(outputPath, "force-atomic-rename-failure.txt");
  await fs.writeFile(renameBlockerPath, "fault injection", "utf8");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://cdn.example.test/download-resume.png") {
      imageDownloads += 1;
      return new Response(new Uint8Array(imageBuffer), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({
        code: 200,
        data: { status: "completed", image_url: "https://cdn.example.test/download-resume.png" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    submitCount += 1;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: "download-task-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options)
    );
    assert.equal((await fs.stat(`${outputPath}.part`)).isFile(), true);
    const interruptedEntry = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(interruptedEntry.status, "validating");
    assert.equal(interruptedEntry.localTaskId, "download-task-id");
    assert.equal((await fs.stat(outputPath)).isFile(), false);

    await fs.unlink(renameBlockerPath);
    await fs.rmdir(outputPath);
    const result = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp))
      .generateValidatedNativeAsset(options);
    assert.equal(result.taskId, "download-task-id");
    assert.equal(submitCount, 1);
    assert.equal(imageDownloads, 2);
    await assert.rejects(fs.access(`${outputPath}.part`));
    assert.equal((await fs.stat(outputPath)).isFile(), true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("AIECHO_IMAGE_POLL_INTERVAL_MS", originalPollInterval);
  }
});

test("explicit visual replacement resumes the same task when formal replace succeeds before completion persistence fails", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-visual-completion-window-"));
  const productPath = path.join(tmp, "product.png");
  const outputPath = path.join(tmp, "out", "main", "01-商品首图.png");
  await writeNoiseImage(productPath, 600, 600);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const oldImage = await largeImageBuffer(1024, 1024, "#6f4e37");
  const replacementImage = await largeImageBuffer(1024, 1024, "#d8c9a7");
  await fs.writeFile(outputPath, oldImage);
  const oldHash = createHash("sha256").update(oldImage).digest("hex");
  const ledgerPath = path.join(tmp, "out", "raw", "aiecho-tasks.json");
  let failAfterFormalReplace = false;
  const faultedLedger = new AiEchoTaskLedger(ledgerPath, {
    async beforeAtomicWrite(target) {
      if (target !== "backup" || !failAfterFormalReplace) return;
      const formalBytes = await fs.readFile(outputPath);
      const formalHash = createHash("sha256").update(formalBytes).digest("hex");
      if (formalHash !== oldHash) {
        failAfterFormalReplace = false;
        throw new Error("injected completion persistence failure after formal replace");
      }
    }
  });
  const identity: AiEchoTaskIdentity = {
    fingerprint: createAiEchoTaskFingerprint({
      stableProductInput: { sku: "visual-completion-window" },
      referenceImageHashes: ["c".repeat(64)],
      role: "main",
      index: 1,
      aspectRatio: "1:1",
      model: "gpt-2.0",
      resolution: "1k"
    }),
    role: "main",
    index: 1,
    aspectRatio: "1:1",
    model: "gpt-2.0",
    resolution: "1k"
  };
  await faultedLedger.ensureEntries([identity]);
  await faultedLedger.markCompleted(identity.fingerprint, "existing-valid-file");
  const options = makeDirectAiEchoAssetOptions(tmp, productPath, outputPath);
  options.aiEchoLedger = { ledger: faultedLedger, identity };
  options.forceNewSubmission = true;
  const originalFetch = globalThis.fetch;
  const originalPollInterval = process.env.AIECHO_IMAGE_POLL_INTERVAL_MS;
  let submitCount = 0;
  let downloadCount = 0;
  process.env.AIECHO_IMAGE_POLL_INTERVAL_MS = "250";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://cdn.example.test/visual-completion-window.png") {
      downloadCount += 1;
      return new Response(new Uint8Array(replacementImage), {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({
        code: 200,
        data: { status: "completed", image_url: "https://cdn.example.test/visual-completion-window.png" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    submitCount += 1;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: "visual-replacement-task-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    failAfterFormalReplace = true;
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options),
      /completion persistence failure/
    );
    const formalAfterFailure = await fs.readFile(outputPath);
    assert.notEqual(createHash("sha256").update(formalAfterFailure).digest("hex"), oldHash);
    assert.equal((await sharp(outputPath).metadata()).width, 1024);
    const interrupted = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(interrupted.status, "validating");
    assert.equal(interrupted.localTaskId, "visual-replacement-task-id");
    assert.equal(submitCount, 1);

    options.aiEchoLedger = { ledger: new AiEchoTaskLedger(ledgerPath), identity };
    const recovered = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp))
      .generateValidatedNativeAsset(options);
    assert.equal(recovered.taskId, "visual-replacement-task-id");
    assert.equal(submitCount, 1);
    assert.equal(downloadCount, 2);
    const completed = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(completed.status, "completed");
    assert.equal(completed.localTaskId, "visual-replacement-task-id");
  } finally {
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("AIECHO_IMAGE_POLL_INTERVAL_MS", originalPollInterval);
  }
});

test("aiEcho generator fails closed with zero provider calls when both ledger files are corrupt", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-corrupt-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const options = makeDirectAiEchoAssetOptions(tmp, productPath);
  const ledgerPath = path.join(tmp, "out", "raw", "aiecho-tasks.json");
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, "{corrupt-primary", "utf8");
  await fs.writeFile(`${ledgerPath}.bak`, "{corrupt-backup", "utf8");
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw new Error("provider must not be called");
  }) as typeof fetch;

  try {
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options),
      /主文件和备份都无法安全读取/
    );
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aiEcho generator marks an uncertain submit ambiguous and restart never POSTs again", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-ambiguous-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const validExistingImage = await largeImageBuffer(1024, 1024);
  const options = makeDirectAiEchoAssetOptions(tmp, productPath);
  const ledgerPath = path.join(tmp, "out", "raw", "aiecho-tasks.json");
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw Object.assign(new Error("submit response was lost"), { cause: { code: "ECONNRESET" } });
  }) as typeof fetch;

  try {
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options),
      /已停止自动重提/
    );
    const ambiguousEntry = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(ambiguousEntry.status, "ambiguous");
    assert.equal(ambiguousEntry.localTaskId, undefined);
    assert.equal(providerCalls, 1);

    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options),
      /已停止自动重提/
    );
    assert.equal(providerCalls, 1);

    // Even a structurally valid file at the normal output path must not wash
    // away the uncertain paid submission through the reuse fast path.
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.writeFile(options.outputPath, validExistingImage);
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generate(
        options.task,
        makeBrand(),
        options.productImages,
        makeAnalysis(),
        path.join(tmp, "out")
      ),
      /已停止自动重提/
    );
    const stillAmbiguous = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(stillAmbiguous.status, "ambiguous");
    assert.equal(providerCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aiEcho generator never resubmits a completed legacy file after that file is deleted", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-completed-no-id-"));
  const productPath = path.join(tmp, "product.png");
  const outputDir = path.join(tmp, "out");
  const outputPath = path.join(outputDir, "main", "01-商品首图.png");
  await writeNoiseImage(productPath, 600, 600);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, await largeImageBuffer(1024, 1024));
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw new Error("provider must not be called");
  }) as typeof fetch;
  const task = { ...makeTask(tmp, productPath), mainImageCount: 1, generateDetail: false };
  const productImages = [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }] as const;
  const ledgerPath = path.join(outputDir, "raw", "aiecho-tasks.json");

  try {
    const first = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generate(
      task,
      makeBrand(),
      [...productImages],
      makeAnalysis(),
      outputDir
    );
    assert.equal(first.mainImages.length, 1);
    assert.equal(providerCalls, 0);
    const reconciled = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(reconciled.status, "completed");
    assert.equal(reconciled.localTaskId, undefined);

    await fs.unlink(outputPath);
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generate(
        task,
        makeBrand(),
        [...productImages],
        makeAnalysis(),
        outputDir
      ),
      /所有主图均生成失败/
    );
    assert.equal(providerCalls, 0);
    const terminal = (await new AiEchoTaskLedger(ledgerPath).snapshot()).tasks[0];
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.localTaskId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aiEcho generator keeps one POST across polling HTTP 503 and restart", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-503-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const imageBuffer = await largeImageBuffer(1024, 1024);
  const options = makeDirectAiEchoAssetOptions(tmp, productPath);
  const originalFetch = globalThis.fetch;
  const originalPollInterval = process.env.AIECHO_IMAGE_POLL_INTERVAL_MS;
  let submitCount = 0;
  let serviceUnavailable = true;
  process.env.AIECHO_IMAGE_POLL_INTERVAL_MS = "250";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://cdn.example.test/http-503-resume.png") {
      return new Response(new Uint8Array(imageBuffer), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/result")) {
      return serviceUnavailable
        ? new Response(JSON.stringify({ code: 503, msg: "temporary unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        })
        : new Response(JSON.stringify({
          code: 200,
          data: { status: "completed", image_url: "https://cdn.example.test/http-503-resume.png" }
        }), { status: 200, headers: { "content-type": "application/json" } });
    }
    submitCount += 1;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: "http-503-task-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options),
      /HTTP 503/
    );
    serviceUnavailable = false;
    const result = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp))
      .generateValidatedNativeAsset(options);
    assert.equal(result.taskId, "http-503-task-id");
    assert.equal(submitCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("AIECHO_IMAGE_POLL_INTERVAL_MS", originalPollInterval);
  }
});

test("aiEcho generator redownloads a deleted completed file from the same task", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "native-aiecho-ledger-redownload-"));
  const productPath = path.join(tmp, "product.png");
  await writeNoiseImage(productPath, 600, 600);
  const imageBuffer = await largeImageBuffer(1024, 1024);
  const options = makeDirectAiEchoAssetOptions(tmp, productPath);
  const originalFetch = globalThis.fetch;
  const originalPollInterval = process.env.AIECHO_IMAGE_POLL_INTERVAL_MS;
  let submitCount = 0;
  let imageDownloads = 0;
  process.env.AIECHO_IMAGE_POLL_INTERVAL_MS = "250";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://cdn.example.test/redownload.png") {
      imageDownloads += 1;
      return new Response(new Uint8Array(imageBuffer), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/result")) {
      return new Response(JSON.stringify({
        code: 200,
        data: { status: "completed", image_url: "https://cdn.example.test/redownload.png" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    submitCount += 1;
    return new Response(JSON.stringify({ code: 200, data: { local_task_id: "redownload-task-id" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp)).generateValidatedNativeAsset(options);
    await fs.unlink(options.outputPath);
    const result = await new OpenAiImageGenerator(makeOneKilobyteAiEchoConfig(tmp))
      .generateValidatedNativeAsset(options);
    assert.equal(result.taskId, "redownload-task-id");
    assert.equal(submitCount, 1);
    assert.equal(imageDownloads, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreTestEnvironment("AIECHO_IMAGE_POLL_INTERVAL_MS", originalPollInterval);
  }
});

function makeDirectAiEchoAssetOptions(
  tmp: string,
  productPath: string,
  outputPath = path.join(tmp, "out", "main", "01-商品首图.png")
): Parameters<OpenAiImageGenerator["generateValidatedNativeAsset"]>[0] {
  return {
    spec: {
      role: "main",
      index: 1,
      title: "商品首图",
      aspectRatio: "1:1",
      copy: ["测试主张"],
      prompt: "CURRENT FRAME MISSION: render the exact product in a clean square ecommerce frame."
    },
    outputPath,
    productImages: [{ sourceName: "product.png", path: productPath, mimeType: "image/png" }],
    task: { ...makeTask(tmp, productPath), mainImageCount: 1, generateDetail: false },
    invalidDir: path.join(tmp, "out", "raw", "invalid-native")
  };
}

function makeOneKilobyteAiEchoConfig(tmp: string): AppConfig {
  const config = makeConfig(tmp);
  config.openai.aiEchoResolution = "1k";
  return config;
}

function restoreTestEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function writeNoiseImage(filePath: string, width: number, height: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const pixels = randomFillSync(Buffer.alloc(width * height * 3));
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(filePath);
}

async function largeImageBuffer(width: number, height: number, background = "#dce8c5"): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background
    }
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

async function hashNativePngOutputs(outputDir: string, exclude?: RegExp): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const group of ["main", "detail"] as const) {
    const directory = path.join(outputDir, group);
    const files = await fs.readdir(directory).catch(() => [] as string[]);
    for (const file of files.filter((candidate) => candidate.toLowerCase().endsWith(".png")).sort()) {
      const key = `${group}/${file}`;
      if (exclude?.test(key)) continue;
      const bytes = await fs.readFile(path.join(directory, file));
      result.set(key, createHash("sha256").update(bytes).digest("hex"));
    }
  }
  return result;
}

function makeTask(tmp: string, productPath: string): ProductTask {
  return {
    recordId: "folder:slipper",
    sku: "儿童黄色家居拖鞋",
    brandId: "folder-default",
    productName: "儿童黄色家居拖鞋",
    targetAudience: "3-8岁儿童，购买者是家长",
    targetPlatform: "淘宝/天猫",
    category: "儿童家居鞋",
    productImages: [],
    localProductImages: [productPath],
    referenceImageUrls: ["https://example.test/product.png"],
    referenceProductUrls: [],
    materialDir: tmp,
    mainProductImage: path.basename(productPath),
    outputDir: path.join(tmp, "out"),
    sellingPoints: "",
    specs: "请按孩子实际脚长选择合适尺码",
    bannedElements: "竞品商标；平台水印；夸张促销爆炸贴；随机英文；错误中文",
    referenceKeywords: "儿童拖鞋 夏季 家居鞋 可爱 卡通",
    notes: "保持商品图片中的鞋型、黄色颜色、开放式鞋口、鞋床纹理、外侧卡通图案、蓝色衣服和胡萝卜细节一致。可以露出儿童正脸，但整套图必须保持同一名儿童模特。",
    briefPath: undefined,
    mainImageCount: 5,
    generateDetail: false,
    imageRatio: "1:1"
  };
}

function makeBrand(): BrandProfile {
  return {
    id: "folder-default",
    name: "自有品牌",
    logoPath: "",
    primaryColor: "#3b2f2f",
    secondaryColor: "#d9a441",
    backgroundColor: "#f7f1e8",
    titleFont: "PingFang SC",
    bodyFont: "PingFang SC",
    positioning: "儿童家居类目，真实、干净、适合淘宝天猫货架转化",
    visualKeywords: ["淘宝天猫主图", "商品清晰", "真实居家场景", "暖色自然光"],
    slogan: "",
    referenceImagePaths: [],
    bannedElements: "竞品商标；水印；廉价促销爆炸贴"
  };
}

function makeAnalysis(): ReferenceAnalysis {
  return {
    query: "儿童黄色家居拖鞋",
    references: [],
    summary: "跳过竞品搜索",
    visualPatterns: ["商品足够大", "真实穿着动作"],
    sellingPointPatterns: [],
    detailPagePatterns: []
  };
}

function makeConfig(tmp: string): AppConfig {
  return {
    feishu: { appId: "", appSecret: "", baseAppToken: "", tableId: "", chatId: "" },
    openai: {
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      imageModel: "gpt-image-2",
      textModel: "gpt-5-mini",
      imageProvider: "aiecho",
      imageCompositionMode: "native",
      aiEchoBaseUrl: "https://example.test",
      aiEchoActivationCode: "code",
      aiEchoResolution: "2k",
      imageTunnelProvider: "cloudflared"
    },
    worker: {
      pollIntervalMinutes: 5,
      maxReferences: 5,
      concurrency: 1,
      taskWorkbookPath: path.join(tmp, "tasks.xlsx"),
      skipReferenceSearch: true,
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
