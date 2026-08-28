import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReferenceCaseLayoutRule,
  buildStoryboardPlan,
  storyboardFramePrompt
} from "../src/storyboard-planner.ts";

test("robot storyboard turns an explicit English-speaking point into a dedicated proof screen", () => {
  const plan = buildStoryboardPlan({
    productName: "豆包AI机器人",
    sellingPoints: ["会说英语", "多模型语音对话", "可动关节", "亲子陪伴", "适合送礼"],
    isAiRobot: true,
    generateDetail: true
  });

  assert.equal(plan.frames.length, 13);
  assert.equal(plan.audit.passed, true);
  assert.match(plan.frames.find((frame) => frame.role === "main" && frame.index === 2)?.focus ?? "", /会说英语/);
  assert.match(plan.frames.find((frame) => frame.role === "detail" && frame.index === 4)?.focus ?? "", /会说英语/);
  assert.match(storyboardFramePrompt(plan.frames[3]), /构图类型：/);
  assert.match(storyboardFramePrompt(plan.frames[3]), /可见证明方式：/);
});

test("generic storyboard keeps the five main shots different", () => {
  const plan = buildStoryboardPlan({
    productName: "轻便收纳椅",
    sellingPoints: ["轻便", "静音滑轮", "靠背承托", "易清洁", "小空间适用"],
    generateDetail: true
  });

  const main = plan.frames.filter((frame) => frame.role === "main");
  assert.equal(main.length, 5);
  assert.equal(new Set(main.map((frame) => frame.layout)).size, 5);
  assert.equal(new Set(main.map((frame) => frame.productState)).size, 5);
  assert.equal(plan.audit.passed, true);
});

test("robot storyboard does not invent an English feature when the user did not provide it", () => {
  const plan = buildStoryboardPlan({
    productName: "桌面陪伴机器人",
    sellingPoints: ["语音对话", "可动关节", "亲子陪伴"],
    isAiRobot: true,
    generateDetail: true
  });

  assert.doesNotMatch(plan.frames.find((frame) => frame.role === "main" && frame.index === 2)?.focus ?? "", /英语|英文|English/);
  assert.doesNotMatch(plan.frames.find((frame) => frame.role === "detail" && frame.index === 4)?.focus ?? "", /英语|英文|English/);
});

test("reference-case rule describes layout learning without copying a case product", () => {
  const rule = buildReferenceCaseLayoutRule({
    productName: "电动车防水篮筐",
    sellingPoints: ["防水", "大容量", "稳固承托"],
    isEnglishMarketplace: false,
    generateDetail: true
  });

  assert.match(rule, /优秀案例抽象学习/);
  assert.match(rule, /一个具体卖点绑定到一个产品状态/);
  assert.match(rule, /多角度或多宫格/);
  assert.doesNotMatch(rule, /垃圾袋|机器人|珠宝|苹果/);
});

test("explicit selling points outrank derived defaults and receive coverage records", () => {
  const plan = buildStoryboardPlan({
    productName: "豆包AI机器人",
    sellingPoints: ["通用陪伴默认卖点"],
    explicitSellingPoints: ["支持中英双语对话", "可动关节", "LED表情屏"],
    derivedSellingPoints: ["多模型智能对话", "桌面陪伴"],
    isAiRobot: true,
    generateDetail: true
  });

  const explicitCoverage = plan.coverage.filter((item) => item.source === "explicit");
  assert.equal(explicitCoverage.length, 3);
  assert.ok(explicitCoverage.every((item) => item.status === "covered"));
  assert.match(plan.frames.find((frame) => frame.role === "main" && frame.index === 2)?.focus ?? "", /支持中英双语对话/);
  assert.match(plan.frames.find((frame) => frame.role === "main" && frame.index === 4)?.focus ?? "", /可动关节|LED表情屏/);
  assert.doesNotMatch(plan.frames.find((frame) => frame.role === "main" && frame.index === 1)?.focus ?? "", /通用陪伴默认卖点/);
});

test("ambiguous or absolute user claims are preserved but marked for confirmation", () => {
  const plan = buildStoryboardPlan({
    productName: "豆包AI机器人",
    sellingPoints: ["唤醒血脉基因", "100%安全"],
    explicitSellingPoints: ["唤醒血脉基因", "100%安全"],
    isAiRobot: true,
    generateDetail: true
  });

  const risky = plan.coverage.filter((item) => item.source === "explicit");
  assert.equal(risky.length, 2);
  assert.ok(risky.every((item) => item.status === "needs_confirmation"));
  assert.match(plan.audit.issues.join("\n"), /用户卖点需确认/);
});

test("robot storyboard makes abstract points scene-first instead of robot-first", () => {
  const points = [
    "多关节可动",
    "潮玩桌面摆件",
    "多语言 + 方言",
    "趣味语音交互",
    "讲故事｜成语接龙",
    "玩法丰富",
    "学习答疑",
    "孩子贴心玩伴",
    "联网智能聊天",
    "长续航"
  ];
  const plan = buildStoryboardPlan({
    productName: "豆包AI机器人",
    sellingPoints: points,
    explicitSellingPoints: points,
    isAiRobot: true,
    generateDetail: true
  });

  assert.equal(plan.audit.passed, true);
  assert.equal(plan.coverage.filter((item) => item.source === "explicit").length, 10);
  assert.ok(plan.coverage.filter((item) => item.source === "explicit").every((item) => item.status === "covered"));
  assert.match(plan.frames.find((frame) => frame.role === "main" && frame.index === 2)?.scene ?? "", /黑板|语言卡/);
  assert.match(plan.frames.find((frame) => frame.role === "main" && frame.index === 5)?.scene ?? "", /电池|时间线/);
  assert.match(plan.frames.find((frame) => frame.role === "detail" && frame.index === 2)?.scene ?? "", /云端|WiFi|网络/);
  assert.match(plan.frames.find((frame) => frame.role === "detail" && frame.index === 5)?.scene ?? "", /游戏板|动作轨迹/);
  assert.match(plan.frames.find((frame) => frame.role === "main" && frame.index === 5)?.productState ?? "", /不要求完整机器人出场/);
});

test("supplement storyboard creates a distinct 5 plus 8 decision flow", () => {
  const plan = buildStoryboardPlan({
    productName: "Oregano Oil Supplement",
    sellingPoints: ["A thoughtfully paired ingredient formula", "Convenient softgel format", "Easy everyday routine"],
    productKind: "dietary-supplement",
    isEnglishMarketplace: true,
    generateDetail: true,
  });
  const main = plan.frames.filter((frame) => frame.role === "main");

  assert.equal(plan.frames.length, 13);
  assert.equal(new Set(main.map((frame) => frame.layout)).size, 5);
  assert.match(plan.frames.map((frame) => frame.scene).join("\n"), /ingredient relationship|macro|morning desk|multi-angle/i);
  assert.match(storyboardFramePrompt(main[1]), /优先级高于前文通用场景模板/);
});

test("English robot selling points stay assigned to matching visual scenes", () => {
  const points = [
    "Multilingual Voice Interaction",
    "Story Time Companion",
    "Movable Joint Play",
    "Connected AI Chat",
    "Long-Lasting Power"
  ];
  const plan = buildStoryboardPlan({
    productName: "AI Companion Robot",
    sellingPoints: points,
    explicitSellingPoints: points,
    isAiRobot: true,
    generateDetail: true
  });
  const main = plan.frames.filter((frame) => frame.role === "main");
  assert.equal(main[1]?.focus, "Multilingual Voice Interaction");
  assert.match(main[1]?.scene ?? "", /黑板|语言卡/);
  assert.equal(main[2]?.focus, "Story Time Companion");
  assert.match(main[2]?.scene ?? "", /绘本|成语/);
  assert.equal(main[3]?.focus, "Movable Joint Play");
  assert.match(main[3]?.proof ?? "", /关节|抬手|弯腿/);
  assert.equal(main[4]?.focus, "Long-Lasting Power");
  assert.match(main[4]?.scene ?? "", /电池|时间线/);
});
