const profiles = [
  { id: "zh-CN", label: "简体中文", displayLabel: "简体中文/Chinese", promptName: "Simplified Chinese", aliases: ["中文", "简体", "简体中文", "Chinese", "Simplified Chinese", "zh", "zh-CN"], baseLanguage: "Simplified Chinese", rtl: false },
  { id: "en", label: "English", displayLabel: "英语/English", promptName: "English", aliases: ["English", "英文", "英语", "en", "en-US", "en-GB"], baseLanguage: "English", rtl: false },
  { id: "ja", label: "日本語", displayLabel: "日语/日本語", promptName: "Japanese", aliases: ["日本語", "日语", "日文", "Japanese", "ja", "ja-JP"], baseLanguage: "English", rtl: false },
  { id: "ko", label: "한국어", displayLabel: "韩语/한국어", promptName: "Korean", aliases: ["한국어", "韩语", "韩文", "Korean", "ko", "ko-KR"], baseLanguage: "English", rtl: false },
  { id: "es", label: "Español", displayLabel: "西班牙语/Español", promptName: "Spanish", aliases: ["Español", "Espanol", "西班牙语", "Spanish", "es", "es-ES"], baseLanguage: "English", rtl: false },
  { id: "fr", label: "Français", displayLabel: "法语/Français", promptName: "French", aliases: ["Français", "Francais", "法语", "French", "fr", "fr-FR"], baseLanguage: "English", rtl: false },
  { id: "de", label: "Deutsch", displayLabel: "德语/Deutsch", promptName: "German", aliases: ["Deutsch", "德语", "German", "de", "de-DE"], baseLanguage: "English", rtl: false },
  { id: "it", label: "Italiano", displayLabel: "意大利语/Italiano", promptName: "Italian", aliases: ["Italiano", "意大利语", "Italian", "it", "it-IT"], baseLanguage: "English", rtl: false },
  { id: "pt", label: "Português", displayLabel: "葡萄牙语/Português", promptName: "Portuguese", aliases: ["Português", "Portugues", "葡萄牙语", "Portuguese", "pt", "pt-PT", "pt-BR"], baseLanguage: "English", rtl: false },
  { id: "ar", label: "العربية", displayLabel: "阿拉伯语/العربية", promptName: "Arabic", aliases: ["العربية", "阿拉伯语", "Arabic", "ar", "ar-SA"], baseLanguage: "English", rtl: true },
];

export const outputLanguageProfiles = Object.freeze(profiles.map((profile) => Object.freeze({
  ...profile,
  aliases: Object.freeze([...profile.aliases]),
})));

export function outputLanguageProfile(value, fallback = "") {
  const normalized = normalizeAlias(value);
  const matched = outputLanguageProfiles.find((profile) => [profile.id, profile.label, profile.promptName, ...profile.aliases]
    .some((alias) => normalizeAlias(alias) === normalized));
  if (matched || !fallback) return matched;
  return outputLanguageProfile(fallback);
}

export function normalizeOutputLanguage(value, fallback = "") {
  return outputLanguageProfile(value, fallback)?.label || "";
}

export function outputLanguageDisplayLabel(value, fallback = "简体中文") {
  return outputLanguageProfile(value, fallback)?.displayLabel || "简体中文/Chinese";
}

export function requireOutputLanguage(value) {
  const normalized = normalizeOutputLanguage(value);
  if (normalized) return normalized;
  const error = new Error(`不支持的输出语言。可选：${outputLanguageProfiles.map((profile) => profile.label).join("、")}`);
  error.statusCode = 400;
  throw error;
}

export function outputLanguagePromptName(value, fallback = "简体中文") {
  return outputLanguageProfile(value, fallback)?.promptName || "Simplified Chinese";
}

export function usesEnglishLanguageBaseline(value) {
  return outputLanguageProfile(value, "简体中文")?.baseLanguage === "English";
}

export function isRightToLeftOutputLanguage(value) {
  return Boolean(outputLanguageProfile(value)?.rtl);
}

export function outputLanguageInstruction(value) {
  const profile = outputLanguageProfile(value, "简体中文");
  const direction = profile.rtl
    ? "Use natural right-to-left Arabic typography, right-aligned reading order, and correct Arabic letter shaping."
    : "Use natural native spelling, grammar, punctuation, and ecommerce phrasing for the target market.";
  const localization = profile.baseLanguage === "English" && profile.promptName !== "English"
    ? "Never render the English localization source or mix it with another language."
    : "Do not mix it with another language.";
  return `All newly added visible marketing copy, display names, headlines, subheads, labels, and callouts must be in ${profile.promptName} only. ${direction} ${localization} Original text printed on the physical product or packaging is exempt and must remain unchanged.`;
}

function normalizeAlias(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/[\s_]+/g, "-");
}
