import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConcreteBriefSections,
  briefExpansionQualityIssues,
  detectProductIdentityConflict,
  extractUserSellingPointSeeds,
  inferBriefSellingPoints,
  inferEvidenceBasedEnglishDisplayName,
  inferProductIdentity,
  isLowQualityBriefExpansion,
} from "../scripts/brief-expansion-rules.mjs";
import { inferCategoryFromSource } from "../scripts/category-inference.mjs";

const blenderInput = `产品名称：家用破壁机
用户作图重点：大容量，豆浆细腻，容易清洗，早餐使用方便，性价比高。`;

const blenderAnalysis = `产品图视觉识别摘要：一台台式家用破壁机，包含透明搅拌杯、杯盖、底座控制区和刀头结构。画面可见水果、谷物和杯具，适合制作豆浆、果汁或米糊等早餐饮品。`;

const trashBagInput = `产品名称：艾草除臭垃圾袋
用户作图重点：500只囤货装，抽绳收口，加厚不易破，厨房换袋方便。`;

const trashBagAnalysis = `产品图视觉识别摘要：浅绿色卷装抽绳垃圾袋，包装明确写有艾草祛味、500只、抽绳自动收口。`;

test("trusted robot identity overrides a stale shoe category", () => {
  assert.equal(
    inferCategoryFromSource("豆宝机器人\n类目：鞋类", "简体中文"),
    "AI陪伴机器人 / 儿童智能玩具 / 桌面潮玩",
  );
  assert.equal(
    inferCategoryFromSource("豆宝机器人\n类目：鞋类", "English"),
    "AI Companion Robots / Smart Toys",
  );
});

test("creates a stable blender identity before expanding selling points", () => {
  const identity = inferProductIdentity({
    productName: "家用破壁机",
    rawBriefText: blenderInput,
    productImageAnalysis: blenderAnalysis,
  });

  assert.equal(identity.id, "blender");
  assert.equal(identity.label, "破壁机 / 搅拌机");
  assert.notEqual(identity.confidence, "unknown");
});

test("keeps blender expansion inside the blender category", () => {
  const points = inferBriefSellingPoints({
    productName: "家用破壁机",
    rawBriefText: blenderInput,
    productImageAnalysis: blenderAnalysis,
    outputLanguage: "简体中文",
  });
  const sections = buildConcreteBriefSections({
    productName: "家用破壁机",
    visibleProductName: "家用破壁机",
    sellingPoints: points,
    rawBriefText: blenderInput,
    productImageAnalysis: blenderAnalysis,
    outputLanguage: "简体中文",
  });
  const combined = [points.join("\n"), sections.evidence, sections.proofMatrix, sections.mainPlan, sections.detailPlan].join("\n");

  assert.match(combined, /搅拌杯/);
  assert.match(combined, /豆浆|饮品/);
  assert.match(combined, /清洁/);
  assert.doesNotMatch(combined, /500只|囤货|垃圾袋|抽绳|绿色袋身|垃圾桶|厨余/);
});

test("does not turn a generic quantity request into a garbage-bag 500-count claim", () => {
  const points = inferBriefSellingPoints({
    productName: "家用破壁机",
    rawBriefText: "产品名称：家用破壁机\n用户作图重点：容量大，使用次数多，性价比高。",
    productImageAnalysis: blenderAnalysis,
    outputLanguage: "简体中文",
  }).join("\n");

  assert.match(points, /容量/);
  assert.doesNotMatch(points, /500只|囤货|多卷|垃圾袋/);
});

test("current product identity outranks stale category examples in a pasted template", () => {
  const staleTemplate = `产品名称：家用破壁机
核心卖点：500只囤货装，抽绳自动收口，艾草祛味。
主图规划：左侧堆叠垃圾袋，右侧放垃圾桶。`;
  const points = inferBriefSellingPoints({
    productName: "家用破壁机",
    rawBriefText: staleTemplate,
    productImageAnalysis: blenderAnalysis,
    outputLanguage: "简体中文",
  }).join("\n");

  assert.match(points, /搅拌杯|食材/);
  assert.doesNotMatch(points, /500只|囤货|抽绳|垃圾袋|垃圾桶|艾草/);
  assert.equal(inferProductIdentity({
    productName: "家用破壁机",
    rawBriefText: staleTemplate,
    productImageAnalysis: blenderAnalysis,
  }).id, "blender");
});

test("keeps an explicitly supplied trash-bag quantity only in the trash-bag category", () => {
  const points = inferBriefSellingPoints({
    productName: "艾草除臭垃圾袋",
    rawBriefText: trashBagInput,
    productImageAnalysis: trashBagAnalysis,
    outputLanguage: "简体中文",
  }).join("\n");

  assert.match(points, /500只囤货装/);
  assert.match(points, /抽绳/);
  assert.doesNotMatch(points, /搅拌杯|豆浆|刀头/);
});

test("rejects a contaminated blender draft even if the draft has the required fields", () => {
  const contaminated = `商品作图需求模板
产品名称：家用破壁机
可见展示名：家用破壁机
目标平台：国内通用
输出语言：简体中文
套图比例：主图 1:1 / 详情页 9:16
人群：家庭早餐用户
类目：厨房小家电 / 破壁机
核心卖点：
- 大容量搅拌杯
- 500只囤货装，日常换袋更省心
主图规划：
1. 卖点：大容量；画面怎么拍：左侧堆叠绿色袋身，右侧放垃圾桶。`;

  assert.equal(isLowQualityBriefExpansion(contaminated, {
    productName: "家用破壁机",
    rawBriefText: blenderInput,
    productImageAnalysis: blenderAnalysis,
  }), true);
});

test("extracts only user-entered selling-point fragments", () => {
  assert.deepEqual(extractUserSellingPointSeeds(blenderInput), ["大容量", "豆浆细腻", "容易清洗", "早餐使用方便", "性价比高"]);
});

test("does not treat numbered plan rows as new selling points during re-expansion", () => {
  const expandedTemplate = `产品名称：豆包AI机器人
核心卖点：
- 多关节可动
- 潮玩桌面摆件

主图规划：
1. 卖点：多关节可动；产品形态：多关节动态姿势；画面怎么拍：展示抬手和弯腿；证明方式：用关节近景证明。
2. 卖点：潮玩桌面摆件；产品形态：桌面静态全貌；画面怎么拍：展示书桌陈列；证明方式：用尺度关系证明。
详情页规划：
1. 卖点：孩子贴心玩伴；产品形态：亲子互动；画面怎么拍：展示亲子阅读；证明方式：用互动动作证明。`;

  assert.deepEqual(extractUserSellingPointSeeds(expandedTemplate), ["多关节可动", "潮玩桌面摆件"]);
});

test("robot expansion keeps all user points and turns them into concrete visual scenes", () => {
  const robotInput = `产品名称：豆包AI机器人
用户作图重点：
- 多关节可动
- 潮玩桌面摆件
- 多语言 + 方言
- 趣味语音交互
- 讲故事｜成语接龙
- 玩法丰富
- 学习答疑
- 孩子贴心玩伴
- 联网智能聊天
- 长续航`;
  const points = inferBriefSellingPoints({
    productName: "豆包AI机器人",
    rawBriefText: robotInput,
    productImageAnalysis: "黄色黑银圆润AI机器人，蓝色LED表情屏，银色耳机装饰，手臂和腿部有可见关节。",
    outputLanguage: "简体中文",
  });
  const sections = buildConcreteBriefSections({
    productName: "豆包AI机器人",
    visibleProductName: "豆包AI机器人",
    sellingPoints: points,
    rawBriefText: robotInput,
    productImageAnalysis: "黄色黑银圆润AI机器人，蓝色LED表情屏，银色耳机装饰，手臂和腿部有可见关节。",
    outputLanguage: "简体中文",
  });
  const combined = [points.join("\n"), sections.mainPlan, sections.detailPlan, sections.proofMatrix].join("\n");

  assert.ok(points.length >= 10);
  assert.match(combined, /语言课堂|语言卡|多语言/);
  assert.match(combined, /绘本|成语|故事/);
  assert.match(combined, /电池|时间线|长续航/);
  assert.match(combined, /云端|WiFi|联网/);
  assert.match(combined, /机器人不必每张都占中心|不要求机器人完整出场|不要求完整机器人出场/);
  assert.match(sections.detailPlan, /云端|联网|学习答疑/);
  assert.match(sections.mainPlan, /多关节可动[^；]*；产品形态：多关节动态姿势与局部近景/);
  assert.match(sections.mainPlan, /多语言与方言互动[^；]*；产品形态：语言课堂与语言卡片/);
  assert.match(sections.mainPlan, /讲故事与成语接龙[^；]*；产品形态：故事\/成语接龙互动/);
  assert.match(combined, /长续航[^；]*；产品形态：电量与全天陪伴信息图/);
  assert.match(sections.detailPlan, /联网智能聊天[^；]*；产品形态：联网关系图与小型终端/);
  assert.match(sections.detailPlan, /玩法丰富[^；]*；产品形态：游戏板与多种动作姿态/);
});

test("English supplement expansion identifies the product and keeps concrete user points", () => {
  const rawBriefText = `产品名称：Re Lierre 牛至油
输出语言：English
用户作图重点：
一、核心配方卖点（双活性成分复配）
二、软胶囊剂型
三、适合日常随身补充`;
  const productImageAnalysis = "Two dietary supplement bottles with oregano oil softgel capsules and a clearly visible package label.";
  const identity = inferProductIdentity({ productName: "Re Lierre 牛至油", rawBriefText, productImageAnalysis });
  const points = inferBriefSellingPoints({
    productName: "Re Lierre 牛至油",
    rawBriefText,
    productImageAnalysis,
    outputLanguage: "English",
  });
  const sections = buildConcreteBriefSections({
    productName: "Re Lierre 牛至油",
    visibleProductName: "Oregano Oil Supplement",
    sellingPoints: points,
    rawBriefText,
    productImageAnalysis,
    outputLanguage: "English",
  });

  assert.equal(identity.id, "dietary-supplement");
  assert.ok(points.length >= 3);
  assert.ok(points.every((point) => !/[\u3400-\u9fff]/.test(point)), points.join("\n"));
  assert.doesNotMatch(points.join("\n"), /^一$|^二$|Featured Product|Consumer Product|Everyday shoppers/m);
  assert.match(sections.mainPlan, /ingredient|formula|capsule|softgel/i);
  assert.match(sections.detailPlan, /routine|package|label|capsule|softgel/i);
});

test("English supplement naming requires ingredient and dosage-form evidence", () => {
  assert.equal(inferEvidenceBasedEnglishDisplayName({
    productName: "喜来芝滴剂",
    productImageAnalysis: "ReLierre NAD+ liquid dietary supplement in an amber dropper bottle with Shilajit and Resveratrol on the label.",
  }), "NAD+ Liquid Dietary Supplement");

  assert.equal(inferEvidenceBasedEnglishDisplayName({
    productName: "Re Lierre 牛至油",
    productImageAnalysis: "Oregano oil dietary supplement with visible softgel capsules.",
  }), "Oregano Oil Supplement");

  assert.equal(inferEvidenceBasedEnglishDisplayName({
    productName: "日常营养补充剂",
    productImageAnalysis: "A dietary supplement bottle. No specific ingredient is readable.",
  }), "Dietary Supplement");
});

test("brief quality gate rejects a drinkware display name for a liquid supplement", () => {
  const draft = `商品作图需求模板
产品名称：喜来芝滴剂
可见展示名：Insulated Water Bottle
目标平台：Amazon
输出语言：English
人群：Adults building an everyday supplement routine
类目：Dietary Supplements
核心卖点：
- NAD+ formula
- Liquid dropper format
- Blueberry flavor
主图规划：
1. Package hero
2. Formula proof
3. Dropper macro
4. Adult routine
5. Label detail
详情页规划：
1. Identity
2. Formula
3. Dropper
4. Routine
5. Bottle detail
6. Package angles
7. Selection reason
8. Closing frame`;
  const issues = briefExpansionQualityIssues(draft, {
    productName: "喜来芝滴剂",
    productImageAnalysis: "棕色滴管瓶装 NAD+ 液体膳食补充剂，包装可见 Shilajit 和 Liquid Dietary Supplement。",
    outputLanguage: "English",
  });
  assert.match(issues.join("\n"), /可见展示名.*杯壶水具.*膳食补充剂/);
});

test("brief quality gate rejects an unsupported oregano display name", () => {
  const draft = `商品作图需求模板
产品名称：喜来芝滴剂
可见展示名：Oregano Oil Supplement
目标平台：Amazon
输出语言：English
套图比例：主图 1:1 / 详情页 9:16
人群：Adults building an everyday supplement routine
类目：Liquid Dietary Supplement
核心卖点：
- Liquid dropper format
- Clearly presented ingredient formula
- Easy to include in an everyday routine
主图规划：
1. Package hero with a large bottle
2. Ingredient relationship with visible label evidence
3. Dropper macro with one suspended liquid drop
4. Adult morning routine with the closed bottle
5. Label and cap detail inspection
详情页规划：
1. Product identity overview
2. Buyer concern and package proof
3. Dropper format close-up
4. Everyday adult routine
5. Amber bottle detail
6. Multi-angle package inspection
7. Clear selection reasons
8. Restrained closing frame`;
  const issues = briefExpansionQualityIssues(draft, {
    productName: "喜来芝滴剂",
    productImageAnalysis: "ReLierre NAD+ liquid dietary supplement in an amber dropper bottle with Shilajit and Resveratrol. No oregano oil is visible.",
    outputLanguage: "English",
  });

  assert.match(issues.join("\n"), /可见展示名.*产品证据|Oregano/i);
});

test("supplement bottle wording is not treated as drinkware contamination", () => {
  const brief = `商品作图需求模板
产品名称：喜来芝滴剂
可见展示名：NAD+ Liquid Dietary Supplement
目标平台：Amazon
输出语言：English
人群：Adults building an everyday supplement routine
类目：Dietary Supplements
核心卖点：
- NAD+ formula
- Liquid dropper format
- Blueberry flavor
主图规划：
1. Full package and bottle hero
2. Ingredient relationship
3. Liquid dropper macro
4. Adult routine
5. Label detail
详情页规划：
1. Identity
2. Formula
3. Dropper
4. Routine
5. Bottle detail
6. Package angles
7. Selection reason
8. Closing frame with a supporting water bottle`;
  const issues = briefExpansionQualityIssues(brief, {
    productName: "喜来芝滴剂",
    productImageAnalysis: "棕色滴管瓶装 NAD+ 液体膳食补充剂，包装可见 Shilajit、Blueberry Flavor 和 Liquid Dietary Supplement。",
    rawBriefText: "卖点：NAD+ formula；Liquid dropper format；Blueberry flavor",
    outputLanguage: "English",
  });
  assert.equal(issues.some((issue) => issue.startsWith("包含其他品类污染词")), false);
});

test("brief quality gate rejects generic English identity fields and incomplete plans", () => {
  const draft = `商品作图需求模板
产品名称：Re Lierre 牛至油
可见展示名：Featured Product
目标平台：Amazon
输出语言：English
套图比例：主图 1:1 / 详情页 9:16
人群：Everyday shoppers who need practical product benefits
类目：Consumer Product
核心卖点：
- Clear product appearance
主图规划：
1. Generic hero image
详情页规划：
1. Generic detail image`;
  const issues = briefExpansionQualityIssues(draft, {
    productName: "Re Lierre 牛至油",
    rawBriefText: "双活性成分复配，软胶囊剂型，适合日常随身补充",
    productImageAnalysis: "Oregano oil dietary supplement softgel bottle",
    outputLanguage: "English",
  });

  assert.match(issues.join("\n"), /目标人群|类目|可见展示名|核心卖点|主图规划|详情页规划/);
});

test("blocks a product-name and reference-image identity mismatch before expansion", () => {
  const result = detectProductIdentityConflict({
    productName: "Re Lierre 牛至油",
    productImageAnalysis: "浅绿色卷装抽绳垃圾袋，包装写有500只，画面展示垃圾桶套袋和抽绳收口。",
  });

  assert.equal(result.conflicts, true);
  assert.equal(result.nameIdentity.id, "dietary-supplement");
  assert.equal(result.imageIdentity.id, "trash-bag");
  assert.match(result.message, /重新上传正确参考图/);
});
