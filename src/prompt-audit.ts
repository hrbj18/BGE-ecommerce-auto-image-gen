import type { ProductTask } from "./types.ts";

export type ProductIdentityId =
  | "ai-robot"
  | "footwear"
  | "blender"
  | "trash-bag"
  | "umbrella"
  | "bike-basket"
  | "chair"
  | "drinkware"
  | "dietary-supplement"
  | "student-backpack"
  | "generic";

export interface PromptAuditSpec {
  role: "main" | "detail";
  index: number;
  title: string;
  copy: string[];
  prompt: string;
}

export interface ProductIdentityResult {
  id: ProductIdentityId;
  label: string;
  signals: string[];
}

export interface PromptAuditResult {
  ok: boolean;
  identity: ProductIdentityResult;
  expectedCount: number;
  actualCount: number;
  errors: string[];
  warnings: string[];
  forbiddenMatches: string[];
  missingEvidence: string[];
  duplicateSignatures: string[];
}

export interface PromptAuditContext {
  trustedVisualEvidence?: string;
}

type IdentityInput = Pick<
  ProductTask,
  | "productName"
  | "originalProductName"
  | "visibleProductName"
  | "category"
  | "targetAudience"
  | "referenceKeywords"
  | "notes"
> & Partial<Pick<ProductTask, "sellingPoints" | "briefFocus">>;

const identityRules: Array<{
  id: ProductIdentityId;
  label: string;
  terms: RegExp;
}> = [
  { id: "ai-robot", label: "AI机器人", terms: /(豆包|豆宝|机器人|AI机器人|ai机器人|智能机器人|陪伴机器人|早教机器人|学习机器人|儿童机器人|桌面机器人|语音机器人|LED表情|表情屏|多模型|智能对话|AI companion robot|robot)/i },
  { id: "blender", label: "破壁机/搅拌机", terms: /(破壁机|搅拌机|料理机|豆浆机|blender|juice maker)/i },
  { id: "trash-bag", label: "垃圾袋", terms: /(垃圾袋|垃圾桶袋|抽绳袋|trash bag|garbage bag)/i },
  { id: "bike-basket", label: "电动车/自行车篮筐", terms: /(电动车|自行车|电瓶车|车篮|篮筐|前篮|后篮|bike basket|bicycle basket|e-bike basket)/i },
  { id: "umbrella", label: "雨伞", terms: /(雨伞|折叠伞|晴雨伞|遮阳伞|umbrella)/i },
  { id: "chair", label: "椅子", terms: /(椅子|座椅|靠背|滚轮椅|办公椅|chair|seat)/i },
  { id: "drinkware", label: "水杯/水壶", terms: /(水杯|水壶|保温杯|温显杯|玻璃杯|热水壶|drinkware|water bottle|kettle|thermos)/i },
  { id: "footwear", label: "鞋类", terms: /(鞋类|鞋子|拖鞋|凉拖|家居鞋|洞洞鞋|跑鞋|运动鞋|sneaker|shoe|footwear)/i },
  { id: "dietary-supplement", label: "膳食补充剂", terms: /(牛至油|oregano\s*oil|膳食补充剂|营养补充剂|保健品|软胶囊|胶囊|capsules?|softgels?|dietary\s*supplement|supplement)/i },
  { id: "student-backpack", label: "学生双肩背包", terms: /(学生双肩背包|学生书包|双肩背包|书包|上学背包|school\s*backpack|student\s*backpack)/i }
];

function inputText(input: IdentityInput): string {
  return [
    input.productName,
    input.originalProductName,
    input.visibleProductName,
    input.category,
    input.targetAudience,
    input.referenceKeywords,
    input.notes,
    input.briefFocus,
    input.sellingPoints
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function classifyProductIdentity(input: IdentityInput): ProductIdentityResult {
  const core = [input.productName, input.originalProductName, input.visibleProductName, input.category]
    .filter(Boolean)
    .join(" ");
  const supporting = [input.referenceKeywords, input.notes, input.briefFocus, input.sellingPoints]
    .filter(Boolean)
    .join(" ");

  // Product name and selected category outrank pasted historical templates and selling-point text.
  for (const rule of identityRules) {
    if (rule.terms.test(core)) return { id: rule.id, label: rule.label, signals: ["商品名称/类目"] };
  }

  // A concrete product name/category is authoritative even when the current identity library
  // has no dedicated enum for it. Falling through to historical notes or reference keywords
  // can otherwise turn pants into footwear, appliances into trash bags, and so on.
  const meaningfulCore = core
    .replace(/(?:精选商品|未命名商品|商品名称|产品名称|通用商品)/g, "")
    .replace(/[\s:：/_-]+/g, "")
    .trim();
  if (meaningfulCore) {
    return { id: "generic", label: "通用商品", signals: ["商品名称/类目（未映射品类）"] };
  }

  for (const rule of identityRules) {
    if (rule.terms.test(supporting)) return { id: rule.id, label: rule.label, signals: ["参考图关键词/用户内容"] };
  }
  return { id: "generic", label: "通用商品", signals: [] };
}

const forbiddenByIdentity: Partial<Record<ProductIdentityId, RegExp[]>> = {
  "ai-robot": [
    /垃圾袋|垃圾桶|抽绳袋|500只|500袋|破壁机|搅拌机|雨伞|鞋类|鞋子|拖鞋|凉拖|鞋底|鞋口|上脚|穿鞋|鞋柜|脚感|鞋面|鞋垫|鞋带|尺码|鞋型|穿搭/i
  ],
  "blender": [/垃圾袋|垃圾桶|抽绳袋|500只|500袋|鞋类|拖鞋|鞋底|鞋口|雨伞|机器人/i],
  "trash-bag": [/破壁机|搅拌机|豆浆机|鞋类|拖鞋|鞋底|雨伞|机器人/i],
  "footwear": [/垃圾袋|垃圾桶|破壁机|搅拌机|雨伞|机器人/i]
};

const evidenceRules: Partial<Record<ProductIdentityId, Array<{ label: string; terms: RegExp }>>> = {
  "ai-robot": [
    { label: "语言/方言场景", terms: /多语言|方言|语言课堂|语言卡|中文|English|粤语|闽南语/i },
    { label: "语音互动场景", terms: /语音|声波|麦克风|倾听|回应|对话/i },
    { label: "故事/学习场景", terms: /故事|绘本|成语|课本|学习|答疑|问题卡/i },
    { label: "动作/玩法场景", terms: /关节|动作|姿势|游戏板|动作轨迹|玩法/i },
    { label: "联网/续航表达", terms: /联网|云端|WiFi|电池|电量|续航|时间线/i }
  ]
};

function stripRuleLibrary(prompt: string): string {
  // The prompt intentionally contains the rule library as instructions. Audit the product-specific
  // copy and scene directives, not category examples quoted inside the library itself.
  return prompt
    .replace(/生图规则库强制规则：[\s\S]*?(?=当前商品专属执行|商品专属|卖点证明矩阵|主图规划|详情页规划)/i, "")
    .replace(/公共核心规则[\s\S]*?(?=平台规则|语言规则|输出语言|可见展示名)/i, "")
    .replace(/平台规则：[\s\S]*?(?=语言规则|输出语言)/i, "")
    .replace(/语言规则：[\s\S]*?(?=输出语言|可见展示名)/i, "");
}

function sceneSignature(spec: PromptAuditSpec): string {
  const storyboardFields = [
    /产品状态：([^\r\n]+)/,
    /场景与辅助元素：([^\r\n]+)/,
    /构图类型：([^\r\n]+)/,
    /可见证明方式：([^\r\n]+)/,
    /Product state(?:\/action)?:\s*([^\r\n]+)/i,
    /Scene and interaction:\s*([^\r\n]+)/i,
    /Composition:\s*([^\r\n]+)/i,
    /Camera:\s*([^\r\n]+)/i,
    /Visible proof:\s*([^\r\n]+)/i
  ]
    .map((pattern) => spec.prompt.match(pattern)?.[1]?.trim().toLowerCase() || "")
    .filter(Boolean);
  if (storyboardFields.length) {
    return storyboardFields
      .join("|")
      .replace(/[，。；：、,.!?！？\s]+/g, "")
      .slice(0, 240);
  }
  // Copy is the compact, product-specific storyboard contract. The full prompt also embeds
  // shared rules and would make every screen appear to mention every possible scene.
  const text = `${spec.title} ${spec.copy.join(" ")}`.toLowerCase();
  const buckets: Array<[string, RegExp]> = [
    ["language", /语言|方言|课堂|language|dialect/],
    ["voice", /语音|声波|麦克风|对话|voice|sound/],
    ["story", /故事|绘本|成语|story|book/],
    ["learning", /课本|学习|答疑|黑板|learning|school/],
    ["motion", /动作|关节|姿势|游戏|motion|joint|game/],
    ["battery", /电池|电量|续航|时间线|battery|power/],
    ["desktop", /桌面|书桌|摆件|展示架|desktop|shelf/],
    ["family", /孩子|亲子|家庭|家长|child|family/],
    ["network", /联网|云端|wifi|网络|network|cloud/],
    ["detail", /局部|近景|细节|结构|detail|close-up/]
  ];
  const hit = buckets.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return hit.join("+") || text.replace(/\s+/g, " ").slice(0, 100);
}

export function auditTaskIdentity(task: IdentityInput): { ok: boolean; identity: ProductIdentityResult; errors: string[] } {
  const identity = classifyProductIdentity(task);
  const errors: string[] = [];
  if (identity.id === "ai-robot" && /(鞋类|鞋子|拖鞋|凉拖|家居鞋|跑鞋|footwear|sneaker|shoe)/i.test(String(task.category || ""))) {
    errors.push(`类目“${task.category}”与识别到的产品身份“${identity.label}”冲突，已阻止提交。`);
  }
  return { ok: errors.length === 0, identity, errors };
}

export function auditNativePromptSet(
  task: IdentityInput & Pick<ProductTask, "mainImageCount" | "generateDetail">,
  specs: PromptAuditSpec[],
  context: PromptAuditContext = {}
): PromptAuditResult {
  const identity = classifyProductIdentity(task);
  const errors: string[] = [...auditTaskIdentity(task).errors];
  const warnings: string[] = [];
  const forbiddenMatches = new Set<string>();
  const missingEvidence: string[] = [];
  const expectedCount = task.mainImageCount + (task.generateDetail ? 8 : 0);

  if (specs.length !== expectedCount) {
    errors.push(`提示词数量不完整：预期 ${expectedCount} 张，实际生成 ${specs.length} 张。`);
  }
  errors.push(...auditVisibleProductNameEvidence(task.visibleProductName, context.trustedVisualEvidence));
  const forbidden = forbiddenByIdentity[identity.id] ?? [];
  for (const spec of specs) {
    const productSpecificText = `${spec.title} ${spec.copy.join(" ")} ${stripRuleLibrary(spec.prompt)}`;
    for (const pattern of forbidden) {
      const matches = productSpecificText.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)) ?? [];
      for (const match of matches) {
        if (match) forbiddenMatches.add(match);
      }
    }
  }
  if (forbiddenMatches.size) {
    errors.push(`检测到与“${identity.label}”不相容的品类词：${[...forbiddenMatches].join("、")}。`);
  }

  const evidence = evidenceRules[identity.id] ?? [];
  const allProductSpecificText = specs.map((spec) => `${spec.title} ${spec.copy.join(" ")} ${stripRuleLibrary(spec.prompt)}`).join("\n");
  for (const rule of evidence) {
    if (!rule.terms.test(allProductSpecificText)) missingEvidence.push(rule.label);
  }
  if (missingEvidence.length) warnings.push(`未在整套提示词中找到明确证据场景：${missingEvidence.join("、")}。`);

  const signatures = new Map<string, number>();
  for (const spec of specs) {
    const signature = sceneSignature(spec);
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  const duplicateSignatures = [...signatures.entries()].filter(([, count]) => count >= 3).map(([signature, count]) => `${signature} x${count}`);
  if (duplicateSignatures.length) warnings.push(`存在高度相似的场景签名：${duplicateSignatures.join("；")}。`);
  const mainSignatures = new Map<string, number>();
  for (const spec of specs.filter((item) => item.role === "main")) {
    const signature = sceneSignature(spec);
    mainSignatures.set(signature, (mainSignatures.get(signature) ?? 0) + 1);
  }
  const repeatedMainSignatures = [...mainSignatures.entries()]
    .filter(([, count]) => count >= 3)
    .map(([signature, count]) => `${signature} x${count}`);
  if (repeatedMainSignatures.length) {
    errors.push(`主图场景过度重复，至少三张主图使用了同一类构图：${repeatedMainSignatures.join("；")}。`);
  }

  const userText = inputText(task);
  if (!userText) warnings.push("缺少产品身份输入，后续仅能按通用商品规则处理。");
  return {
    ok: errors.length === 0,
    identity,
    expectedCount,
    actualCount: specs.length,
    errors,
    warnings,
    forbiddenMatches: [...forbiddenMatches],
    missingEvidence,
    duplicateSignatures
  };
}

export function auditVisibleProductNameEvidence(visibleName = "", trustedVisualEvidence = ""): string[] {
  const name = String(visibleName || "").trim();
  if (!name || !trustedVisualEvidence.trim()) return [];
  const trusted = positiveProductEvidence(trustedVisualEvidence);
  const errors: string[] = [];
  if (/oregano\s*oil/i.test(name) && !/(牛至油|oregano\s*oil)/i.test(trusted)) {
    errors.push("可见展示名包含 Oregano Oil，但本次商品识图事实没有对应证据，已阻止提交。");
  }
  if (/(capsules?|softgels?)/i.test(name) && /(滴剂|滴管|liquid\s+(?:dietary\s+)?supplement|dropper|pipette)/i.test(trusted) && !/(胶囊|capsules?|softgels?)/i.test(trusted)) {
    errors.push("可见展示名使用胶囊剂型，但本次商品识图事实显示为液体滴剂，已阻止提交。");
  }
  if (/(liquid|dropper)/i.test(name) && /(胶囊|capsules?|softgels?)/i.test(trusted) && !/(滴剂|滴管|liquid|dropper|pipette)/i.test(trusted)) {
    errors.push("可见展示名使用液体滴剂剂型，但本次商品识图事实显示为胶囊剂型，已阻止提交。");
  }
  return errors;
}

function positiveProductEvidence(value: string): string {
  return String(value || "")
    .replace(/\b(?:no|not|without)\s+oregano(?:\s+oil)?\b/gi, "")
    .replace(/(?:没有|未见|不含|并非|不是)\s*牛至油/g, "")
    .replace(/\b(?:no|not|without)\s+(?:capsules?|softgels?|dropper|liquid)\b/gi, "")
    .replace(/(?:没有|未见|不含|并非|不是)\s*(?:胶囊|软胶囊|滴剂|滴管)/g, "");
}

export function formatPromptAuditFailure(result: PromptAuditResult): string {
  return ["生成前提示词审核未通过：", ...result.errors.map((item) => `- ${item}`), result.warnings.length ? `提示：${result.warnings.join("；")}` : ""]
    .filter(Boolean)
    .join("\n");
}
