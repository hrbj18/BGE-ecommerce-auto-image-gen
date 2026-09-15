const commonBans = "competitor logos; platform watermarks or UI; QR codes; prices or sales volume; fake certifications, ratings or reviews; unsupported claims or measurements; random or mixed-language marketing copy; clipped text; internal workflow terms";

const profiles = [
  {
    id: "domestic-general",
    public: true,
    label: "国内通用",
    summary: "均衡转化",
    region: "domestic",
    aliases: ["国内通用", "国内", "通用国内", "中国电商", "domestic general"],
    promptName: "Domestic general ecommerce",
    styleIntent: "Premium domestic mobile ecommerce: balanced visual impact, clear benefit hierarchy, medium information density and credible visual proof",
    defaultAudience: "关注实用价值、品质和购买效率的国内移动端电商用户",
    briefNote: "中等信息密度、清楚卖点层级和可信画面证据；既不套用特定平台模板，也不做廉价促销堆叠。",
    generatorStyle: "balanced mobile-first conversion, medium information density, strong product recognition, clear benefit hierarchy and credible visual proof",
    bannedElements: commonBans,
  },
  {
    id: "global-general",
    public: true,
    label: "国外通用",
    summary: "跨境货架",
    region: "global",
    aliases: ["国外通用", "海外通用", "跨境通用", "国际通用", "global general", "overseas general", "cross-border general"],
    promptName: "Global general ecommerce",
    styleIntent: "Premium global ecommerce: product-first clarity, restrained information density, natural lifestyle credibility and market-neutral brand polish",
    defaultAudience: "重视商品清晰度、实际用途和购买信任的跨境电商用户",
    briefNote: "跨境货架通用风格，商品优先、留白克制、生活方式真实，不套用任何单一海外平台徽章或界面。",
    generatorStyle: "market-neutral global ecommerce, product-first clarity, disciplined whitespace, restrained copy and authentic lifestyle proof",
    bannedElements: commonBans,
  },
  {
    id: "taobao-tmall",
    label: "淘宝/天猫",
    summary: "品牌转化",
    region: "domestic",
    aliases: ["淘宝/天猫", "淘宝", "天猫", "Taobao", "Tmall", "taobao tmall"],
    promptName: "Taobao and Tmall",
    styleIntent: "Taobao/Tmall premium brand commerce: strong shelf impact, richer layered storytelling, polished campaign art direction and benefit-led conversion",
    defaultAudience: "在淘宝或天猫浏览、重视卖点完整度与品牌质感的购物用户",
    briefNote: "品牌详情页式层级，允许较丰富的信息组织和局部证明，但每屏只保留一个主购买理由。",
    generatorStyle: "premium Taobao/Tmall campaign hierarchy, rich but controlled visual layers, high shelf impact and polished benefit-led storytelling",
    bannedElements: commonBans,
  },
  {
    id: "jd",
    label: "京东",
    summary: "专业可信",
    region: "domestic",
    aliases: ["京东", "JD", "JD.com", "Jingdong"],
    promptName: "JD.com",
    styleIntent: "JD.com professional retail: orderly specifications, precise product structure, evidence-led benefits and dependable technical credibility",
    defaultAudience: "重视参数秩序、品质证据、配送效率和决策确定性的京东用户",
    briefNote: "专业、清楚、可信，优先用结构细节、功能动作和有依据的参数组织提高决策效率。",
    generatorStyle: "professional JD.com retail clarity, orderly information modules, precise structure close-ups and evidence-led purchase confidence",
    bannedElements: commonBans,
  },
  {
    id: "douyin",
    label: "抖音电商",
    summary: "首屏抓眼",
    region: "domestic",
    aliases: ["抖音电商", "抖音", "Douyin", "Douyin Shop"],
    promptName: "Douyin Ecommerce",
    styleIntent: "Douyin ecommerce: immediate first-glance hook, dynamic product action, concise benefit punch and mobile-native visual rhythm",
    defaultAudience: "快速滑动内容、依赖首屏视觉和演示证据做判断的抖音电商用户",
    briefNote: "首屏必须快速抓眼，用动作、使用前后关系或场景冲突证明卖点，保持短句和强移动端节奏。",
    generatorStyle: "mobile-native Douyin commerce, immediate visual hook, dynamic demonstration, concise benefit punch and energetic but controlled rhythm",
    bannedElements: commonBans,
  },
  {
    id: "xiaohongshu",
    label: "小红书",
    summary: "生活种草",
    region: "domestic",
    aliases: ["小红书", "红书", "Xiaohongshu", "RED", "RedNote"],
    promptName: "Xiaohongshu",
    styleIntent: "Xiaohongshu lifestyle recommendation: natural editorial photography, tasteful lived-in scenes, authentic usage details and soft benefit discovery",
    defaultAudience: "重视真实体验、审美氛围和生活方式参考的小红书用户",
    briefNote: "生活方式种草与自然编辑感优先，让商品在可信日常场景中被发现，避免硬促销和过度棚拍。",
    generatorStyle: "tasteful Xiaohongshu editorial lifestyle, natural daylight, authentic lived-in usage, tactile details and soft recommendation rhythm",
    bannedElements: commonBans,
  },
  {
    id: "amazon",
    label: "Amazon",
    summary: "简洁可信",
    region: "global",
    aliases: ["Amazon", "亚马逊", "Amazon marketplace", "美国站", "英国站", "欧洲站"],
    promptName: "Amazon",
    styleIntent: "Amazon premium marketplace: restrained, credible, conversion-focused, one dominant benefit per frame, disciplined whitespace and no decorative clutter",
    defaultAudience: "重视商品清晰度、实用功能和购买信任的 Amazon shoppers",
    briefNote: "clean marketplace 商品图与 A+ 式证明，构图克制、证据可信，禁止伪造评分、徽章、评论和认证。",
    generatorStyle: "clean Amazon marketplace clarity, feature proof, authentic lifestyle credibility, restrained layout and purchase confidence",
    bannedElements: `${commonBans}; Best Seller or Amazon Choice badges; review stars; coupons`,
  },
  {
    id: "tiktok-shop",
    label: "TikTok Shop",
    summary: "演示节奏",
    region: "global",
    aliases: ["TikTok Shop", "TikTok", "Tik Tok", "tiktokshop"],
    promptName: "TikTok Shop",
    styleIntent: "TikTok Shop social commerce: thumb-stopping first frame, creator-native demonstration, clear before-and-after logic and fast mobile visual rhythm",
    defaultAudience: "依靠短视频式演示、真实使用感和快速卖点理解做判断的 TikTok Shop 用户",
    briefNote: "短视频封面与创作者演示感，强调首秒钩子、手部动作和真实使用证据，但保持成熟商业完成度。",
    generatorStyle: "thumb-stopping TikTok Shop social commerce, creator-native product demonstration, fast mobile rhythm and authentic UGC energy with polished finish",
    bannedElements: commonBans,
  },
  {
    id: "shopee",
    label: "Shopee",
    summary: "高识别转化",
    region: "global",
    aliases: ["Shopee", "虾皮", "Shopee Mall"],
    promptName: "Shopee",
    styleIntent: "Shopee mobile marketplace: high product recognition, clear value communication, compact feature labels and lively conversion-focused composition",
    defaultAudience: "在东南亚移动端货架中快速比较商品价值与功能的 Shopee 用户",
    briefNote: "高识别、高转化、移动端友好，可用适量功能标签和鲜明对比，但禁止标签墙与虚构折扣。",
    generatorStyle: "high-recognition Shopee mobile marketplace, lively but organized composition, compact feature labels and direct value communication",
    bannedElements: commonBans,
  },
  {
    id: "lazada",
    label: "Lazada",
    summary: "品牌商城",
    region: "global",
    aliases: ["Lazada", "来赞达", "Lazada Mall"],
    promptName: "Lazada",
    styleIntent: "Lazada brand mall: polished storefront quality, clean functional sections, confident color blocking and orderly premium retail presentation",
    defaultAudience: "重视品牌商城质感、功能清晰度和可信购物体验的 Lazada 用户",
    briefNote: "品牌商城感和清楚功能分区，使用克制色块建立秩序，避免复制平台界面或水印。",
    generatorStyle: "polished Lazada brand-mall storefront, clean functional zoning, confident restrained color blocking and orderly premium presentation",
    bannedElements: commonBans,
  },
];

export const defaultPlatformStyleId = "domestic-general";
export const platformStyleProfiles = Object.freeze(profiles.map((profile) => Object.freeze({
  ...profile,
  aliases: Object.freeze([...profile.aliases]),
})));

export function listPlatformStyleProfiles() {
  return platformStyleProfiles
    .filter((profile) => profile.public)
    .map(({ id, label, summary, region }) => ({ id, label, summary, region }));
}

export function platformStyleProfile(value, fallback = "") {
  const normalized = normalizeAlias(value);
  const matched = platformStyleProfiles.find((profile) => [profile.id, profile.label, profile.promptName, ...profile.aliases]
    .some((alias) => normalizeAlias(alias) === normalized));
  if (matched || !fallback) return matched;
  return platformStyleProfile(fallback);
}

export function normalizeTargetPlatform(value, fallback = "") {
  return platformStyleProfile(value, fallback)?.label || "";
}

export function requireTargetPlatform(value) {
  const profile = platformStyleProfile(value);
  if (profile?.public) return profile.label;
  const error = new Error(`不支持的目标平台。可选：${listPlatformStyleProfiles().map((item) => item.label).join("、")}`);
  error.statusCode = 400;
  error.code = "TARGET_PLATFORM_INVALID";
  throw error;
}

function normalizeAlias(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/[\s_./]+/g, "-");
}
