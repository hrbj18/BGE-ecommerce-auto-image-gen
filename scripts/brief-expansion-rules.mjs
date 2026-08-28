const genericBriefPhrases = [
  "商品主体清晰，第一眼看懂品类和核心价值",
  "多场景展示真实使用理由",
  "细节近景证明材质、结构或功能卖点",
  "请结合商品图和用户重点自行分析",
  "请结合商品图和产品名称自行分析",
  "请根据商品图自行分析",
  "请自行分析",
  "自行分析",
  "英雄主图：突出商品外观和第一核心卖点",
  "功能证明图：用真实动作、结构拆解或局部放大证明核心卖点",
];

const placeholderBriefPatterns = [
  /请(?:结合|根据)?.*(?:商品图|产品图|用户重点|产品名称|文件名|图片|需求|卖点|信息).*(?:自行分析|自行补充|自行提炼|分析补充)/,
  /(?:请)?自行(?:分析|补充|判断|提炼)/,
  /根据(?:商品图|产品图|产品名称|用户重点).*自行/,
];

const categoryProfiles = [
  {
    id: "blender",
    label: "破壁机 / 搅拌机",
    match: /破壁机|搅拌机|料理机|豆浆机|果汁机|榨汁机|blender|mixer|smoothie/i,
    leak: /破壁机|搅拌机|料理机|豆浆机|果汁机|榨汁机|搅拌杯|刀头|杯盖|豆浆|米糊|blender|smoothie/i,
    forms: ["整机全貌", "搅拌杯与杯盖", "食材装入", "工作状态", "刀头或控制区近景"],
    staticProof: "用机身、搅拌杯、杯盖、控制区和可见结构细节证明产品形态。",
    dynamicProof: "用加入食材、启动操作、倒出饮品或清洁收纳等真实动作证明使用价值。",
    interaction: "可加入水果、谷物、杯具、早餐台面和手部操作，但整机始终是第一视觉主体。",
    antiRepeat: "禁止连续使用同一台面正面静物图；在整机、装料、操作、成品倒出和局部结构之间切换。",
    fallbackPoints: ["大容量搅拌杯，一次处理多份食材更省心", "早餐饮品制作更方便", "机身与杯体细节清楚可见"],
  },
  {
    id: "trash-bag",
    label: "家用垃圾袋",
    match: /垃圾袋|trash bag|抽绳|艾草|除臭|防臭|祛味/i,
    leak: /垃圾袋|trash bag|抽绳|艾草|除臭|防臭|祛味|囤货|多卷|500\s*只|厨余垃圾|垃圾桶|换袋|绿色袋身/i,
    forms: ["未展开卷装", "单只袋身展开", "套入垃圾桶", "抽绳收口", "装满手提或柜内收纳"],
    staticProof: "用卷装数量、包装文字、袋身边缘、袋底和抽绳结构证明卖点。",
    dynamicProof: "用套桶、拉绳收口、装满提起和收纳取用动作证明日常便利。",
    interaction: "可加入手部、厨房垃圾桶、收纳柜和日常厨余，但只服务袋身功能证明。",
    antiRepeat: "禁止每张都使用左侧卷装、右侧打开垃圾袋的构图；必须改变袋身形态、镜头距离和证明方式。",
    fallbackPoints: ["抽绳一拉收口，打包更利落", "加厚袋身，日常承装更安心", "多卷装收纳，日常换袋更省心"],
  },
  {
    id: "bike-basket",
    label: "电动车 / 自行车车篮",
    match: /电动车|自行车|车篮|篮筐|前篮|后篮|骑行|bike basket|bicycle basket/i,
    leak: /电动车|自行车|车篮|篮筐|前篮|后篮|骑行|通勤车篮|bike basket|bicycle basket/i,
    forms: ["车上安装全貌", "打开装载", "防水盖或罩闭合", "固定结构近景", "通勤收纳场景"],
    staticProof: "用篮筐外观、防水盖或罩、加固边缘与固定点证明结构卖点。",
    dynamicProof: "用放入物品、闭合防水盖、通勤取放等动作证明容量与便利。",
    interaction: "可加入车把、头盔、雨衣、买菜袋和手部动作，只服务骑行收纳卖点。",
    antiRepeat: "禁止重复同一车头正面视角；在安装、装载、防护、结构和通勤使用之间切换。",
    fallbackPoints: ["防水收纳，雨天放物更安心", "大容量篮筐，日常随身物品更好放", "固定结构清楚可见，骑行收纳更省心"],
  },
  {
    id: "umbrella",
    label: "雨伞",
    match: /雨伞|晴雨伞|折叠伞|伞骨|伞面|umbrella/i,
    leak: /雨伞|晴雨伞|折叠伞|伞骨|伞面|撑开伞|挡雨|umbrella/i,
    forms: ["折叠状态", "撑开伞面", "手持挡雨", "背包收纳", "伞骨与手柄近景"],
    staticProof: "用折叠体积、伞面包边、伞骨、手柄和束带细节证明卖点。",
    dynamicProof: "用撑开、手持挡雨、放入背包和收纳动作证明防护与便携。",
    interaction: "可加入手部、背包、通勤街景和轻微雨滴，伞始终是主体。",
    antiRepeat: "在折叠、撑开、手持、收纳和细节之间切换，不重复同一撑开视角。",
    fallbackPoints: ["晴雨出行更从容", "折叠便携，随手收纳", "伞骨与伞面细节清楚可见"],
  },
  {
    id: "robot",
    label: "AI 机器人",
    match: /机器人|robot|AI陪伴|智能对话|LED表情|豆包|deepseek/i,
    leak: /机器人|robot|LED表情|智能对话|AI陪伴|豆包|DeepSeek/i,
    forms: ["桌面摆件静态全貌", "语言课堂与语言卡片", "故事/成语接龙互动", "多关节动态姿势", "电量与全天陪伴信息图"],
    staticProof: "用黄黑银外观、蓝色LED表情屏、银色耳机装饰、关节结构和桌面比例证明产品身份；涉及电量时用信息图表达，不编造具体续航数值。",
    dynamicProof: "根据卖点改变姿势、屏幕表情、头部朝向和互动对象；语言用课堂道具证明，故事用绘本/成语卡证明，玩法用动作路径证明。",
    interaction: "可加入黑板、中文/English/方言语言卡、绘本、成语卡、课本、云端节点、家庭成员或电池能量图；辅助元素可以成为卖点主视觉，机器人不必每张都占中心。",
    antiRepeat: "禁止把同一正面机器人换背景复用；必须在机器人主体图、场景主视觉、信息图、动态姿势、局部细节和人物互动之间切换。",
    fallbackPoints: ["萌趣桌面摆件，外观好看也有互动感", "趣味语音交互，聊天学习更有参与感", "多关节可动，姿势动作更丰富", "LED表情屏，互动反馈更生动"],
  },
  {
    id: "chair",
    label: "家居椅凳",
    match: /椅|凳|chair|stool|滚轮|靠背/i,
    leak: /椅子|靠背椅|滚轮椅|坐垫|椅腿|chair|stool/i,
    forms: ["正面全貌", "侧面靠背", "滚轮移动", "坐垫细节", "书桌或梳妆使用"],
    staticProof: "用靠背、坐垫、底座、滚轮和包边细节证明结构与舒适感。",
    dynamicProof: "用坐下、轻推移动、调整位置和日常书桌使用证明便利。",
    interaction: "可加入书桌、梳妆台、地毯和人物坐姿，但椅子主体需完整可见。",
    antiRepeat: "在全貌、侧面、滚轮、坐垫和使用场景之间切换。",
    fallbackPoints: ["轻便移动，日常换位更省心", "静音滚轮，室内移动更从容", "舒适靠背与坐垫，久坐更放松"],
  },
  {
    id: "footwear",
    label: "鞋类",
    match: /鞋|shoe|sneaker|footwear|鞋面|鞋底|上脚/i,
    leak: /鞋|鞋面|鞋底|上脚|穿鞋|sneaker|shoe|footwear/i,
    forms: ["单鞋全貌", "鞋面近景", "鞋底细节", "上脚动态", "收纳或穿搭场景"],
    staticProof: "用鞋面纹理、鞋底纹路、鞋楦轮廓和缝线细节证明产品特点。",
    dynamicProof: "用上脚行走、弯折或日常穿搭动作证明舒适与适配。",
    interaction: "可加入脚部、裤装和通勤环境，但鞋子始终占主要画面。",
    antiRepeat: "切换鞋面、鞋底、上脚、单鞋和穿搭场景，不重复同一摆放角度。",
    fallbackPoints: ["日常通勤穿搭更轻松", "鞋面与鞋底细节清楚可见", "上脚场景突出舒适与搭配"],
  },
  {
    id: "drinkware",
    label: "杯壶水具",
    match: /水壶|水杯|保温杯|杯盖|杯口|bottle|cup/i,
    // A generic "bottle" is valid packaging for supplements, cosmetics and
    // many other categories. Only drinkware-specific bottle wording is a leak.
    leak: /水壶|水杯|保温杯|杯盖|杯口|吸管|喝水|water\s*bottle|drinking\s*bottle|cup/i,
    forms: ["产品全貌", "开盖状态", "手持饮用", "放入包内", "杯盖与杯口近景"],
    staticProof: "用杯身、杯盖、杯口、提手和表面细节证明产品设计。",
    dynamicProof: "用开盖、倒水、饮用和随身携带动作证明便利。",
    interaction: "可加入手部、书包、办公桌和出行道具，主体始终为杯壶。",
    antiRepeat: "在全貌、开盖、饮用、携带和细节之间切换。",
    fallbackPoints: ["随身饮水更方便", "杯盖与杯口细节清楚可见", "通勤学习场景随手可带"],
  },
  {
    id: "dietary-supplement",
    label: "膳食补充剂 / 营养补充品",
    match: /牛至油|oregano\s*oil|膳食补充剂|营养补充剂|保健品|软胶囊|胶囊|capsules?|softgels?|dietary\s*supplement|supplement/i,
    leak: /牛至油|oregano\s*oil|膳食补充剂|营养补充剂|保健品|软胶囊|胶囊|capsules?|softgels?|dietary\s*supplement/i,
    forms: ["包装与瓶身全貌", "胶囊或剂型近景", "核心配方关系图", "日常补充动作", "标签与包装细节"],
    formsEn: ["full package and bottle", "capsule or softgel close-up", "ingredient relationship visual", "daily routine interaction", "label and package detail"],
    staticProof: "用包装、瓶身、标签、胶囊剂型和用户已提供的配方信息证明商品身份。",
    staticProofEn: "Use the package, bottle, label, dosage form and user-provided ingredient information as visible identity proof.",
    dynamicProof: "用成年人日常取用、随餐摆放或收纳动作证明使用场景，不暗示治疗效果。",
    dynamicProofEn: "Use an adult daily routine, meal-side placement or storage action without implying treatment outcomes.",
    interaction: "可加入成年人手部、早餐台面、随身包、原料意象和简洁配方关系图；不得加入医生背书、人体器官疗效图或虚构认证。",
    interactionEn: "Adults, hands, a breakfast counter, a travel bag, ingredient cues and restrained formulation diagrams may support the benefit; never add doctor endorsements, organ-treatment imagery or invented certifications.",
    antiRepeat: "在包装英雄图、剂型近景、配方关系、日常取用和标签细节之间切换，禁止连续使用同一瓶身正面静物角度。",
    antiRepeatEn: "Rotate between package hero, dosage-form macro, formulation relationship, daily routine and label detail; never repeat the same front-facing bottle still life.",
    fallbackPoints: ["包装与剂型清楚可见", "日常补充融入生活动线", "核心配方信息表达更直观"],
    fallbackPointsEn: ["Clear package and dosage-form presentation", "Easy to include in an everyday routine", "Key formulation information made easier to understand"],
  },
];

const genericProfile = {
  id: "generic",
  label: "通用商品",
  forms: ["产品整体", "核心结构", "真实使用", "局部细节", "收纳或决策场景"],
  staticProof: "用外观、材质、结构和关键细节证明用户提供的卖点。",
  dynamicProof: "用真实使用动作、手部操作或场景道具证明用户提供的卖点。",
  interaction: "人物、手部、道具和环境只能为了让卖点更可见，不能抢商品主体。",
  antiRepeat: "禁止重复同一商品姿态和同一背景；每张必须改变形态、动作、证明方式或镜头距离。",
  fallbackPoints: ["商品外观与关键细节清楚可见", "用真实使用动作证明核心卖点", "用局部近景建立购买信任"],
  fallbackPointsEn: ["Clear product identity and visible details", "Real-use action that proves the main benefit", "Close-up evidence that builds purchase confidence"],
};

const knownStructuredLabels = ["结构化作图输入", "产品名称", "商品名称", "目标平台", "输出语言", "套图比例", "用户作图重点", "卖点", "核心卖点", "产品卖点", "人群", "类目", "生成详情页", "禁用元素", "规格参数", "要求"];

export function inferProductIdentity({ productName = "", rawBriefText = "", productImageAnalysis = "" } = {}) {
  // Product name and visual analysis are trusted identity evidence. Long legacy
  // templates are supplemental context only and must not override the current SKU.
  const trustedSource = `${productName}\n${productImageAnalysis}`;
  const supplementalSource = String(rawBriefText || "");
  const primaryMatches = categoryProfiles
    .map((profile) => ({ profile, score: countMatches(trustedSource, profile.match) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const matches = (primaryMatches.length ? primaryMatches : categoryProfiles
    .map((profile) => ({ profile, score: countMatches(supplementalSource, profile.match) })))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const profile = matches[0]?.profile || genericProfile;
  return {
    id: profile.id,
    label: profile.label,
    confidence: profile.id === "generic" ? "unknown" : matches[0].score > 1 ? "high" : "medium",
    profile,
  };
}

export function detectProductIdentityConflict({ productName = "", productImageAnalysis = "" } = {}) {
  const nameIdentity = inferProductIdentity({ productName });
  const imageIdentity = inferProductIdentity({ productImageAnalysis });
  const conflicts = nameIdentity.id !== "generic"
    && imageIdentity.id !== "generic"
    && nameIdentity.id !== imageIdentity.id;
  return {
    conflicts,
    nameIdentity,
    imageIdentity,
    message: conflicts
      ? `产品名称识别为“${nameIdentity.label}”，但参考图识别为“${imageIdentity.label}”。请确认产品名称或重新上传正确参考图。`
      : "",
  };
}

export function extractUserSellingPointSeeds(rawBriefText = "") {
  const labeled = extractLabeledBlock(rawBriefText, ["用户作图重点", "卖点", "核心卖点", "产品卖点", "要求"]);
  const source = labeled || stripStructuredLines(rawBriefText);
  return uniqueNonEmpty(splitPointText(source).map(cleanSeed).filter((seed) => seed && !isInstructionOnlySeed(seed) && !isHeadingFragment(seed))).slice(0, 12);
}

export function inferBriefSellingPoints({ productName = "", rawBriefText = "", productImageAnalysis = "", outputLanguage = "" } = {}) {
  const identity = inferProductIdentity({ productName, rawBriefText, productImageAnalysis });
  const userSeeds = filterSeedsForIdentity(extractUserSellingPointSeeds(rawBriefText), identity);
  const hints = extractProductHintSeeds(identity, `${productName}\n${productImageAnalysis}\n${userSeeds.join("\n")}`);
  const points = uniqueNonEmpty([...userSeeds, ...hints])
    .map((seed) => upgradeSellingPoint(seed, identity, outputLanguage))
    .filter(Boolean);
  const fallbackPoints = outputLanguage === "English"
    ? identity.profile.fallbackPointsEn || identity.profile.fallbackPoints
    : identity.profile.fallbackPoints;
  return uniqueNonEmpty([...points, ...(points.length ? [] : fallbackPoints)]).slice(0, 10);
}

function filterSeedsForIdentity(seeds, identity) {
  if (!identity || identity.id === "generic") return uniqueNonEmpty(seeds);
  return uniqueNonEmpty(seeds).filter((seed) => categoryProfiles.every((profile) => {
    if (profile.id === identity.id || !profile.leak.test(seed)) return true;
    // A seed that names the current product and another product family is still
    // allowed; otherwise stale examples such as "500-count trash bags" are removed.
    return identity.profile.match.test(seed);
  }));
}

export function buildConcreteBriefSections({ productName = "", visibleProductName = "", sellingPoints = [], rawBriefText = "", productImageAnalysis = "", outputLanguage = "" } = {}) {
  const identity = inferProductIdentity({ productName: `${productName}\n${visibleProductName}`, rawBriefText, productImageAnalysis });
  const points = filterSeedsForIdentity(uniqueNonEmpty(sellingPoints), identity).slice(0, 12);
  const seeds = filterSeedsForIdentity(extractUserSellingPointSeeds(rawBriefText), identity);
  return {
    extractedPoints: seeds.map((seed) => `- ${seed}`).join("\n") || "- 未填写具体卖点，已仅根据当前产品图补充基础展示方向。",
    evidence: buildEvidenceList(points, identity, outputLanguage).map((item) => `- ${item}`).join("\n"),
    risks: buildRiskList(rawBriefText, identity, outputLanguage).map((item) => `- ${item}`).join("\n"),
    proofMatrix: buildProofMatrixText({ productName, visibleProductName, sellingPoints: points, rawBriefText, productImageAnalysis, outputLanguage }),
    mainPlan: buildPlan(points, identity, 5, "主图", outputLanguage, 0),
    detailPlan: buildPlan(points, identity, 8, "详情页", outputLanguage, 5),
  };
}

export function buildProofMatrixText({ productName = "", visibleProductName = "", sellingPoints = [], rawBriefText = "", productImageAnalysis = "", outputLanguage = "" } = {}) {
  const identity = inferProductIdentity({ productName: `${productName}\n${visibleProductName}`, rawBriefText: `${rawBriefText}\n${sellingPoints.join("\n")}`, productImageAnalysis });
  const profile = identity.profile;
  if (outputLanguage === "English") {
    const englishProfile = englishProfileText(profile);
    return [
      `- Product-form chain: ${englishProfile.forms.join(" -> ")}`,
      `- Static proof: ${englishProfile.staticProof}`,
      `- Dynamic proof: ${englishProfile.dynamicProof}`,
      `- Human/prop interaction: ${englishProfile.interaction}`,
      `- Composition anti-repeat: ${englishProfile.antiRepeat}`,
      "- Every image must prove one selected selling point with a different product form, action, or shot distance.",
    ].join("\n");
  }
  return [
    `- 产品身份：${profile.label}`,
    `- 产品形态链：${profile.forms.join(" -> ")}`,
    `- 静态卖点证据：${profile.staticProof}`,
    `- 动态卖点证据：${profile.dynamicProof}`,
    `- 人物/道具互动：${profile.interaction}`,
    `- 构图去重要求：${profile.antiRepeat}`,
    "- 每张图必须回答：证明哪个卖点、展示什么产品形态、由什么动作或细节证明、与相邻图片有什么构图差异。",
  ].join("\n");
}

export function briefExpansionQualityIssues(content = "", { rawBriefText = "", productName = "", productImageAnalysis = "", outputLanguage = "" } = {}) {
  const text = String(content || "").trim();
  const issues = [];
  if (!text) return ["扩写结果为空"];
  if (containsPlaceholderBriefText(text)) issues.push("仍包含待分析或待补充占位句");
  if (genericBriefPhrases.some((phrase) => text.includes(phrase))) issues.push("仍包含通用模板卖点");
  if (/主图规划：\s*\n\s*1\.\s*英雄主图：突出商品外观/.test(text)) issues.push("主图规划仍是空泛模板");
  const identity = inferProductIdentity({ productName, rawBriefText, productImageAnalysis });
  const contamination = crossCategoryContaminationMatches(text, identity, `${productName}\n${productImageAnalysis}`);
  if (contamination.length) issues.push(`包含其他品类污染词：${contamination.join("、")}`);
  const seeds = filterSeedsForIdentity(extractUserSellingPointSeeds(rawBriefText), identity);
  if (seeds.length && !seeds.every((seed) => seedIsCovered(seed, text, identity))) issues.push("未覆盖全部用户明确卖点");
  const audience = extractSimpleField(text, ["人群", "目标人群", "audience"]);
  const category = extractSimpleField(text, ["类目", "品类", "category"]);
  const visibleName = extractSimpleField(text, ["可见展示名", "展示名", "visible product name", "display name"]);
  if (!audience || /Everyday shoppers|请.*分析|自行分析|通用电商用户/i.test(audience)) issues.push("目标人群仍是占位或通用结果");
  if (!category || /Consumer Product|通用电商商品|请.*分析|自行分析/i.test(category)) issues.push("类目仍是占位或通用结果");
  if (!visibleName || /Featured Product|Reference Product|精选商品|未命名商品/i.test(visibleName)) issues.push("可见展示名仍是占位结果");
  issues.push(...visibleDisplayNameEvidenceIssues({ visibleName, productName, productImageAnalysis }));
  const corePoints = extractLabeledBlock(text, ["核心卖点"]);
  const parsedPoints = splitPointText(corePoints).map(cleanSeed).filter((item) => item && !isHeadingFragment(item));
  if (parsedPoints.length < 3) issues.push("核心卖点少于 3 条具体内容");
  const mainPlan = extractLabeledBlock(text, ["主图规划"]);
  const detailPlan = extractLabeledBlock(text, ["详情页规划"]);
  if (numberedPlanCount(mainPlan) !== 5) issues.push("主图规划不是完整 5 条");
  if (numberedPlanCount(detailPlan) !== 8) issues.push("详情页规划不是完整 8 条");
  if (hasRepeatedGenericPlanScene(mainPlan) || hasRepeatedGenericPlanScene(detailPlan)) issues.push("逐屏场景仍重复使用同一通用构图");
  const language = outputLanguage || extractSimpleField(text, ["输出语言", "output language"]);
  if (language === "English" && parsedPoints.some((point) => containsCjk(point))) issues.push("English 模式的核心卖点仍含中文营销句");
  return uniqueNonEmpty(issues);
}

export function inferEvidenceBasedEnglishDisplayName({ productName = "", rawBriefText = "", productImageAnalysis = "" } = {}) {
  const trusted = positiveProductEvidence(`${productName}\n${productImageAnalysis}`);
  const source = positiveProductEvidence(`${trusted}\n${rawBriefText}`);
  if (!/(牛至油|oregano\s*oil|膳食补充剂|营养补充剂|保健品|软胶囊|胶囊|滴剂|滴管|capsules?|softgels?|dropper|liquid\s+(?:dietary\s+)?supplement|dietary\s*supplement|supplement)/i.test(source)) {
    return "";
  }
  if (/(牛至油|oregano\s*oil)/i.test(source)) return "Oregano Oil Supplement";

  const liquid = /(滴剂|滴管|液体补充剂|liquid\s+(?:dietary\s+)?supplement|dropper|pipette)/i.test(source);
  const softgel = /(软胶囊|softgels?)/i.test(source);
  const capsule = /(胶囊|capsules?)/i.test(source);
  if (/\bNAD\s*\+|烟酰胺腺嘌呤二核苷酸/i.test(source)) {
    return liquid ? "NAD+ Liquid Dietary Supplement" : "NAD+ Dietary Supplement";
  }
  if (/(喜来芝|shilajit)/i.test(source)) {
    return liquid ? "Shilajit Liquid Dietary Supplement" : "Shilajit Dietary Supplement";
  }
  if (softgel) return "Dietary Supplement Softgels";
  if (capsule) return "Dietary Supplement Capsules";
  if (liquid) return "Liquid Dietary Supplement";
  return "Dietary Supplement";
}

export function visibleDisplayNameEvidenceIssues({ visibleName = "", productName = "", productImageAnalysis = "" } = {}) {
  const name = String(visibleName || "").trim();
  if (!name) return [];
  const trusted = positiveProductEvidence(`${productName}\n${productImageAnalysis}`);
  const issues = [];
  const trustedIdentity = inferProductIdentity({ productName, productImageAnalysis });
  const visibleIdentity = inferProductIdentity({ productName: name });
  if (trustedIdentity.id !== "generic" && visibleIdentity.id !== "generic" && trustedIdentity.id !== visibleIdentity.id) {
    issues.push(`可见展示名识别为“${visibleIdentity.label}”，但产品名称和识图证据识别为“${trustedIdentity.label}”`);
  }
  if (/oregano\s*oil/i.test(name) && !/(牛至油|oregano\s*oil)/i.test(trusted)) {
    issues.push("可见展示名包含 Oregano Oil，但产品名称和识图结果没有对应产品证据");
  }
  if (/(capsules?|softgels?)/i.test(name) && /(滴剂|滴管|liquid\s+(?:dietary\s+)?supplement|dropper|pipette)/i.test(trusted) && !/(胶囊|capsules?|softgels?)/i.test(trusted)) {
    issues.push("可见展示名使用胶囊剂型，但识图证据显示为液体滴剂");
  }
  if (/(liquid|dropper)/i.test(name) && /(胶囊|capsules?|softgels?)/i.test(trusted) && !/(滴剂|滴管|liquid|dropper|pipette)/i.test(trusted)) {
    issues.push("可见展示名使用液体滴剂剂型，但识图证据显示为胶囊剂型");
  }
  return issues;
}

function positiveProductEvidence(value = "") {
  return String(value || "")
    .replace(/\b(?:no|not|without)\s+oregano(?:\s+oil)?\b/gi, "")
    .replace(/(?:没有|未见|不含|并非|不是)\s*牛至油/g, "")
    .replace(/\b(?:no|not|without)\s+(?:capsules?|softgels?|dropper|liquid)\b/gi, "")
    .replace(/(?:没有|未见|不含|并非|不是)\s*(?:胶囊|软胶囊|滴剂|滴管)/g, "");
}

export function isLowQualityBriefExpansion(content = "", options = {}) {
  return briefExpansionQualityIssues(content, options).length > 0;
}

export function genericBriefPhrasesForPrompt() {
  return genericBriefPhrases.map((phrase) => `- ${phrase}`).join("\n");
}

function countMatches(source, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...String(source || "").matchAll(new RegExp(pattern.source, flags))].length;
}

function extractProductHintSeeds(identity, source) {
  const text = String(source || "");
  if (identity.id === "blender") {
    const hints = [];
    if (/容量|大杯|多人|全家|large/i.test(text)) hints.push("大容量搅拌杯");
    if (/豆浆|米糊|果汁|奶昔|辅食|饮品/i.test(text)) hints.push("早餐饮品制作");
    if (/细腻|破壁|搅拌|粉碎|打磨|刀头/i.test(text)) hints.push("食材搅拌更细腻");
    if (/清洗|易洗|拆洗|清洁/i.test(text)) hints.push("杯体清洁更方便");
    return hints;
  }
  if (identity.id === "trash-bag") {
    const hints = [];
    if (/艾草|除臭|防臭|祛味|odor/i.test(text)) hints.push("艾草祛味防臭");
    if (/抽绳|收口|drawstring/i.test(text)) hints.push("抽绳自动收口");
    if (/500\s*只|500-count/i.test(text)) hints.push("500只囤货装");
    if (/数量多|多卷|囤货|bulk/i.test(text)) hints.push("多卷囤货装");
    if (/加厚|不易破|耐撕|tear/i.test(text)) hints.push("加厚袋身不易破");
    return hints;
  }
  if (identity.id === "bike-basket") return [
    /防水|防雨|雨|waterproof|rain/i.test(text) ? "雨天防水收纳" : "",
    /大容量|容量|能装|头盔|买菜|杂物|large|capacity/i.test(text) ? "大容量车篮收纳" : "",
    /稳固|固定|承重|耐装|不晃|solid|stable/i.test(text) ? "稳固安装不易晃" : "",
  ].filter(Boolean);
  if (identity.id === "robot") {
    const hints = [];
    if (/多语言|方言|双语|中文|英文|英语|日语|粤语|闽南语|语言/i.test(text)) hints.push("多语言与方言互动");
    if (/语音|对话|聊天|唤醒/i.test(text)) hints.push("趣味语音交互");
    if (/故事|成语接龙|成语/i.test(text)) hints.push("故事与成语接龙玩法");
    if (/学习|答疑|百科|早教/i.test(text)) hints.push("学习答疑与早教陪伴");
    if (/玩法丰富|玩法|游戏|跳舞|动作/i.test(text)) hints.push("多种互动玩法");
    if (/联网|WiFi|智能聊天/i.test(text)) hints.push("联网智能聊天");
    if (/续航|电池|电量/i.test(text)) hints.push("长续航");
    return hints;
  }
  return [];
}

function upgradeSellingPoint(seed, identity, outputLanguage) {
  const clean = cleanSeed(seed);
  if (!clean) return "";
  if (outputLanguage === "English") return upgradeEnglishPoint(clean, identity);
  if (identity.id === "blender") {
    if (/容量|大杯|多人|全家/.test(clean)) return "大容量搅拌杯，一次处理多份食材更省心";
    if (/豆浆|米糊|果汁|奶昔|辅食|饮品/.test(clean)) return "豆浆、米糊或果汁等饮品制作更方便";
    if (/细腻|破壁|搅拌|粉碎|打磨|刀头/.test(clean)) return "食材搅拌更细腻，口感更均匀";
    if (/清洗|易洗|拆洗|清洁/.test(clean)) return "杯体与可见结构便于日常清洁";
    if (/轻便|收纳/.test(clean)) return "台面摆放与日常收纳更省心";
    return `${clean}，用真实食材处理场景和机身细节证明`;
  }
  if (identity.id === "trash-bag") {
    if (/艾草|除臭|防臭|祛味/.test(clean)) return "艾草祛味防臭，厨房异味更少";
    if (/抽绳|收口/.test(clean)) return "抽绳一拉收口，打包不脏手";
    if (/500/.test(clean)) return "500只囤货装，日常换袋更省心";
    if (/数量|多卷|囤货/.test(clean)) return "多卷囤货装，日常换袋更省心";
    if (/加厚|不易破|防破|耐撕|结实/.test(clean)) return "加厚袋身，日常承装不易破漏";
    if (/容量|能装/.test(clean)) return "大容量袋身，厨余杂物更好装";
    if (/承重|耐装|装满/.test(clean)) return "承装提起更安心，用真实装载动作证明";
    return `${clean}，用真实使用动作和袋身细节证明`;
  }
  if (identity.id === "bike-basket") {
    if (/防水|防雨|雨/.test(clean)) return "防水车篮，雨天放物更安心";
    if (/容量|能装|头盔|买菜|杂物/.test(clean)) return "大容量篮筐，头盔雨具杂物都好放";
    if (/稳固|固定|承重|耐装|结实|不易破|不晃/.test(clean)) return "稳固承托，骑行颠簸也不易晃";
    return `${clean}，用骑行收纳场景和固定结构细节证明`;
  }
  if (identity.id === "robot") {
    if (/多语言|方言|双语|中文|英文|英语|日语|粤语|闽南语|语言/.test(clean)) return "多语言与方言互动，用语言课堂和对话场景证明";
    if (/联网|WiFi|智能聊天|云端|网络/.test(clean)) return "联网智能聊天，用云端连接和对话关系图证明";
    if (/语音|对话|聊天|唤醒/.test(clean)) return "趣味语音交互，用倾听、回应和声波关系证明";
    if (/故事|成语接龙|成语/.test(clean)) return "讲故事与成语接龙，用绘本和互动卡牌证明";
    if (/学习|答疑|百科|早教/.test(clean)) return "学习答疑，用课本、问题卡和孩子提问动作证明";
    if (/玩法丰富|玩法|游戏|跳舞|动作/.test(clean)) return "玩法丰富，用动作路径和多种互动区域证明";
    if (/续航|电池|电量/.test(clean)) return "长续航，用电池能量图和从早到晚时间线表达，不写具体时长";
    if (/孩子|玩伴|陪伴|亲子/.test(clean)) return "孩子贴心玩伴，用亲子陪伴和日常互动场景证明";
    if (/关节|可动|姿势/.test(clean)) return "多关节可动，用不同姿势和关节局部近景证明";
    if (/潮玩|摆件|桌面|颜值/.test(clean)) return "潮玩桌面摆件，用书桌陈列和产品尺度证明";
    return `${clean}，先安排一个具体场景或视觉证据，再决定机器人出场大小`;
  }
  return clean;
}

function upgradeEnglishPoint(seed, identity) {
  if (identity.id === "blender") {
    if (/容量|大杯|多人|全家|large/i.test(seed)) return "Large blending cup for everyday multi-serve preparation";
    if (/豆浆|米糊|果汁|奶昔|辅食|饮品|drink/i.test(seed)) return "Convenient for soy milk, smoothies and everyday drinks";
    if (/细腻|破壁|搅拌|粉碎|打磨|刀头|blend/i.test(seed)) return "Smooth blending performance for a more even texture";
    if (/清洗|易洗|拆洗|清洁|clean/i.test(seed)) return "Cup and visible parts designed for everyday cleaning";
  }
  if (identity.id === "trash-bag") {
    if (/500/.test(seed)) return "500-count bulk pack for everyday home stocking";
    if (/数量|多卷|囤货|bulk/i.test(seed)) return "Multi-roll pack for everyday home stocking";
    if (/抽绳|收口|drawstring/i.test(seed)) return "Drawstring closure for cleaner tie-and-carry use";
    if (/加厚|不易破|耐撕|结实|tear/i.test(seed)) return "Thicker bag body helps reduce leaks and tears";
  }
  if (identity.id === "bike-basket") {
    if (/防水|防雨|雨|waterproof|rain/i.test(seed)) return "Water-resistant covered storage for rainy-day rides";
    if (/容量|能装|头盔|买菜|杂物|capacity|storage/i.test(seed)) return "Roomy basket storage for daily riding essentials";
    if (/稳固|固定|承重|不晃|stable|secure/i.test(seed)) return "Secure mounting structure for steadier everyday storage";
  }
  if (identity.id === "robot") {
    if (/多语言|方言|双语|中文|英文|英语|语言|language|dialect/i.test(seed)) return "Multilingual and dialect-friendly interaction";
    if (/语音|对话|聊天|唤醒|voice|chat/i.test(seed)) return "Engaging voice interaction for everyday conversation";
    if (/故事|成语|儿歌|story/i.test(seed)) return "Interactive stories and word games for playful learning";
    if (/学习|答疑|百科|早教|learn|question/i.test(seed)) return "Question-and-answer support for everyday learning";
    if (/玩法|游戏|跳舞|动作|play|game/i.test(seed)) return "Varied play modes with expressive movement";
    if (/联网|WiFi|智能聊天|network|cloud/i.test(seed)) return "Connected AI conversation for up-to-date interaction";
    if (/续航|电池|电量|battery|power/i.test(seed)) return "Long-lasting power for day-to-night companionship";
    if (/关节|可动|姿势|joint|pose/i.test(seed)) return "Articulated joints for more expressive poses";
    if (/潮玩|摆件|桌面|颜值|desktop|collectible/i.test(seed)) return "A playful desktop collectible with character";
  }
  if (identity.id === "dietary-supplement") {
    if (/双活性|复配|配方|成分|ingredient|formula|blend/i.test(seed)) return "A thoughtfully paired ingredient formula";
    if (/牛至油|oregano/i.test(seed)) return "Oregano oil in a convenient daily supplement format";
    if (/胶囊|软胶囊|剂型|capsule|softgel/i.test(seed)) return "Easy-to-recognize capsule format for a simple routine";
    if (/便携|随身|日常|routine|portable/i.test(seed)) return "Easy to include in an everyday wellness routine";
  }
  if (identity.id === "umbrella") {
    if (/轻便|便携|折叠|portable|compact/i.test(seed)) return "Compact and easy to carry for daily travel";
    if (/防雨|晴雨|防水|rain/i.test(seed)) return "Everyday rain coverage for changing weather";
    if (/伞骨|稳固|抗风|frame|wind/i.test(seed)) return "Visible frame details designed for everyday confidence";
  }
  if (identity.id === "chair") {
    if (/轻便|移动|light/i.test(seed)) return "Lightweight mobility for easy room-to-room use";
    if (/静音|滚轮|quiet|caster|wheel/i.test(seed)) return "Smooth rolling movement for quieter indoor use";
    if (/靠背|舒适|坐垫|support|comfort/i.test(seed)) return "Supportive backrest and padded seat for everyday comfort";
  }
  if (identity.id === "drinkware") {
    if (/便携|携带|portable|carry/i.test(seed)) return "Easy to carry for commuting and daily hydration";
    if (/保温|热水|temperature|insulated/i.test(seed)) return "Insulated drinkware for everyday hot or cold drinks";
    if (/杯盖|杯口|密封|lid|leak/i.test(seed)) return "Visible lid and opening details for confident everyday use";
  }
  if (identity.id === "footwear") {
    if (/轻便|轻量|light/i.test(seed)) return "Lightweight comfort for everyday movement";
    if (/透气|网面|breathable|mesh/i.test(seed)) return "Breathable mesh comfort for daily wear";
    if (/鞋底|防滑|outsole|grip/i.test(seed)) return "Visible outsole texture for everyday traction";
  }
  if (/轻便|轻量|lightweight/i.test(seed)) return "Lightweight handling for easier everyday use";
  if (/大容量|容量大|capacity|roomy/i.test(seed)) return "Roomy capacity for everyday essentials";
  if (/耐用|结实|不易破|durable|strong/i.test(seed)) return "Visible construction details for everyday durability";
  if (/方便|易用|便捷|easy|convenient/i.test(seed)) return "Simple, convenient use for everyday routines";
  if (!containsCjk(seed)) return seed;
  return "A practical everyday benefit shown through real-use evidence";
}

function buildEvidenceList(points, identity, outputLanguage) {
  return uniqueNonEmpty(points.map((point) => {
    if (identity.id === "blender") {
      if (/容量|multi-serve|large/i.test(point)) return outputLanguage === "English" ? "Use an overhead or side view with real fruit or grains inside the blending cup; do not invent a volume." : "搅拌杯中放入真实水果、谷物或液体食材，使用俯拍或侧拍展示可见空间，不写虚构毫升数。";
      if (/豆浆|米糊|果汁|饮品|soy milk|smoothie|drink/i.test(point)) return outputLanguage === "English" ? "Show ingredients, the blender and a hand pouring the finished drink; do not invent nutrition claims." : "展示食材、破壁机和倒入杯中的成品饮品，证明早餐饮品制作场景，不虚构营养或功效。";
      if (/细腻|搅拌|smooth|blend/i.test(point)) return outputLanguage === "English" ? "Use the control area, cup contents and a finished-texture close-up as visible proof; do not invent speed data." : "用控制区操作、杯内食材处理过程或倒出后的均匀饮品视觉证明，不虚构转速或检测数据。";
      if (/清洁|clean/i.test(point)) return outputLanguage === "English" ? "Show the cup, lid and visible parts being rinsed without inventing removable components." : "展示杯体、杯盖与可见结构的清洁或冲洗场景，不编造可拆洗结构。";
    }
    if (identity.id === "trash-bag") {
      if (/抽绳/.test(point)) return "手部拉起抽绳，袋口收紧并从桶内提起，证明收口便利。";
      if (/500|多卷|囤货/.test(point)) return "展示真实包装上的数量信息或整齐卷装收纳；未提供具体数量时不展示数字。";
      if (/加厚|不易破|承装/.test(point)) return "局部放大袋身边缘，并展示装满后手提动作，不写虚构厚度或承重数。";
    }
    if (identity.id === "bike-basket") {
      if (/防水|雨天/.test(point)) return "展示车篮安装状态、防水盖或表面水珠，不写虚构防水等级。";
      if (/容量/.test(point)) return "放入头盔、雨衣或日常杂物，用真实装载证明容量，不写虚构升数。";
      if (/稳固/.test(point)) return "放大固定点、加固边缘和车把连接处，不写未提供承重数。";
    }
    if (identity.id === "robot") {
      if (/多语言|方言|双语|语言/.test(point)) return "用教室黑板、中文/English/方言语言卡和不同对话气泡作为大视觉元素，机器人可缩小为正在授课的小老师；不把示例语言列表当作未经确认的功能数量。";
      if (/语音|对话|聊天/.test(point)) return "用麦克风、声波、提问卡和机器人倾听/回应姿态证明语音互动，不只在机器人旁边放文字。";
      if (/故事|成语/.test(point)) return "用打开的绘本、成语接龙卡、故事灯光和孩子翻页动作构建大场景，机器人作为讲故事伙伴出现。";
      if (/学习|答疑|百科|早教/.test(point)) return "用课本、问题卡、黑板和孩子提问动作构建学习场景，机器人指向问题或做回应姿态。";
      if (/玩法|游戏|跳舞|动作/.test(point)) return "用游戏卡、动作轨迹、舞蹈姿态或多区域互动板作为画面主体，安排多个不同机器人姿势作为玩法证据。";
      if (/续航|电池|电量/.test(point)) return "不要求机器人完整出场；以大型电池能量图、从早到晚时间线和小型机器人轮廓/屏幕插图表现长续航，不写具体小时数。";
      if (/联网|WiFi|智能聊天/.test(point)) return "用云端节点、WiFi连接线、家庭设备和聊天关系图作为大视觉元素，机器人作为连接终端或小型插图出现。";
      if (/关节|可动|姿势/.test(point)) return "用抬手、弯腿、转身等明显不同姿态和手臂/腿部关节放大圈证明可动，不重复正面站姿。";
      if (/潮玩|摆件|桌面|颜值/.test(point)) return "用书桌、展示架、台灯和潮玩尺度建立桌面陈列场景，机器人采用3/4站姿或坐姿作为第一视觉主体。";
    }
    if (identity.id === "dietary-supplement") {
      if (/配方|成分|复配|formula|ingredient|paired/i.test(point)) return outputLanguage === "English"
        ? "Build a restrained ingredient relationship visual using only user-provided ingredients, with the real package as an identity anchor; do not imply clinical efficacy."
        : "仅使用用户明确提供的成分制作克制的配方关系图，真实包装作为身份锚点，不暗示临床疗效。";
      if (/胶囊|软胶囊|剂型|capsule|softgel/i.test(point)) return outputLanguage === "English"
        ? "Use a macro view of the actual capsule or softgel form beside the package; do not invent dosage instructions."
        : "用真实胶囊或软胶囊剂型近景搭配包装，不虚构剂量和服用说明。";
      return outputLanguage === "English"
        ? "Show the real package in an adult daily routine with a meal-side or storage action; avoid medical settings and treatment claims."
        : "在成年人日常动线中展示真实包装与随餐摆放或收纳动作，避免医疗环境和治疗暗示。";
    }
    return outputLanguage === "English"
      ? `Show a real-use action or close-up detail that proves: ${point}.`
      : `围绕“${point}”安排真实使用动作、道具或局部放大证明。`;
  })).slice(0, 8);
}

function buildRiskList(rawBriefText, identity, outputLanguage) {
  const risks = [outputLanguage === "English"
    ? "Do not invent certifications, test values, exact prices, sales volume, material grades, or performance claims."
    : "不得虚构认证、检测数据、尺寸、材质等级、具体价格、销量或性能参数。"];
  const source = String(rawBriefText || "");
  if (/耐高温|高温|开水|热水/.test(source)) risks.push(outputLanguage === "English"
    ? "Do not claim boiling-water resistance unless verified test evidence is provided."
    : "涉及耐高温、开水等描述时，不得虚构耐温数据或直接展示未经验证的极端使用。 ");
  if (/便宜|价格|低价|性价比|划算/.test(source)) risks.push(outputLanguage === "English"
    ? "Do not use exact prices, lowest-price claims, or platform promotion badges."
    : "性价比只能用实用、耐用或高频使用价值表达，不得出现具体价格、最低价或平台促销贴。 ");
  if (identity.id === "generic") risks.push(outputLanguage === "English"
    ? "Because product category is not confirmed, only show visible product features and user-provided claims."
    : "当前品类未完全确认，只能围绕可见产品特征和用户明确卖点作图，不得借用其他品类场景。 ");
  return risks;
}

function buildPlan(points, identity, count, label, outputLanguage, offset = 0) {
  const fallbackPoints = outputLanguage === "English"
    ? identity.profile.fallbackPointsEn || identity.profile.fallbackPoints
    : identity.profile.fallbackPoints;
  const safePoints = points.length ? points : fallbackPoints;
  return Array.from({ length: count }, (_, index) => {
    const globalIndex = index + offset;
    const point = safePoints[globalIndex % safePoints.length];
    const form = planFormFor(identity, point, globalIndex, outputLanguage);
    const headline = buyerHeadlineForPoint(point, outputLanguage);
    const scene = planSceneFor(identity, point, globalIndex, outputLanguage);
    const proof = planProofFor(identity, point, globalIndex, outputLanguage);
    const composition = planCompositionFor(globalIndex, outputLanguage);
    const visual = planVisualTreatmentFor(globalIndex, outputLanguage);
    if (outputLanguage === "English") {
      return `${index + 1}. ${label} focus: ${point}; product state: ${form}; visible headline: ${headline}; scene and action: ${scene}; composition: ${composition}; visual treatment: ${visual}; visible proof: ${proof}; avoid: invented numbers, unrelated category props, medical or certification claims, platform badges, and mixed-language copy.`;
    }
    return `${index + 1}. 卖点：${point}；产品形态：${form}；可见标题：${headline}；场景与动作：${scene}；构图：${composition}；视觉质感：${visual}；证明方式：${proof}；禁写：虚构参数、非当前品类道具、医疗或认证暗示、平台水印和混合语言文案。`;
  }).join("\n");
}

function planFormFor(identity, point, index, outputLanguage) {
  const value = String(point || "");
  if (identity.id === "robot") {
    if (/续航|电池|电量|battery|power/i.test(value)) return outputLanguage === "English" ? "battery-energy infographic with a small product anchor" : "电量与全天陪伴信息图";
    if (/联网|WiFi|智能聊天|云端|网络|network|cloud/i.test(value)) return outputLanguage === "English" ? "network relationship visual with a small connected robot" : "联网关系图与小型终端";
    if (/多语言|方言|双语|中文|英文|英语|日语|粤语|闽南语|语言|language|dialect/i.test(value)) return outputLanguage === "English" ? "language-learning scene with cards and a teaching pose" : "语言课堂与语言卡片";
    if (/故事|成语接龙|成语|儿歌|story|word game/i.test(value)) return outputLanguage === "English" ? "storytelling interaction with books and word cards" : "故事/成语接龙互动";
    if (/语音|对话|聊天|唤醒|问答|多模型|模型|voice|chat/i.test(value)) return outputLanguage === "English" ? "voice-interaction close-up with listening and response states" : "语音互动近景与回应关系";
    if (/学习|答疑|百科|早教|课本|learning|question/i.test(value)) return outputLanguage === "English" ? "learning support scene with a textbook and question cards" : "学习答疑场景与问题卡";
    if (/玩法丰富|玩法|游戏|跳舞|play|game/i.test(value)) return outputLanguage === "English" ? "play board with several distinct action poses" : "游戏板与多种动作姿态";
    if (/多关节|关节|可动|动作|姿势|joint|pose/i.test(value)) return outputLanguage === "English" ? "articulated action poses with joint close-ups" : "多关节动态姿势与局部近景";
    if (/孩子|玩伴|陪伴|亲子|child|companion/i.test(value)) return outputLanguage === "English" ? "parent-child interaction and companionship scene" : "亲子互动与陪伴场景";
    if (/潮玩|摆件|桌面|颜值|造型|外观|desktop|collectible/i.test(value)) return outputLanguage === "English" ? "desktop collectible hero view" : "桌面摆件静态全貌";
  }
  const forms = outputLanguage === "English" ? englishProfileText(identity.profile).forms : identity.profile.forms;
  return forms[index % forms.length];
}

function englishProfileText(profile) {
  if (profile.formsEn) return {
    forms: profile.formsEn,
    staticProof: profile.staticProofEn,
    dynamicProof: profile.dynamicProofEn,
    interaction: profile.interactionEn,
    antiRepeat: profile.antiRepeatEn,
  };
  const presets = {
    blender: {
      forms: ["full appliance hero", "cup and lid detail", "ingredient loading", "active blending state", "blade or control close-up"],
      staticProof: "Use the appliance body, cup, lid, controls and visible structure as product proof.",
      dynamicProof: "Use ingredient loading, operation, pouring and cleaning actions to prove everyday value.",
      interaction: "Fruit, grains, drinkware, a breakfast counter and hands may support the scene while the appliance stays primary.",
      antiRepeat: "Rotate between full product, loading, operation, finished drink and structural close-up.",
    },
    "trash-bag": {
      forms: ["rolled pack", "single opened bag", "bag fitted to a bin", "drawstring closure", "filled carry or stored rolls"],
      staticProof: "Use actual package count, bag edge, base and drawstring structure as visible proof.",
      dynamicProof: "Use fitting, closing, lifting and storage actions to prove convenience.",
      interaction: "Hands, a kitchen bin and a storage cabinet may support only the bag benefit.",
      antiRepeat: "Do not repeat a rolls-left and open-bag-right layout; change form, camera distance and proof method.",
    },
    "bike-basket": {
      forms: ["installed basket hero", "open loading state", "closed weather cover", "mounting close-up", "commuting storage scene"],
      staticProof: "Use the basket body, cover, reinforced edge and mounting points as structural proof.",
      dynamicProof: "Use loading, closing and commuting retrieval actions to prove capacity and convenience.",
      interaction: "A handlebar, helmet, rainwear, groceries and hands may support the storage benefit.",
      antiRepeat: "Rotate between installation, loading, protection, mounting and commuting use.",
    },
    robot: {
      forms: ["desktop collectible hero", "language-learning scene", "story interaction", "articulated action poses", "battery or network infographic"],
      staticProof: "Use the real color scheme, LED face, ear details, joints and desktop scale as identity proof.",
      dynamicProof: "Change pose, expression, direction and interaction partner according to each benefit.",
      interaction: "Books, language cards, a blackboard, family members, cloud nodes and battery visuals may become the large scene elements.",
      antiRepeat: "Rotate between hero product, scene-led visual, infographic, action pose, detail and human interaction.",
    },
    generic: {
      forms: ["full product hero", "core structure", "real-use action", "macro detail", "storage or decision scene"],
      staticProof: "Use visible appearance, material, structure and key details as proof.",
      dynamicProof: "Use a believable action, hand interaction or scene prop to prove the selected benefit.",
      interaction: "People, hands, props and environments may support the benefit without hiding the product.",
      antiRepeat: "Change product state, action, proof method and camera distance on every screen.",
    },
  };
  return presets[profile.id] || presets.generic;
}

function planSceneFor(identity, point, index, outputLanguage) {
  if (identity.id === "blender") {
    if (/容量/.test(point)) return outputLanguage === "English"
      ? "Show the blender cup with visible fruit, oats or grains inside on a bright breakfast counter, using an overhead angle to make the usable space clear"
      : "早餐台面上将水果、燕麦或谷物放入搅拌杯，采用俯拍或侧拍，让杯内可见空间成为画面重点";
    if (/豆浆|米糊|果汁|饮品/.test(point)) return outputLanguage === "English"
      ? "Place soybeans or fruit beside the blender, then show a hand pouring the finished drink into a glass"
      : "破壁机旁放置黄豆或水果，手部将完成的饮品倒入玻璃杯，整机和饮品都清楚可见";
    if (/细腻|搅拌/.test(point)) return outputLanguage === "English"
      ? "Use a close-up of the control area and cup contents, with a secondary detail crop of the blending texture"
      : "控制区与杯内食材同框，搭配一处饮品细腻质感近景，突出处理过程而不写转速参数";
    if (/清洁/.test(point)) return outputLanguage === "English"
      ? "Show the empty cup, lid and visible parts being rinsed on a clean kitchen counter without inventing removable components"
      : "干净厨房台面上展示空杯、杯盖和可见结构的冲洗或擦拭动作，不编造未提供的可拆洗部件";
    return outputLanguage === "English"
      ? "Use a clean kitchen counter with the full blender as the first visual subject and one breakfast prop"
      : "明亮厨房台面展示完整破壁机，搭配少量早餐食材，保持整机为第一视觉主体";
  }
  if (identity.id === "trash-bag") {
    if (/抽绳/.test(point)) return outputLanguage === "English"
      ? "Show hands pulling the drawstring closed and lifting the bag from a bin"
      : "手部拉起抽绳，展示袋口收紧并从垃圾桶中提起的连续动作";
    if (/500|多卷|囤货/.test(point)) return outputLanguage === "English"
      ? "Show only the actual package quantity and neatly stored rolls; do not invent a count when the package does not show one"
      : "只展示包装上真实可见的数量信息与整齐收纳的卷装；未提供数量时不得自行添加数字";
    if (/加厚|不易破|承装/.test(point)) return outputLanguage === "English"
      ? "Use a close-up of the bag edge with a separate hand-lift moment after normal daily loading"
      : "袋身边缘做近景放大，另一处展示日常装载后手提离桶的动作，避免复用卷装构图";
  }
  if (identity.id === "bike-basket") {
    if (/防水|雨天/.test(point)) return outputLanguage === "English"
      ? "Show the basket installed on the handlebar with the cover closed and light rain beads on the visible outer surface"
      : "车篮安装在车把前端，防水盖或罩处于闭合状态，外表有轻微水珠，篮内物品被遮挡保护";
    if (/容量/.test(point)) return outputLanguage === "English"
      ? "Show hands loading a helmet, raincoat or grocery bag into the open basket from an overhead three-quarter view"
      : "从斜俯视角展示手部把头盔、雨衣或买菜袋放入打开的篮筐，用真实物品比例证明容量";
    if (/稳固/.test(point)) return outputLanguage === "English"
      ? "Use a macro close-up of the mounting point, reinforced edge and handlebar connection"
      : "固定扣、加固边缘和车把连接处进行局部近景，简洁标线指向可见结构";
  }
  if (identity.id === "robot") {
    if (/多语言|方言|双语|中文|英文|英语|日语|粤语|闽南语|语言/.test(point)) return outputLanguage === "English"
      ? "Make a classroom blackboard, language cards and conversation bubbles the large visual elements; show Chinese, English and dialect examples as learning props, with the robot smaller as a friendly teacher. Do not claim an unverified language count."
      : "让教室黑板、中文/English/方言语言卡和对话气泡成为大视觉元素，机器人缩小为正在授课的小老师；语言示例只作画面道具，不暗示未经确认的支持数量";
    if (/语音|对话|聊天|唤醒/.test(point)) return outputLanguage === "English"
      ? "Build a voice interaction scene with a microphone, sound waves, a question card and a listening/answering robot pose; the robot is evidence, not just a product beside text."
      : "用麦克风、声波、提问卡和机器人倾听/回应姿态构建语音互动场景，不只在机器人旁边放文字";
    if (/故事|成语接龙|成语/.test(point)) return outputLanguage === "English"
      ? "Use an open storybook, idiom-chain cards, a child turning pages and warm reading light as the large scene; the robot acts as a storytelling partner."
      : "用打开的绘本、成语接龙卡、孩子翻页动作和暖光阅读角构建大场景，机器人作为讲故事伙伴出现";
    if (/学习|答疑|百科|早教/.test(point)) return outputLanguage === "English"
      ? "Make the textbook, question card, blackboard and the child's asking gesture the main scene elements; the robot points toward the question or answers it."
      : "用课本、问题卡、黑板和孩子提问动作构建学习答疑场景，机器人指向问题或做回应姿态";
    if (/玩法丰富|玩法|游戏|跳舞|动作/.test(point)) return outputLanguage === "English"
      ? "Use a game board, action paths, movement cards and several distinct robot poses to make varied play visible; do not reuse one standing pose."
      : "用游戏板、动作轨迹、玩法卡和多个不同机器人姿势表现玩法丰富，不复用同一个站姿";
    if (/续航|电池|电量/.test(point)) return outputLanguage === "English"
      ? "Do not require a full robot hero shot; make a large battery-energy visual and a sunrise-to-night timeline dominant, with only a small robot silhouette or screen inset. Do not invent hours."
      : "不要求机器人完整出场，以大型电池能量视觉和从早到晚时间线为画面主体，机器人只作为小型轮廓或屏幕插图，不写具体小时数";
    if (/联网|WiFi|智能聊天/.test(point)) return outputLanguage === "English"
      ? "Make cloud nodes, Wi-Fi connection lines, home devices and a chat relationship map the dominant visual; show the robot as a small connected terminal."
      : "让云端节点、WiFi连接线、家庭设备和聊天关系图成为大视觉元素，机器人作为小型连接终端出现";
    if (/关节|可动|姿势/.test(point)) return outputLanguage === "English"
      ? "Show clearly different raised-arm, bent-leg and turned poses with close-up joint callouts; avoid the original front-facing idle pose."
      : "用抬手、弯腿、转身等明显不同姿态和手臂/腿部关节近景证明可动，避免原图正面呆站";
    if (/潮玩|摆件|桌面|颜值/.test(point)) return outputLanguage === "English"
      ? "Use a desk, display shelf, lamp and scale props to build a collectible desktop scene; the robot uses a three-quarter or seated pose as the visual hero."
      : "用书桌、展示架、台灯和尺度道具建立潮玩桌面陈列场景，机器人采用三分之四角度或坐姿作为视觉主体";
  }
  if (identity.id === "dietary-supplement") {
    if (/配方|成分|复配|formula|ingredient|paired/i.test(point)) return outputLanguage === "English"
      ? "Place the real bottle beside restrained ingredient cues connected by thin lines; use only ingredients confirmed by the user or package"
      : "真实瓶身与用户或包装已确认的原料意象同框，用细线建立克制的配方关系，不制作人体疗效图";
    if (/胶囊|软胶囊|剂型|capsule|softgel/i.test(point)) return outputLanguage === "English"
      ? "Use a macro view of the real dosage form in the foreground with the package softly in the background"
      : "胶囊或软胶囊剂型作为前景微距，真实包装在后景保持清楚可辨";
    const scenesEn = [
      "Use a clean package hero on a neutral wellness shelf with controlled reflections and generous negative space",
      "Show an adult hand taking the bottle from a breakfast-side cabinet as part of a normal daily routine",
      "Place the bottle in a travel pouch beside everyday essentials to show routine portability without medical claims",
      "Use a top-down arrangement of the package, dosage form and only confirmed ingredient cues",
      "Finish with the full package at a three-quarter angle and a small label-detail inset"
    ];
    const scenesZh = [
      "中性健康生活置物架上展示包装英雄图，控制反光并保留充足文案留白",
      "成年人手部从早餐区收纳柜取出瓶身，表现自然日常补充动线",
      "瓶身放入随身收纳包，与日常用品形成便携关系，不暗示医疗用途",
      "俯拍包装、剂型和已确认原料意象，形成清楚的信息关系",
      "三分之四角度展示完整包装，并加入一处标签细节小窗完成收尾"
    ];
    return (outputLanguage === "English" ? scenesEn : scenesZh)[index % 5];
  }
  const genericScenesEn = [
    "Use a clean hero view that makes the product category immediately clear, with one supporting prop tied to the benefit",
    "Show a hand performing the most believable everyday action for this benefit in a real environment",
    "Use an environmental lifestyle scene with a person or scale prop, while keeping the product easy to identify",
    "Move to a macro or side-angle view of the exact material, edge, connector, texture or structure that supports the claim",
    "Use a top-down storage, carrying or decision scene that differs from the opening hero view",
    "Build a problem-to-solution composition with the product visibly resolving one practical concern",
    "Use an action close-up with the product in its active or opened state rather than a static front view",
    "Show the target user interacting with the product from a wider camera distance",
    "Create a tactile macro board with one main detail and two restrained supporting insets",
    "Use a multi-angle grid with front, side, rear or opened/closed states as physically appropriate",
    "Place the product in a realistic routine sequence with props that explain when and why it is used",
    "Use a carrying, storage, gifting or ready-to-use moment as a final purchase reason",
    "Close with a calm three-quarter or overhead product view that does not repeat the opening angle"
  ];
  const genericScenesZh = [
    "用干净英雄视角让品类一眼可辨，只加入一个与卖点直接相关的辅助道具",
    "在真实环境中展示手部完成与本卖点最相关的日常动作",
    "加入人物或尺度道具构建生活场景，同时保持商品清楚可辨",
    "切换到材质、边缘、接口、纹理或结构的微距/侧视角，用真实细节支撑卖点",
    "采用俯拍收纳、携带或决策场景，与首屏英雄图明显区分",
    "用问题与解决方案并置构图，让商品可见地回应一个实际顾虑",
    "用动作近景展示商品正在使用、打开或变化的状态，不做正面静物",
    "拉远镜头，让目标用户与商品发生真实互动并提供尺度关系",
    "制作一主两辅的触感细节板，局部小窗只指向真实结构",
    "用正面、侧面、背面或开合状态组成多角度板，遵守商品物理结构",
    "用真实日常动线和道具说明商品何时使用、为什么值得使用",
    "用携带、收纳、送礼或随手可用的动作完成购买理由",
    "用不同于首屏的三分之四或俯拍静物完成克制收尾"
  ];
  return (outputLanguage === "English" ? genericScenesEn : genericScenesZh)[index % 13];
}

function planCompositionFor(index, outputLanguage) {
  const en = ["large hero subject with negative space", "diagonal action composition", "foreground-midground-background lifestyle depth", "one-main-two-inset detail board", "top-down decision layout", "problem-and-solution split", "tight action crop", "wide human-scale scene", "macro texture board", "multi-angle grid", "routine sequence", "asymmetric lifestyle close", "calm three-quarter closing hero"];
  const zh = ["大主体英雄图加留白", "对角线动作构图", "前中后景生活纵深", "一主两辅细节板", "俯拍决策构图", "问题与解决方案分栏", "紧凑动作近景", "人物尺度远景", "微距纹理信息板", "多角度宫格", "日常动线序列", "非对称生活收尾", "三分之四角度英雄收尾"];
  return (outputLanguage === "English" ? en : zh)[index % en.length];
}

function planVisualTreatmentFor(index, outputLanguage) {
  const en = ["commercial studio clarity, controlled highlights and a clean brand palette", "natural directional light with believable contact shadows", "lifestyle photography with consistent color temperature", "crisp macro texture and restrained callout lines"];
  const zh = ["商业棚拍清晰度、受控高光与统一品牌色", "自然方向光与可信接触阴影", "生活摄影质感与统一色温", "清晰微距质感与克制标线"];
  return (outputLanguage === "English" ? en : zh)[index % en.length];
}

function planProofFor(identity, point, index, outputLanguage) {
  const evidence = buildEvidenceList([point], identity, outputLanguage)[0];
  if (evidence) return evidence;
  return outputLanguage === "English"
    ? `Make the benefit visible through the specified product state, action and camera view; screen ${index + 1} must not rely on text alone.`
    : `通过本屏指定的产品状态、动作和镜头把卖点做成可见证据；第 ${index + 1} 屏不能只靠文字说明。`;
}

function crossCategoryContaminationMatches(content, identity, source) {
  const sourceText = String(source || "");
  const contentText = String(content || "");
  return categoryProfiles.flatMap((profile) => {
    if (profile.id === identity.id || profile.match.test(sourceText)) return [];
    // A glass or water bottle can be a legitimate meal-side prop for a confirmed
    // dietary supplement. It is not evidence that the product became drinkware.
    if (identity.id === "dietary-supplement" && profile.id === "drinkware") return [];
    const match = contentText.match(profile.leak);
    return match ? [`${profile.label}(${match[0]})`] : [];
  });
}

function containsPlaceholderBriefText(content) {
  const normalized = String(content || "").replace(/\s+/g, "");
  return placeholderBriefPatterns.some((pattern) => pattern.test(normalized));
}

function seedIsCovered(seed, content, identity) {
  const clean = cleanSeed(seed);
  const keywords = coverageKeywords(clean, identity);
  return keywords.some((keyword) => String(content || "").includes(keyword));
}

function coverageKeywords(seed, identity) {
  if (identity.id === "blender") {
    if (/容量|大杯|多人|全家/.test(seed)) return ["容量", "搅拌杯", "多份食材"];
    if (/豆浆|米糊|果汁|奶昔|饮品/.test(seed)) return ["豆浆", "米糊", "果汁", "饮品"];
    if (/细腻|破壁|搅拌|粉碎|打磨/.test(seed)) return ["细腻", "搅拌", "打磨"];
  }
  if (identity.id === "robot") {
    if (/多语言|方言|双语|语言|中文|英文|英语|日语|粤语|闽南语/.test(seed)) return ["多语言", "方言", "语言课堂", "语言卡"];
    if (/语音|对话|聊天|唤醒/.test(seed)) return ["语音", "对话", "声波", "麦克风"];
    if (/故事|成语/.test(seed)) return ["故事", "成语", "绘本", "接龙"];
    if (/学习|答疑|百科|早教/.test(seed)) return ["学习", "答疑", "课本", "问题卡"];
    if (/玩法|游戏|跳舞|动作/.test(seed)) return ["玩法", "游戏", "动作", "多种互动"];
    if (/孩子|玩伴|陪伴|亲子/.test(seed)) return ["孩子", "玩伴", "陪伴", "亲子"];
    if (/联网|WiFi|智能聊天/.test(seed)) return ["联网", "WiFi", "云端", "智能聊天"];
    if (/续航|电池|电量/.test(seed)) return ["续航", "电池", "电量", "全天"];
    if (/关节|可动|姿势/.test(seed)) return ["关节", "可动", "姿势"];
    if (/潮玩|摆件|桌面|颜值/.test(seed)) return ["潮玩", "摆件", "桌面"];
  }
  if (identity.id === "trash-bag" && /数量|多卷|囤货|500/.test(seed)) return ["500", "多卷", "囤货", "数量"];
  if (identity.id === "dietary-supplement") {
    if (/双活性|复配|配方|成分|formula|ingredient/.test(seed)) return ["配方", "成分", "复配", "formula", "ingredient", "paired"];
    if (/牛至油|oregano/i.test(seed)) return ["牛至油", "oregano"];
    if (/胶囊|软胶囊|剂型|capsule|softgel/i.test(seed)) return ["胶囊", "软胶囊", "capsule", "softgel"];
  }
  if (containsCjk(seed)) {
    const translated = upgradeEnglishPoint(seed, identity);
    if (translated && !containsCjk(translated)) return [seed.slice(0, 6), ...translated.toLowerCase().split(/\s+/).filter((word) => word.length >= 5).slice(0, 4)];
  }
  return [seed.slice(0, 6)].filter(Boolean);
}

function buyerHeadlineForPoint(point, outputLanguage) {
  const clean = String(point || "").replace(/^[-*\d.、\s]+/, "").replace(/\s+/g, " ").trim();
  if (!clean) return outputLanguage === "English" ? "Clear Everyday Value" : "日常使用更省心";
  const first = clean.split(/[；;,，。.!！?？]/)[0].trim();
  return outputLanguage === "English" ? (first.length > 42 ? `${first.slice(0, 39)}...` : first) : first.slice(0, 14);
}

function splitPointText(value) {
  const normalized = String(value || "")
    .replace(/\r/g, "\n")
    .replace(/(^|\n)\s*[一二三四五六七八九十百]+\s*[、.．)）:]\s*/g, "$1")
    .replace(/(^|\n)\s*\d+\s*[、.．)）:]\s*/g, "$1");
  return normalized.split(/[；、，,\n。.!！?？]+/).flatMap((item) => item.split(/\s+和\s+|\s+及\s+|\s+并且\s+/)).map((item) => item.trim()).filter(Boolean);
}

function extractLabeledBlock(rawBriefText, labels) {
  const lines = String(rawBriefText || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const label = labels.find((item) => new RegExp(`^${escapeRegExp(item)}\\s*[:：]?`).test(line));
    if (!label) continue;
    const sameLine = line.replace(new RegExp(`^${escapeRegExp(label)}\\s*[:：]?\\s*`), "").trim();
    const block = sameLine ? [sameLine] : [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextLine = lines[next].trim();
      if (!nextLine) continue;
      if (/^([^:：]{2,28})\s*[:：]/.test(nextLine)
        && !/^[-*+]\s+/.test(nextLine)
        && !/^\d+\s*[.)、]/.test(nextLine)) break;
      block.push(nextLine);
    }
    if (block.length) return block.join("\n");
  }
  return "";
}

function stripStructuredLines(rawBriefText) {
  return String(rawBriefText || "").split(/\r?\n/).filter((line) => {
    const clean = line.trim();
    if (!clean) return false;
    return !knownStructuredLabels.some((label) => clean === label || clean.startsWith(`${label}：`) || clean.startsWith(`${label}:`));
  }).join("\n");
}

function cleanSeed(value) {
  return String(value || "")
    .replace(/^(?:[-*+]\s*|\d+\s*[.)、）]\s*|[一二三四五六七八九十百]+\s*[、.．)）:]\s*)/, "")
    .replace(/^(重点强调|要求|卖点)\s*[:：]/, "")
    .replace(/[“”'`]/g, "")
    .trim()
    .slice(0, 96);
}

function isInstructionOnlySeed(seed) {
  return /^\d+$/.test(seed)
    || /^[一二三四五六七八九十百]+$/.test(seed)
    || /自行分析|模板|目标平台|输出语言|产品名称|套图比例|生成详情页|禁用元素|规格参数|结构化作图输入/.test(seed)
    || /先安排一个具体场景或视觉证据|再决定机器人出场大小|产品形态\s*[:：]|可见标题\s*[:：]|画面怎么拍\s*[:：]|证明方式\s*[:：]|禁写\s*[:：]/.test(seed);
}

function isHeadingFragment(seed) {
  const clean = String(seed || "").trim();
  return !clean
    || /^[一二三四五六七八九十百]+$/.test(clean)
    || /^(核心|主要|其他|附加|基础)?\s*(卖点|优势|特点|功能|配方卖点|产品介绍)$/.test(clean)
    || /^(core|main|other|additional)\s+(benefits?|features?|selling points?)$/i.test(clean);
}

function extractSimpleField(content, labels) {
  const lines = String(content || "").split(/\r?\n/);
  for (const line of lines) {
    for (const label of labels) {
      const match = line.trim().match(new RegExp(`^${escapeRegExp(label)}\\s*[:：]\\s*(.+)$`, "i"));
      if (match?.[1]) return match[1].trim();
    }
  }
  return "";
}

function numberedPlanCount(block) {
  return String(block || "").split(/\r?\n/).filter((line) => /^\s*\d+\s*[.、)）]/.test(line)).length;
}

function hasRepeatedGenericPlanScene(block) {
  const lines = String(block || "").split(/\r?\n/).filter((line) => /^\s*\d+\s*[.、)）]/.test(line));
  if (lines.length < 3) return false;
  const generic = /Use a product-first composition different from adjacent images|使用与相邻图片不同的产品优先构图/i;
  return lines.filter((line) => generic.test(line)).length >= 3;
}

function containsCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  return values.filter((value) => {
    const clean = String(value || "").trim();
    const key = clean.replace(/\s+/g, "").toLowerCase();
    if (!clean || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((value) => String(value).trim());
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
