import type { ProductTask, ProductVisualInsight, ReferenceAnalysis } from "./types.ts";
import type { StoryboardFrame, StoryboardPlan } from "./storyboard-planner.ts";

export interface DirectedStoryboardFrame extends StoryboardFrame {
  productPresence: string;
  camera: string;
  props: string;
  visualMetaphor: string;
}

export interface CreativeDirection {
  styleIntent: string;
  palette: string;
  lighting: string;
  material: string;
  typography: string;
  continuity: string;
  variationRules: string[];
}

export interface CreativePlanAudit {
  passed: boolean;
  errors: string[];
  warnings: string[];
  duplicatePairs: string[];
}

export interface CreativePlan {
  source: "model" | "deterministic";
  direction: CreativeDirection;
  frames: DirectedStoryboardFrame[];
  coverage: StoryboardPlan["coverage"];
  audit: CreativePlanAudit;
  warnings: string[];
}

export interface CompileFramePromptInput {
  task: ProductTask;
  insight: ProductVisualInsight;
  direction: CreativeDirection;
  frame: DirectedStoryboardFrame;
  copy: string[];
  title: string;
  aspectRatio: "1:1" | "3:4" | "9:16";
  forbidden: string;
  legacyPrompt?: string;
}

const MAX_FINAL_PROMPT_CHARS = 6_000;

export function sanitizeProductVisualInsight(task: ProductTask, insight: ProductVisualInsight): ProductVisualInsight {
  const keep = (value: string): boolean => !isForeignCategoryLine(value, task);
  const removed = [
    ...insight.productFacts.filter((item) => !keep(item)),
    ...insight.visualSellingPoints.filter((item) => !keep(item)),
    ...insight.promptDirectives.filter((item) => !keep(item))
  ];
  return {
    ...insight,
    productFacts: insight.productFacts.filter(keep),
    visualSellingPoints: insight.visualSellingPoints.filter(keep),
    promptDirectives: insight.promptDirectives.filter(keep),
    warnings: removed.length
      ? [...insight.warnings, `已隔离 ${removed.length} 条与当前商品类目冲突的视觉分析内容。`]
      : insight.warnings
  };
}

export function sanitizeReferenceAnalysisForProduct(task: ProductTask, analysis: ReferenceAnalysis): ReferenceAnalysis {
  const keep = (value: string): boolean => !isForeignCategoryLine(value, task);
  return {
    ...analysis,
    visualPatterns: analysis.visualPatterns.filter(keep),
    sellingPointPatterns: analysis.sellingPointPatterns.filter(keep),
    detailPagePatterns: analysis.detailPagePatterns.filter(keep),
    brandVisualLogic: analysis.brandVisualLogic?.filter(keep),
    designReviewRules: analysis.designReviewRules?.filter(keep)
  };
}

export function buildDeterministicCreativePlan(
  task: ProductTask,
  insight: ProductVisualInsight,
  storyboard: StoryboardPlan
): CreativePlan {
  const direction = buildDirection(task, insight);
  const frames = storyboard.frames.map((frame) => enrichFrame(frame));
  const audit = auditCreativePlan(frames, storyboard.frames.length);
  return {
    source: "deterministic",
    direction,
    frames,
    coverage: storyboard.coverage,
    audit,
    warnings: storyboard.audit.issues
  };
}

export function buildCreativeDirectorRequestPrompt(
  task: ProductTask,
  insight: ProductVisualInsight,
  fallback: CreativePlan
): string {
  const language = outputLanguage(task);
  return [
    "You are a senior ecommerce creative director and storyboard designer.",
    "Return JSON only. Do not use Markdown and do not add fields outside the requested schema.",
    "Your job is to turn the supplied 13-screen base storyboard into thirteen materially different, executable image directions.",
    "Do not change role, index, selling-point focus, product facts, platform, language, aspect ratio or exact visible-copy policy.",
    "Do not invent specifications, materials, certifications, efficacy, prices, ratings, awards or promotions.",
    "For every frame, make the selling point visible through a concrete action, state, structure, close-up, comparison, environment or visual metaphor. Text alone is not evidence.",
    "Vary product state, camera distance, composition, scene, props and proof method across adjacent frames. The product may be a supporting element or absent only when an evidence-led frame proves the point better.",
    "Premium does not mean adding decoration. Use disciplined hierarchy, intentional negative space, accurate material rendering and one dominant visual idea per frame.",
    `Product name: ${task.productName || "not provided"}`,
    `Visible display name: ${task.visibleProductName || task.productName || "not provided"}`,
    `Platform: ${task.targetPlatform || "default domestic"}`,
    `Visible-copy language: ${language}`,
    `Audience: ${task.targetAudience || "infer conservatively from product facts"}`,
    `Category: ${task.category || "infer conservatively from product facts"}`,
    `User selling points: ${task.sellingPoints || task.briefFocus || "not provided"}`,
    `Confirmed specifications: ${task.specs || "none; do not invent"}`,
    `Product facts: ${insight.productFacts.join(" | ") || "use reference images as source of truth"}`,
    "Current art direction:",
    JSON.stringify(fallback.direction),
    "Base frames:",
    JSON.stringify(fallback.frames.map((frame) => ({
      role: frame.role,
      index: frame.index,
      focus: frame.focus,
      productState: frame.productState,
      scene: frame.scene,
      layout: frame.layout,
      proof: frame.proof,
      avoidRepeat: frame.avoidRepeat,
      visualTreatment: frame.visualTreatment,
      productPresence: frame.productPresence,
      camera: frame.camera,
      props: frame.props,
      visualMetaphor: frame.visualMetaphor
    }))),
    "Return this JSON schema:",
    JSON.stringify({
      direction: {
        styleIntent: "string",
        palette: "string",
        lighting: "string",
        material: "string",
        typography: "string",
        continuity: "string",
        variationRules: ["string"]
      },
      frames: [{
        role: "main or detail",
        index: 1,
        productState: "specific product form, pose or action",
        productPresence: "hero/supporting/evidence-only plus approximate visual share",
        scene: "specific executable environment and interaction",
        layout: "composition and hierarchy",
        camera: "shot distance, angle, lens feel and depth",
        props: "only props that prove the selling point",
        visualMetaphor: "specific visual device or none",
        visualTreatment: "lighting, material and finish",
        proof: "what visible pixels prove the selling point",
        avoidRepeat: "specific differences from adjacent screens"
      }]
    }),
    "Return exactly one frame for every supplied role/index pair."
  ].join("\n");
}

export function normalizeCreativeDirectorResult(value: unknown, fallback: CreativePlan): CreativePlan {
  const root = asObject(value);
  const rawDirection = asObject(root.direction);
  const direction: CreativeDirection = {
    styleIntent: readString(rawDirection.styleIntent, fallback.direction.styleIntent),
    palette: readString(rawDirection.palette, fallback.direction.palette),
    lighting: readString(rawDirection.lighting, fallback.direction.lighting),
    material: readString(rawDirection.material, fallback.direction.material),
    typography: readString(rawDirection.typography, fallback.direction.typography),
    continuity: readString(rawDirection.continuity, fallback.direction.continuity),
    variationRules: readStringArray(rawDirection.variationRules, fallback.direction.variationRules).slice(0, 8)
  };
  const rawFrames = Array.isArray(root.frames) ? root.frames.map(asObject) : [];
  const byKey = new Map(rawFrames.map((frame) => [`${frame.role}:${Number(frame.index)}`, frame]));
  const frames = fallback.frames.map((base) => {
    const raw = byKey.get(`${base.role}:${base.index}`);
    if (!raw) return base;
    return {
      ...base,
      // Focus is intentionally immutable: it contains the user's explicit selling-point assignment.
      productState: readString(raw.productState, base.productState),
      productPresence: readString(raw.productPresence, base.productPresence),
      scene: readString(raw.scene, base.scene),
      layout: readString(raw.layout, base.layout),
      camera: readString(raw.camera, base.camera),
      props: readString(raw.props, base.props),
      visualMetaphor: readString(raw.visualMetaphor, base.visualMetaphor),
      visualTreatment: readString(raw.visualTreatment, base.visualTreatment || fallback.direction.lighting),
      proof: readString(raw.proof, base.proof),
      avoidRepeat: readString(raw.avoidRepeat, base.avoidRepeat)
    } satisfies DirectedStoryboardFrame;
  });
  const audit = auditCreativePlan(frames, fallback.frames.length);
  return {
    source: "model",
    direction,
    frames,
    coverage: fallback.coverage,
    audit,
    warnings: audit.passed ? [] : ["创意导演结果未通过完整审核，缺失字段已使用确定性分镜补齐。"]
  };
}

export function auditCreativePlan(frames: DirectedStoryboardFrame[], expectedCount: number): CreativePlanAudit {
  const errors: string[] = [];
  const warnings: string[] = [];
  const duplicatePairs: string[] = [];
  if (frames.length !== expectedCount) errors.push(`创意分镜数量错误：预期 ${expectedCount}，实际 ${frames.length}。`);
  const keys = new Set<string>();
  for (const frame of frames) {
    const key = `${frame.role}:${frame.index}`;
    if (keys.has(key)) errors.push(`创意分镜编号重复：${key}。`);
    keys.add(key);
    const required = [frame.focus, frame.productState, frame.productPresence, frame.scene, frame.layout, frame.camera, frame.proof, frame.avoidRepeat];
    if (required.some((value) => !value.trim())) errors.push(`${key} 缺少可执行创意字段。`);
    if (!hasConcreteProof(frame)) warnings.push(`${key} 的视觉证据仍偏抽象，需要生成后重点审核。`);
  }
  for (let left = 0; left < frames.length; left += 1) {
    for (let right = left + 1; right < frames.length; right += 1) {
      const previous = frames[left];
      const current = frames[right];
    const sameState = similarityKey(previous.productState) === similarityKey(current.productState);
    const sameLayout = similarityKey(previous.layout) === similarityKey(current.layout);
    const sameScene = similarityKey(previous.scene) === similarityKey(current.scene);
    if ((sameState && sameLayout) || (sameScene && sameLayout)) {
      duplicatePairs.push(`${previous.role}:${previous.index} ↔ ${current.role}:${current.index}`);
    }
    }
  }
  if (duplicatePairs.length) errors.push(`分镜之间缺少实质变化：${duplicatePairs.join("；")}。`);
  return { passed: errors.length === 0, errors, warnings, duplicatePairs };
}

export function compileDirectedFramePrompt(input: CompileFramePromptInput): string {
  const { task, insight, direction, frame, copy, title, aspectRatio, forbidden, legacyPrompt } = input;
  const language = outputLanguage(task);
  const exactCopy = copy.map((line) => line.trim()).filter(Boolean).slice(0, 4);
  // Specifications are validated and localized by the existing copy planner. Keeping a stale
  // "需求规格" fallback fact here can reintroduce a previous product category into every frame.
  const visualFacts = insight.productFacts.filter((fact) => !/^需求规格[：:]/.test(fact.trim()));
  const requiredHead = [
    `CURRENT FRAME MISSION (${frame.role.toUpperCase()} ${frame.index} / ${title}): Prove “${compact(frame.focus, 260)}” through visible imagery, not text alone.`,
    [
      "FRAME EXECUTION",
      `Product presence: ${compact(frame.productPresence, 280)}`,
      `Product state/action: ${compact(frame.productState, 420)}`,
      `Scene and interaction: ${compact(frame.scene, 500)}`,
      `Composition: ${compact(frame.layout, 420)}`,
      `Camera: ${compact(frame.camera, 320)}`,
      `Supporting props: ${compact(frame.props, 320)}`,
      `Visual metaphor: ${compact(frame.visualMetaphor, 260)}`,
      `Lighting and finish: ${compact(frame.visualTreatment || direction.lighting, 360)}`,
      `Visible proof: ${compact(frame.proof, 500)}`,
      `Difference from adjacent frames: ${compact(frame.avoidRepeat, 420)}`
    ].join("\n")
  ].join("\n\n");
  const optionalSections = [
    [
      "PRODUCT SOURCE OF TRUTH",
      `Original product name: ${task.originalProductName || task.productName}`,
      `Visible display name: ${task.visibleProductName || task.productName}`,
      `Visual analysis source: ${insight.source}`,
      `Visual analysis summary: ${compact(insight.summary, 360)}`,
      ...visualFacts.slice(0, 8).map((fact) => `- ${compact(fact, 220)}`),
      ...(insight.visualSellingPoints.length ? [`Visual selling-point candidates: ${insight.visualSellingPoints.slice(0, 6).map((item) => compact(item, 140)).join(" | ")}`] : []),
      ...insight.promptDirectives.slice(0, 4).map((directive) => `Visual-analysis directive: ${compact(directive, 220)}`),
      "The uploaded product images override any conflicting template or example. Preserve shape, color, proportions, material feel, packaging/body text, logo, labels, pattern, accessories and distinctive details."
    ].join("\n"),
    [
      "SET ART DIRECTION",
      `Platform intent: ${direction.styleIntent}`,
      `Palette: ${direction.palette}`,
      `Lighting: ${direction.lighting}`,
      `Material rendering: ${direction.material}`,
      `Typography: ${direction.typography}`,
      `Continuity: ${direction.continuity}`,
      ...direction.variationRules.slice(0, 5).map((rule) => `- ${compact(rule, 220)}`)
    ].join("\n"),
    extractLegacySpecifics(legacyPrompt, task)
  ];
  const requiredTail = [
    [
      "VISIBLE COPY CONTRACT",
      `Language: ${language}. All newly added marketing copy must use this language only. Original text printed on the physical product or packaging is exempt and must remain unchanged.`,
      exactCopy.length ? `Use only these approved marketing lines: ${exactCopy.map((line) => `“${line}”`).join(" | ")}` : "Do not add marketing copy beyond the product's original printed text.",
      "Use a mature ecommerce hierarchy with one headline and at most two short supporting lines. Do not render internal instructions."
    ].join("\n"),
    [
      "CANVAS AND FINAL CHECK",
      `Canvas: ${aspectRatio}, 2K, one complete ecommerce image.`,
      "One dominant visual idea. Supporting elements must prove the selling point and must not compete with it.",
      `Forbidden: ${compact(forbidden || task.bannedElements || "watermarks, QR codes, prices, fake certifications, unsupported claims and unrelated products", 700)}`,
      "Do not invent measurements, efficacy, materials, certifications, ratings, awards, price, sales volume or promotions.",
      "Return the finished image only."
    ].join("\n")
  ].join("\n\n");
  return composePromptWithinBudget(requiredHead, optionalSections, requiredTail, MAX_FINAL_PROMPT_CHARS);
}

export function frameAuditSummary(frame: DirectedStoryboardFrame): string {
  return [
    `selling point: ${frame.focus}`,
    `product presence: ${frame.productPresence}`,
    `product state: ${frame.productState}`,
    `scene: ${frame.scene}`,
    `composition/camera: ${frame.layout}; ${frame.camera}`,
    `visual proof: ${frame.proof}`,
    `must differ: ${frame.avoidRepeat}`
  ].join("\n");
}

function buildDirection(task: ProductTask, insight: ProductVisualInsight): CreativeDirection {
  const amazon = /amazon|亚马逊/i.test(task.targetPlatform || "");
  const facts = insight.productFacts.join(" ");
  const tech = /机器人|耳机|数码|智能|AI|电子|科技|robot|headphone|earbud/i.test(`${task.productName} ${task.category} ${facts}`);
  return {
    styleIntent: amazon
      ? "Amazon premium marketplace: restrained, credible, conversion-focused, one dominant benefit per frame, disciplined whitespace and no decorative clutter"
      : "Premium domestic mobile ecommerce: richer visual evidence and stronger benefit hierarchy, while keeping one dominant idea per frame",
    palette: tech
      ? "neutral base with product-derived accent colors; controlled cool highlights and one restrained warm contrast"
      : "neutral daylight base with colors sampled from the real product; supporting colors must not overpower the product",
    lighting: tech
      ? "precise studio key light, controlled rim light and realistic reflections; lifestyle frames use believable environmental light"
      : "soft directional commercial light with realistic contact shadows, dimensional materials and clean highlights",
    material: "render the real product material accurately; preserve texture, gloss level, seams, edges, printed labels and construction details",
    typography: amazon
      ? "concise editorial English/selected-language hierarchy, strong alignment, generous spacing and no poster-like badges"
      : "clear mobile-commerce hierarchy, concise benefit copy, controlled callouts and no cheap promotional stickers",
    continuity: "keep product identity, color science, type family and finishing quality consistent while changing product state, scene, camera and proof method",
    variationRules: [
      "Adjacent frames must not reuse both the same product state and the same composition.",
      "At least one frame should use human interaction when it is truthful and useful for scale or function.",
      "At least one frame should use a macro, structure or evidence-led composition instead of a full product hero.",
      "Do not keep the product in the same central upright pose across the set.",
      "A visual metaphor is allowed only when it clarifies a real selling point and cannot be mistaken for an unsupported specification."
    ]
  };
}

function enrichFrame(frame: StoryboardFrame): DirectedStoryboardFrame {
  const evidenceLed = /不要求完整|小型|辅助主体|证据|信息图|局部|结构|放大|macro|diagram/i.test(`${frame.productState} ${frame.layout}`);
  const productPresence = evidenceLed
    ? "supporting or evidence-led presence, approximately 15%-45% of the frame; the selling-point evidence is the largest element"
    : frame.role === "main" && frame.index === 1
      ? "hero presence, approximately 55%-75% of the frame, clearly identifiable at first glance"
      : "clear primary or co-primary presence, approximately 35%-65% of the frame, sized according to the proof action";
  return {
    ...frame,
    productPresence,
    camera: inferCamera(frame),
    props: inferProps(frame.scene),
    visualMetaphor: inferVisualMetaphor(frame)
  };
}

function inferCamera(frame: StoryboardFrame): string {
  const text = `${frame.productState} ${frame.layout} ${frame.proof}`;
  if (/局部|放大|细节|纹理|接口|macro|close-up/i.test(text)) return "macro or tight close-up, shallow controlled depth of field, camera aligned to the feature being proved";
  if (/人物|孩子|家庭|场景|互动|穿着|使用/i.test(text)) return "environmental medium shot with believable human scale, slight three-quarter angle and clear foreground-to-background separation";
  if (/多角度|宫格|结构板|拆解|信息图/i.test(text)) return "orthographic or lightly elevated technical view with consistent scale across panels";
  if (frame.role === "main" && frame.index === 1) return "premium three-quarter hero view at product eye level, crisp silhouette and controlled depth";
  return "distinct three-quarter or top-down commercial view chosen to make the proof action immediately readable";
}

function inferProps(scene: string): string {
  const cleaned = scene.replace(/成为大视觉元素|占据画面主要区域|组成大视觉主体/g, "").trim();
  return cleaned || "only category-relevant props that establish scale or prove the selling point";
}

function inferVisualMetaphor(frame: StoryboardFrame): string {
  const text = `${frame.focus} ${frame.scene} ${frame.proof}`;
  if (/语言|方言|翻译|language/i.test(text)) return "language cards, conversational paths or translation relationships as the dominant evidence";
  if (/续航|电池|电量|battery/i.test(text)) return "energy arc or day-to-night timeline without unverified numbers";
  if (/防水|防雨|waterproof/i.test(text)) return "controlled water paths and dry-zone contrast, without fake certification marks";
  if (/容量|收纳|装载|capacity|storage/i.test(text)) return "organized before/after or exploded item arrangement that makes capacity visible";
  if (/声音|降噪|声波|audio|noise/i.test(text)) return "controlled sound-wave field or quiet-zone contrast tied to the actual product";
  if (/轻便|重量|便携|lightweight|portable/i.test(text)) return "single-hand scale, carry motion or compact storage relationship; no invented weight value";
  return "none; rely on a real action, product state, structural close-up or environment as evidence";
}

function hasConcreteProof(frame: DirectedStoryboardFrame): boolean {
  const text = `${frame.proof} ${frame.scene} ${frame.productState} ${frame.visualMetaphor}`;
  return /动作|手|人物|孩子|近景|局部|结构|放大|对比|前后|时间线|声波|语言卡|关系|多角度|纹理|开合|收纳|装载|穿着|使用|action|close-up|macro|comparison|timeline|diagram|interaction/i.test(text);
}

function similarityKey(value: string): string {
  return value.toLowerCase().replace(/[\s，。；：、,.!?！？()（）%\-_/]/g, "").slice(0, 80);
}

function outputLanguage(task: ProductTask): string {
  return /english|英文|英语/i.test(task.outputLanguage || "") ? "English" : "Simplified Chinese";
}

function composePromptWithinBudget(requiredHead: string, optionalSections: string[], requiredTail: string, maxChars: number): string {
  const separator = "\n\n";
  const mandatory = `${requiredHead}${separator}${requiredTail}`;
  if (mandatory.length > maxChars) {
    const tailBudget = Math.min(requiredTail.length, Math.max(1_200, Math.floor(maxChars * 0.34)));
    const safeTail = fitCompleteLines(requiredTail, tailBudget, true);
    const headBudget = Math.max(600, maxChars - safeTail.length - separator.length);
    return `${fitCompleteLines(requiredHead, headBudget, false)}${separator}${safeTail}`.slice(0, maxChars).trimEnd();
  }

  const accepted: string[] = [];
  let remaining = maxChars - mandatory.length - separator.length;
  for (const section of optionalSections.filter(Boolean)) {
    if (remaining <= 80) break;
    const fitted = section.length <= remaining ? section : fitCompleteLines(section, remaining, false);
    if (!fitted) continue;
    accepted.push(fitted);
    remaining -= fitted.length + separator.length;
  }
  return [requiredHead, ...accepted, requiredTail].filter(Boolean).join(separator);
}

function fitCompleteLines(value: string, maxChars: number, keepEnd: boolean): string {
  if (value.length <= maxChars) return value;
  const lines = value.split(/\r?\n/).filter(Boolean);
  const selected: string[] = [];
  const ordered = keepEnd ? [...lines].reverse() : lines;
  let length = 0;
  for (const line of ordered) {
    const available = maxChars - length - (selected.length ? 1 : 0);
    if (available <= 0) break;
    const fitted = line.length <= available ? line : compact(line, available);
    if (!fitted) break;
    selected.push(fitted);
    length += fitted.length + (selected.length > 1 ? 1 : 0);
    if (fitted.length < line.length) break;
  }
  return (keepEnd ? selected.reverse() : selected).join("\n").trim();
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function extractLegacySpecifics(value: string | undefined, task: ProductTask): string {
  if (!value) return "";
  const useful = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => sanitizeLegacyLine(line))
    .filter((line) => line.length >= 8 && line.length <= 700)
    .filter((line) => !isForeignCategoryLine(line, task))
    .filter((line) => /重点|本屏|画面|构图|动作|近景|细节|场景|禁止|不得|不能|保持|当前商品图|产品占|物理逻辑|证明|打开|展开|安装|穿着|模特|材质|标签|把手|杯盖|肩带|腰头|抽绳|关节|屏幕|电池|时间线/i.test(line))
    .filter((line) => !/全案视觉总控|商品视觉分析层|品牌化设计逻辑|设计审核标准|高级文字版式总控|营销文案只允许出现以下指定文字|English visible-copy override|Visible marketing copy may only/.test(line));
  const deduped: string[] = [];
  const seen = new Set<string>();
  const add = (line: string): void => {
    const key = line.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(line);
  };
  // Preserve compact category-level physical logic before selecting the current screen tail.
  for (const line of useful.filter((item) => /重点|物理逻辑|商品锁定|当前商品图里的|不得复用旧商品/i.test(item))) {
    add(line);
    if (deduped.join("\n").length >= 900) break;
  }
  // Screen-specific instructions are normally assembled near the end of the legacy prompt.
  for (const line of useful.reverse()) {
    add(line);
    if (deduped.join("\n").length >= 2_000) break;
  }
  if (!deduped.length) return "";
  return `CATEGORY-SPECIFIC SAFETY AND PHYSICAL LOGIC\n${deduped.join("\n")}`;
}

function sanitizeLegacyLine(value: string): string {
  return value
    .replace(/开口\/盖子\/肩带\/瓶盖\/配件等可见部件/g, "全部真实可见部件")
    .replace(/瓶身\/杯身\/鞋身\/吊牌文字/g, "商品表面文字")
    .replace(/[；;]?\s*核心利益点[：:].*$/i, "")
    .replace(/[；;]?\s*用户特殊要求[：:].*$/i, "")
    .trim();
}

function isForeignCategoryLine(line: string, task: ProductTask): boolean {
  const identity = `${task.productName} ${task.originalProductName || ""} ${task.category || ""}`.toLowerCase();
  const exclusiveGroups: Array<{ belongs: RegExp; terms: RegExp }> = [
    { belongs: /鞋|shoe|sneaker|slipper/, terms: /脚长|鞋底|鞋口|鞋面|鞋型|上脚|鞋码|宽口好穿/ },
    { belongs: /垃圾袋|trash bag|garbage bag/, terms: /垃圾袋|垃圾桶|卷装堆叠|抽绳收口|套入桶|只囤袋装/ },
    { belongs: /机器人|robot/, terms: /机器人关节|表情屏|语言卡|方言互动|联网智能聊天/ },
    { belongs: /杯|水壶|bottle|tumbler|cup/, terms: /杯盖|杯口|杯身|饮口|温显屏幕|保温时长/ },
    { belongs: /篮筐|车篮|basket/, terms: /车把安装|防水罩|篮筐固定|通勤买菜取放/ },
    { belongs: /起重|吊装|lifter|industrial/, terms: /永磁起重|磁吸底座|钢板吊装|U 型吊环|PML\/1000KGF/ },
    { belongs: /毛巾|抹布|towel/, terms: /绒毛纹理|水槽冲洗|擦拭后清爽|挂放收纳/ },
    { belongs: /护肤|面霜|保湿霜|skincare|cream/, terms: /膏体质地|上脸|早晚护肤|梳妆台/ },
    { belongs: /裤|服装|内衣|胸罩|文胸|apparel|clothing|trouser|pants|bra/, terms: /居家走动更轻松|宽松版型|垂顺裤型|垂感面料|腰头抽绳|裤腿/ }
  ];
  if (exclusiveGroups.some((group) => group.terms.test(line) && !group.belongs.test(identity))) return true;
  const rules: Array<{ current: RegExp; foreign: RegExp }> = [
    { current: /机器人|robot/, foreign: /垃圾袋|垃圾桶|鞋底|鞋口|脚长|杯盖|杯身|裤腿|腰头|篮筐/ },
    { current: /裤|服装|内衣|胸罩|文胸|apparel|clothing|trouser|pants|bra/, foreign: /脚长|鞋底|鞋口|垃圾袋|垃圾桶|杯盖|瓶盖|篮筐|机器人关节|空气净化|净化器|母婴|尿布|永磁起重/ },
    { current: /杯|水壶|bottle|tumbler|cup/, foreign: /鞋底|鞋口|脚长|垃圾袋|垃圾桶|裤腿|腰头|篮筐/ },
    { current: /垃圾袋|trash bag|garbage bag/, foreign: /鞋底|鞋口|脚长|杯盖|裤腿|腰头|篮筐|机器人关节/ },
    { current: /篮筐|车篮|basket/, foreign: /垃圾袋|垃圾桶|鞋底|鞋口|脚长|杯盖|裤腿|腰头|机器人关节/ },
    { current: /鞋|shoe|sneaker|slipper/, foreign: /垃圾袋|垃圾桶|杯盖|裤腿|腰头|篮筐|机器人关节/ },
    { current: /耳机|headphone|earbud/, foreign: /垃圾袋|垃圾桶|鞋底|鞋口|脚长|杯盖|裤腿|腰头|篮筐/ },
    { current: /起重|吊装|lifter|industrial/, foreign: /脚长|鞋底|鞋口|鞋面|鞋型|上脚|鞋码|宽口好穿|垃圾袋|垃圾桶|杯盖|裤腿|腰头|机器人关节/ }
  ];
  const rule = rules.find((candidate) => candidate.current.test(identity));
  return Boolean(rule?.foreign.test(line));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? compact(value, 900) : fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const result = value.map((item) => typeof item === "string" ? compact(item, 320) : "").filter(Boolean);
  return result.length ? result : fallback;
}
