import assert from "node:assert/strict";
import test from "node:test";
import {
  auditCreativePlan,
  buildCreativeDirectorRequestPrompt,
  buildDeterministicCreativePlan,
  compileDirectedFramePrompt,
  normalizeCreativeDirectorResult,
  sanitizeReferenceAnalysisForProduct,
  sanitizeProductVisualInsight
} from "../src/creative-director.ts";
import { buildStoryboardPlan } from "../src/storyboard-planner.ts";
import type { ProductTask, ProductVisualInsight } from "../src/types.ts";

const sellingPoints = ["多语言与方言互动", "趣味语音交互", "多关节可动", "长续航", "孩子贴心玩伴"];

test("compiles a compact frame-first prompt with concrete proof", () => {
  const task = makeTask("Amazon", "English");
  const plan = makePlan(task);
  const frame = plan.frames[1];
  const prompt = compileDirectedFramePrompt({
    task,
    insight: makeInsight(),
    direction: plan.direction,
    frame,
    copy: ["Talk Across Languages", "A playful learning companion"],
    title: "Language interaction",
    aspectRatio: "1:1",
    forbidden: "watermark; unsupported specifications"
  });

  assert.ok(prompt.startsWith("CURRENT FRAME MISSION"));
  assert.ok(prompt.slice(0, 500).includes(frame.focus));
  assert.match(prompt, /Product state\/action:/);
  assert.match(prompt, /Visible proof:/);
  assert.match(prompt, /Language: English/);
  assert.ok(prompt.length >= 1_000);
  assert.ok(prompt.length <= 6_000);
});

test("prompt budgeting preserves critical head and tail contracts under oversized context", () => {
  const task = makeTask("Amazon", "English");
  const plan = makePlan(task);
  const longInsight: ProductVisualInsight = {
    ...makeInsight(),
    summary: "Detailed visual analysis ".repeat(120),
    productFacts: Array.from({ length: 20 }, (_, index) => `confirmed product fact ${index} ${"material detail ".repeat(30)}`),
    visualSellingPoints: Array.from({ length: 16 }, (_, index) => `selling point ${index} ${"visible evidence ".repeat(20)}`),
    promptDirectives: Array.from({ length: 16 }, (_, index) => `directive ${index} ${"preserve identity ".repeat(20)}`),
  };
  const prompt = compileDirectedFramePrompt({
    task,
    insight: longInsight,
    direction: {
      ...plan.direction,
      variationRules: Array.from({ length: 20 }, (_, index) => `variation ${index} ${"different composition ".repeat(20)}`),
    },
    frame: {
      ...plan.frames[0],
      scene: `${plan.frames[0].scene} ${"environment detail ".repeat(100)}`,
      proof: `${plan.frames[0].proof} ${"visible proof ".repeat(100)}`,
    },
    copy: ["AI Companion Robot", "Playful Learning Together"],
    title: "Hero",
    aspectRatio: "1:1",
    forbidden: `watermark; unsupported claims; ${"forbidden item ".repeat(80)}`,
    legacyPrompt: "CATEGORY DETAIL\n" + "legacy visual instruction\n".repeat(300),
  });

  assert.ok(prompt.length <= 6_000);
  assert.ok(prompt.startsWith("CURRENT FRAME MISSION"));
  assert.match(prompt, /FRAME EXECUTION/);
  assert.match(prompt, /Visible proof:/);
  assert.match(prompt, /VISIBLE COPY CONTRACT/);
  assert.match(prompt, /Use only these approved marketing lines:.*AI Companion Robot/);
  assert.match(prompt, /CANVAS AND FINAL CHECK/);
  assert.match(prompt, /Forbidden:/);
  assert.ok(prompt.endsWith("Return the finished image only."));
});

test("complete 5+8 storyboard compiles thirteen independent prompt contracts", () => {
  const task = makeTask("Amazon", "English");
  const plan = makePlan(task);
  const prompts = plan.frames.map((frame) => compileDirectedFramePrompt({
    task,
    insight: makeInsight(),
    direction: plan.direction,
    frame,
    copy: [`Approved Copy ${frame.role} ${frame.index}`],
    title: `${frame.role}-${frame.index}`,
    aspectRatio: frame.role === "main" ? "1:1" : "9:16",
    forbidden: "watermark; unsupported specifications",
  }));

  assert.equal(prompts.length, 13);
  assert.equal(new Set(plan.frames.map((frame) => `${frame.role}:${frame.index}`)).size, 13);
  for (const prompt of prompts) {
    assert.match(prompt, /CURRENT FRAME MISSION/);
    assert.match(prompt, /PRODUCT SOURCE OF TRUTH/);
    assert.match(prompt, /VISIBLE COPY CONTRACT/);
    assert.match(prompt, /CANVAS AND FINAL CHECK/);
  }
});

test("platform style and visible-copy language remain independent", () => {
  const cases = [
    ["国内通用", "简体中文", "Premium domestic", "Simplified Chinese"],
    ["国内通用", "English", "Premium domestic", "English"],
    ["Amazon", "English", "Amazon premium", "English"],
    ["Amazon", "简体中文", "Amazon premium", "Simplified Chinese"]
  ] as const;

  for (const [platform, language, platformToken, languageToken] of cases) {
    const task = makeTask(platform, language);
    const plan = makePlan(task);
    const prompt = compileDirectedFramePrompt({
      task,
      insight: makeInsight(),
      direction: plan.direction,
      frame: plan.frames[0],
      copy: language === "English" ? ["Playful AI Companion"] : ["趣味AI伙伴"],
      title: "Hero",
      aspectRatio: "1:1",
      forbidden: "watermark"
    });
    assert.ok(plan.direction.styleIntent.includes(platformToken), `${platform}/${language} platform style`);
    assert.ok(prompt.includes(`Language: ${languageToken}`), `${platform}/${language} language`);
  }
});

test("model creative direction enriches execution fields but cannot replace assigned selling points", () => {
  const task = makeTask("Amazon", "English");
  const fallback = makePlan(task);
  const result = normalizeCreativeDirectorResult({
    direction: { styleIntent: "Restrained premium marketplace storytelling" },
    frames: [{
      role: "main",
      index: 1,
      focus: "invented replacement",
      productState: "robot turning toward a child with one arm raised",
      productPresence: "co-primary at 40%",
      scene: "warm reading corner with a child and an open language book",
      layout: "child, book and robot form a clear triangular relationship",
      camera: "eye-level medium environmental shot",
      props: "one open book and language cards",
      visualMetaphor: "conversation paths between language cards",
      visualTreatment: "soft daylight with precise product highlights",
      proof: "the child asks while the robot visibly turns and responds",
      avoidRepeat: "no studio pedestal and no front-facing static pose"
    }]
  }, fallback);

  assert.equal(result.frames[0].focus, fallback.frames[0].focus);
  assert.equal(result.frames[0].productState, "robot turning toward a child with one arm raised");
  assert.equal(result.frames.length, 13);
});

test("creative-plan audit rejects adjacent frames that repeat state and composition", () => {
  const plan = makePlan(makeTask("国内通用", "简体中文"));
  const duplicate = { ...plan.frames[1], productState: plan.frames[0].productState, layout: plan.frames[0].layout };
  const frames = [plan.frames[0], duplicate, ...plan.frames.slice(2)];
  const audit = auditCreativePlan(frames, 13);
  assert.equal(audit.passed, false);
  assert.ok(audit.duplicatePairs.includes("main:1 ↔ main:2"));
});

test("creative-director request requires exact frame count and protects facts", () => {
  const task = makeTask("Amazon", "English");
  const plan = makePlan(task);
  const prompt = buildCreativeDirectorRequestPrompt(task, makeInsight(), plan);
  assert.match(prompt, /Do not invent specifications/);
  assert.match(prompt, /Return exactly one frame/);
  assert.match(prompt, /yellow body with black joints/);
  assert.match(prompt, /语言学习环境/);
});

test("compact compiler rejects stale legacy selling points from another product category", () => {
  const task = makeTask("国内通用", "简体中文");
  const plan = makePlan(task);
  const prompt = compileDirectedFramePrompt({
    task,
    insight: makeInsight(),
    direction: plan.direction,
    frame: plan.frames[0],
    copy: ["趣味AI伙伴"],
    title: "机器人主图",
    aspectRatio: "1:1",
    forbidden: "平台水印",
    legacyPrompt: [
      "机器人类重点：保持黄色机身、蓝色表情屏和多关节结构。",
      "商品锁定：豆包AI机器人；核心利益点：500只垃圾袋囤货、抽绳收口。",
      "垃圾袋重点：卷装堆叠、套入垃圾桶、承重不易破。"
    ].join("\n")
  });

  assert.match(prompt, /黄色机身、蓝色表情屏和多关节结构/);
  assert.doesNotMatch(prompt, /500只|垃圾袋|垃圾桶|抽绳收口/);
});

test("visual insight is sanitized before storyboard assignment", () => {
  const task = { ...makeTask("国内通用", "简体中文"), productName: "女士阔腿裤", originalProductName: "女士阔腿裤", category: "女裤" };
  const insight = sanitizeProductVisualInsight(task, {
    ...makeInsight(),
    visualSellingPoints: ["宽松版型遮肉显瘦", "按实际脚长选择尺码"],
    promptDirectives: ["突出腰头抽绳", "不得写成空气净化器或母婴用品"]
  });
  assert.deepEqual(insight.visualSellingPoints, ["宽松版型遮肉显瘦"]);
  assert.deepEqual(insight.promptDirectives, ["突出腰头抽绳"]);
  assert.match(insight.warnings.join(" "), /已隔离 2 条/);
});

test("industrial visual insight cannot inherit footwear defaults", () => {
  const task = { ...makeTask("国内通用", "简体中文"), productName: "永磁起重机", originalProductName: "永磁起重机", category: "工业吊装设备" };
  const insight = sanitizeProductVisualInsight(task, {
    ...makeInsight(),
    visualSellingPoints: ["无需用电", "宽口好穿", "按实际脚长选择尺码"]
  });
  assert.deepEqual(insight.visualSellingPoints, ["无需用电"]);
});

test("reference analysis is sanitized before it can assign storyboard selling points", () => {
  const task = { ...makeTask("国内通用", "简体中文"), productName: "女士阔腿裤", originalProductName: "女士阔腿裤", category: "女裤" };
  const analysis = sanitizeReferenceAnalysisForProduct(task, {
    query: "test",
    references: [],
    summary: "mixed reference library",
    visualPatterns: ["完整裤型和腰头抽绳", "鞋底纹路微距"],
    sellingPointPatterns: ["宽松版型不拘束", "按实际脚长选择尺码"],
    detailPagePatterns: ["通勤穿搭场景", "鞋口细节证明"]
  });
  assert.deepEqual(analysis.sellingPointPatterns, ["宽松版型不拘束"]);
  assert.deepEqual(analysis.visualPatterns, ["完整裤型和腰头抽绳"]);
  assert.deepEqual(analysis.detailPagePatterns, ["通勤穿搭场景"]);
});

function makePlan(task: ProductTask) {
  const storyboard = buildStoryboardPlan({
    productName: task.productName,
    sellingPoints,
    explicitSellingPoints: sellingPoints,
    isAiRobot: true,
    generateDetail: true
  });
  return buildDeterministicCreativePlan(task, makeInsight(), storyboard);
}

function makeInsight(): ProductVisualInsight {
  return {
    source: "openai-vision",
    summary: "Yellow desktop AI robot",
    productFacts: [
      "yellow body with black joints and silver ear details",
      "blue expression screen",
      "movable arms and legs"
    ],
    visualSellingPoints: sellingPoints,
    promptDirectives: ["preserve the original robot identity"],
    warnings: []
  };
}

function makeTask(targetPlatform: string, outputLanguage: string): ProductTask {
  return {
    recordId: "creative-director-test",
    sku: "AI robot",
    brandId: "folder-default",
    productName: "豆包AI机器人",
    originalProductName: "豆包AI机器人",
    visibleProductName: outputLanguage === "English" ? "AI Companion Robot" : "豆包AI机器人",
    targetAudience: "families with children",
    targetPlatform,
    outputLanguage,
    category: "AI companion robot",
    productImages: [],
    localProductImages: [],
    referenceImageUrls: [],
    referenceProductUrls: [],
    materialDir: "",
    mainProductImage: "robot.jpg",
    sellingPoints: sellingPoints.join("\n"),
    specs: "",
    bannedElements: "watermark; unsupported specifications",
    referenceKeywords: "AI robot",
    notes: "",
    mainImageCount: 5,
    generateDetail: true,
    imageRatio: "1:1",
    suiteRatio: "main 1:1 / detail 9:16"
  };
}
