import test from "node:test";
import assert from "node:assert/strict";
import { auditNativePromptSet, classifyProductIdentity } from "../src/prompt-audit.ts";

const baseTask = {
  productName: "豆包机器人",
  originalProductName: "豆包机器人",
  visibleProductName: "豆包机器人",
  category: "AI陪伴机器人",
  targetAudience: "儿童亲子家庭、桌面潮玩用户",
  referenceKeywords: "黄色黑色机器人，蓝色LED表情屏，多关节",
  notes: "",
  briefFocus: "多语言、趣味语音、讲故事、玩法丰富、学习答疑、联网聊天、长续航",
  sellingPoints: "多语言与方言互动；趣味语音交互；讲故事与成语接龙；多关节可动；长续航",
  mainImageCount: 5,
  generateDetail: true
};

function robotSpecs(contaminated = false) {
  const scenes = [
    ["孩子贴心玩伴", "亲子阅读角，孩子与机器人面对面互动"],
    ["多语言与方言互动", "教室黑板、中文、English、粤语语言卡，机器人作为小老师"],
    ["趣味语音交互", "麦克风、声波和提问卡，机器人倾听并回应"],
    ["讲故事与成语接龙", "打开绘本、成语卡和孩子翻页动作，机器人讲故事"],
    ["玩法丰富与多关节可动", "游戏板、动作轨迹和不同关节姿势"],
    ["学习答疑", "课本、问题卡、黑板和孩子提问，机器人指向问题"],
    ["联网智能聊天", "云端节点、WiFi连接线和对话关系图"],
    ["长续航", "大型电池能量图、从早到晚时间线，机器人只作小型插图"],
    ["潮玩桌面摆件", "书桌、展示架、台灯和机器人三分之四坐姿"],
    ["LED表情屏", "蓝色LED表情屏局部近景和不同情绪表情"],
    ["多角度细节", "正面、侧面、耳机装饰、手臂和腿部关节细节"],
    ["亲子陪伴", "家庭桌面场景，孩子向机器人提问"],
    ["送礼场景", "礼盒、桌面摆件和机器人完整外观"]
  ];
  return scenes.map(([title, scene], index) => ({
    role: index < 5 ? "main" as const : "detail" as const,
    index: index < 5 ? index + 1 : index - 4,
    title,
    copy: [title, scene],
    prompt: `产品：豆包机器人。卖点：${title}。画面：${scene}。${contaminated && index === 1 ? "左侧堆叠500只垃圾袋，右侧打开垃圾袋。" : "保持机器人黄黑银外观和蓝色LED表情屏。"}`
  }));
}

test("classifies robot before a stale incompatible category", () => {
  const identity = classifyProductIdentity({ ...baseTask, category: "鞋类" });
  assert.equal(identity.id, "ai-robot");
});

test("blocks a robot task whose selected category conflicts", () => {
  const result = auditNativePromptSet({ ...baseTask, category: "鞋类" }, robotSpecs());
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /类目/);
});

test("recognizes the current 豆宝机器人 name even when a stale template says 鞋类", () => {
  const result = auditNativePromptSet({ ...baseTask, productName: "豆宝机器人", category: "鞋类" }, robotSpecs());
  assert.equal(result.identity.id, "ai-robot");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /AI机器人/);
});

test("blocks cross-category contamination in product-specific prompts", () => {
  const result = auditNativePromptSet(baseTask, robotSpecs(true));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /不相容|垃圾袋/);
  assert.ok(result.forbiddenMatches.some((item) => item.includes("垃圾袋")));
});

test("allows a complete robot storyboard with product-specific evidence", () => {
  const result = auditNativePromptSet(baseTask, robotSpecs());
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.actualCount, 13);
  assert.deepEqual(result.missingEvidence, []);
});

test("rejects a main-image set that repeats one scene signature", () => {
  const specs = robotSpecs();
  for (const spec of specs.slice(0, 3)) {
    spec.title = "桌面摆件";
    spec.copy = ["桌面摆件", "书桌与展示架上的机器人静态陈列"];
  }
  const result = auditNativePromptSet(baseTask, specs);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /主图场景过度重复/);
});

test("uses explicit storyboard fields instead of collapsing all detail screens into one signature", () => {
  const specs = robotSpecs().map((spec, index) => ({
    ...spec,
    copy: ["Product detail", "Close-up detail"],
    prompt: `${spec.prompt}\n产品状态：state ${index}\n场景与辅助元素：scene ${index}\n构图类型：layout ${index}\n可见证明方式：proof ${index}`,
  }));
  const result = auditNativePromptSet(baseTask, specs);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.doesNotMatch(result.warnings.join("\n"), /高度相似的场景签名/);
});

test("uses compact English frame fields instead of generic detail copy buckets", () => {
  const specs = [1, 2, 3].map((index) => ({
    role: "detail" as const,
    index,
    title: `Detail ${index}`,
    copy: ["A practical everyday benefit shown through real-use evidence"],
    prompt: [
      `Product state/action: ${index === 1 ? "sealed package" : index === 2 ? "open dropper" : "bottle in pouch"}`,
      `Scene and interaction: ${index === 1 ? "white studio" : index === 2 ? "spoon dispensing macro" : "adult hand packing a pouch"}`,
      `Composition: ${index === 1 ? "front hero" : index === 2 ? "overhead macro" : "top-down lifestyle"}`,
      `Visible proof: distinct proof ${index}`
    ].join("\n")
  }));
  const result = auditNativePromptSet({
    productName: "NAD+ Liquid Dietary Supplement",
    originalProductName: "NAD+ Liquid Dietary Supplement",
    visibleProductName: "NAD+ Liquid Dietary Supplement",
    category: "Dietary Supplements",
    targetAudience: "Adults",
    referenceKeywords: "",
    notes: "",
    sellingPoints: "Liquid format",
    briefFocus: "",
    mainImageCount: 0,
    generateDetail: false
  }, specs);
  assert.doesNotMatch(result.warnings.join("\n"), /高度相似的场景签名/);
});

test("blocks an unsupported oregano display name after visual analysis", () => {
  const supplementTask = {
    ...baseTask,
    productName: "喜来芝滴剂",
    originalProductName: "喜来芝滴剂",
    visibleProductName: "Oregano Oil Supplement",
    category: "Liquid Dietary Supplement",
    targetAudience: "Adults",
    referenceKeywords: "amber dropper bottle",
    briefFocus: "liquid dropper format",
    sellingPoints: "NAD+；Shilajit；Resveratrol",
    mainImageCount: 1,
    generateDetail: false,
  };
  const specs = [{
    role: "main" as const,
    index: 1,
    title: "Product Hero",
    copy: ["Oregano Oil Supplement"],
    prompt: "CURRENT FRAME MISSION. Product state/action: amber dropper bottle. Visible proof: liquid dropper and label.",
  }];
  const result = auditNativePromptSet(supplementTask, specs, {
    trustedVisualEvidence: "ReLierre NAD+ liquid dietary supplement in an amber dropper bottle with Shilajit and Resveratrol. No oregano oil is visible.",
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Oregano Oil.*没有对应证据/);
});
