import fs from "node:fs/promises";
import path from "node:path";

export const generationRulesDirName = "生图规则";
export const generationRuleDecisionFileName = "规则判断.md";
export const legacyGenerationRuleDecisionFileName = "生图规则判断.md";

const fallbackPlatformRule = {
  ruleProfile: "domestic-default",
  ruleName: "默认国内平台",
  ruleFile: "平台规则/默认国内平台.md",
  priority: 0,
  targetPlatform: "国内通用",
};

const fallbackLanguageRule = {
  ruleProfile: "zh-CN",
  ruleName: "简体中文",
  ruleFile: "语言规则/简体中文.md",
  priority: 0,
  outputLanguage: "简体中文",
};

const fallbackCoreRule = {
  ruleProfile: "common-quality-core",
  ruleName: "公共核心规则",
  ruleFile: "公共核心规则.md",
  priority: 0,
};

export async function selectGenerationRule(rootDir, detectionText = "", explicit = {}) {
  const rulesDir = path.join(rootDir, generationRulesDirName);
  const decisionFile = await firstExistingPath([
    path.join(rulesDir, generationRuleDecisionFileName),
    path.join(rulesDir, legacyGenerationRuleDecisionFileName),
  ]);
  const decisionText = decisionFile ? await fs.readFile(decisionFile, "utf8").catch(() => "") : "";
  const decision = parseRuleDecisionMarkdown(decisionText);
  const platformDefault = { ...fallbackPlatformRule, ...decision.defaultPlatformRule };
  const languageDefault = { ...fallbackLanguageRule, ...decision.defaultLanguageRule };
  const coreDefault = { ...fallbackCoreRule, ...decision.defaultCoreRule };
  const platformRule = chooseRule({
    rules: decision.platformRules,
    defaultRule: platformDefault,
    detectionText,
    explicitValue: explicit.targetPlatform,
    kind: "platform",
  });
  const languageRule = chooseRule({
    rules: decision.languageRules,
    defaultRule: languageDefault,
    detectionText,
    explicitValue: explicit.outputLanguage,
    kind: "language",
  });
  return hydrateCombinedRuleSelection({
    rootDir,
    rulesDir,
    decisionFile: decisionFile || path.join(rulesDir, generationRuleDecisionFileName),
    coreRule: coreDefault,
    platformRule,
    languageRule,
    explicit,
  });
}

export function parseRuleDecisionMarkdown(markdown = "") {
  const defaultValues = parseKeyValues(sectionBetween(markdown, "## 默认规则", "## 平台判断规则"));
  const legacyDefaultValues = parseKeyValues(sectionBetween(markdown, "## 默认规则", "## 判断规则"));
  const defaultPlatformRule = normalizeDecisionRule({
    ruleProfile: defaultValues.platformRuleProfile || legacyDefaultValues.ruleProfile,
    ruleName: defaultValues.platformRuleName || legacyDefaultValues.ruleName,
    ruleFile: defaultValues.platformRuleFile || legacyDefaultValues.ruleFile,
    priority: defaultValues.platformPriority ?? legacyDefaultValues.priority,
    targetPlatform: defaultValues.targetPlatform || legacyDefaultValues.targetPlatform,
    ruleVersion: defaultValues.platformRuleVersion || legacyDefaultValues.ruleVersion,
  });
  const defaultLanguageRule = normalizeDecisionRule({
    ruleProfile: defaultValues.languageRuleProfile,
    ruleName: defaultValues.languageRuleName,
    ruleFile: defaultValues.languageRuleFile,
    priority: defaultValues.languagePriority,
    outputLanguage: defaultValues.outputLanguage,
    ruleVersion: defaultValues.languageRuleVersion,
  });
  const defaultCoreRule = normalizeDecisionRule({
    ruleProfile: defaultValues.coreRuleProfile,
    ruleName: defaultValues.coreRuleName,
    ruleFile: defaultValues.coreRuleFile,
    priority: defaultValues.corePriority,
    ruleVersion: defaultValues.coreRuleVersion,
  });
  const platformRules = splitRuleBlocks(sectionBetween(markdown, "## 平台判断规则", "## 语言判断规则"))
    .map((block) => normalizeDecisionRule({
      ruleName: block.title,
      ...parseKeyValues(block.body),
      matchedKeywords: parseList(block.body, "命中关键词"),
      excludedKeywords: parseList(block.body, "排除关键词"),
    }))
    .filter((rule) => rule.ruleProfile && rule.ruleFile);
  const languageRules = splitRuleBlocks(sectionAfter(markdown, "## 语言判断规则"))
    .map((block) => normalizeDecisionRule({
      ruleName: block.title,
      ...parseKeyValues(block.body),
      matchedKeywords: parseList(block.body, "命中关键词"),
      excludedKeywords: parseList(block.body, "排除关键词"),
    }))
    .filter((rule) => rule.ruleProfile && rule.ruleFile);

  if (!platformRules.length) {
    const legacyRules = splitRuleBlocks(sectionAfter(markdown, "## 判断规则"))
      .map((block) => normalizeDecisionRule({
        ruleName: block.title,
        ...parseKeyValues(block.body),
        matchedKeywords: parseList(block.body, "命中关键词"),
        excludedKeywords: parseList(block.body, "排除关键词"),
      }))
      .filter((rule) => rule.ruleProfile && rule.ruleFile);
    platformRules.push(...legacyRules.map((rule) => ({
      ...rule,
      ruleFile: rule.ruleFile.includes("/") ? rule.ruleFile : `平台规则/${rule.ruleFile.replace(/^国外亚马逊平台\.md$/, "Amazon.md")}`,
    })));
  }

  return {
    defaultPlatformRule,
    defaultLanguageRule,
    defaultCoreRule,
    platformRules,
    languageRules,
    // Backward-compatible names for older tests and tooling.
    defaultRule: defaultPlatformRule,
    rules: platformRules,
  };
}

function chooseRule({ rules, defaultRule, detectionText, explicitValue, kind }) {
  const explicit = clean(explicitValue);
  if (explicit) {
    const explicitMatch = rules.find((rule) => explicitMatchesRule(rule, explicit, kind));
    if (explicitMatch) {
      return {
        ...explicitMatch,
        matchedKeywords: [],
        excludedKeywords: [],
        ruleReason: `用户显式选择：${explicit}`,
      };
    }
    if (explicitMatchesRule(defaultRule, explicit, kind)) {
      return {
        ...defaultRule,
        matchedKeywords: [],
        excludedKeywords: [],
        ruleReason: `用户显式选择：${explicit}`,
      };
    }
  }

  const candidates = rules
    .map((rule) => matchDecisionRule(rule, detectionText))
    .filter((match) => match.matchedKeywords.length && !match.excludedKeywords.length)
    .sort((a, b) => b.priority - a.priority);
  return candidates[0] || {
    ...defaultRule,
    matchedKeywords: [],
    excludedKeywords: [],
    ruleReason: "未命中其他规则，使用默认规则。",
  };
}

function explicitMatchesRule(rule, explicitValue, kind) {
  const explicit = normalizeMatchText(explicitValue);
  const ruleText = normalizeMatchText([
    rule.ruleProfile,
    rule.ruleName,
    rule.ruleFile,
    rule.targetPlatform,
    rule.outputLanguage,
    ...(rule.matchedKeywords || []),
  ].filter(Boolean).join(" "));
  if (kind === "platform") {
    if (/amazon|亚马逊/.test(explicit)) return /amazon|亚马逊/.test(ruleText);
    if (/淘宝|天猫|tmall|taobao|国内|通用|中国/.test(explicit)) return /domestic|国内|淘宝|天猫|通用/.test(ruleText);
  }
  if (kind === "language") {
    if (/english|英文|英语/.test(explicit)) return /english|英文|英语/.test(ruleText);
    if (/中文|简体|chinese|zh-cn|zh/.test(explicit)) return /中文|简体|chinese|zh-cn|zh/.test(ruleText);
  }
  return ruleText.includes(explicit);
}

function matchDecisionRule(rule, detectionText) {
  const haystack = normalizeMatchText(detectionText);
  const matchedKeywords = rule.matchedKeywords.filter((keyword) => haystack.includes(normalizeMatchText(keyword)));
  const excludedKeywords = rule.excludedKeywords.filter((keyword) => haystack.includes(normalizeMatchText(keyword)));
  return {
    ...rule,
    matchedKeywords,
    excludedKeywords,
    ruleReason: matchedKeywords.length
      ? `命中关键词：${matchedKeywords.join("、")}${excludedKeywords.length ? `；排除关键词：${excludedKeywords.join("、")}` : ""}`
      : "未命中关键词。",
  };
}

async function hydrateCombinedRuleSelection({ rootDir, rulesDir, decisionFile, coreRule, platformRule, languageRule, explicit }) {
  const hydratedCore = await hydrateRule(rootDir, rulesDir, coreRule, fallbackCoreRule);
  const hydratedPlatform = await hydrateRule(rootDir, rulesDir, platformRule, fallbackPlatformRule);
  const hydratedLanguage = await hydrateRule(rootDir, rulesDir, languageRule, fallbackLanguageRule);
  const targetPlatform = clean(explicit.targetPlatform) || hydratedPlatform.targetPlatform || fallbackPlatformRule.targetPlatform;
  const outputLanguage = canonicalOutputLanguage(clean(explicit.outputLanguage) || hydratedLanguage.outputLanguage || fallbackLanguageRule.outputLanguage);
  const combinedName = `${hydratedCore.ruleName} + ${hydratedPlatform.ruleName} + ${hydratedLanguage.ruleName}`;
  const combinedText = [
    "# 组合生图规则",
    "",
    "## 公共核心规则",
    hydratedCore.ruleText,
    "",
    "## 平台规则",
    hydratedPlatform.ruleText,
    "",
    "## 语言规则",
    hydratedLanguage.ruleText,
  ].join("\n");
  return {
    ruleProfile: `${hydratedCore.ruleProfile}+${hydratedPlatform.ruleProfile}+${hydratedLanguage.ruleProfile}`,
    ruleName: combinedName,
    ruleFile: `${hydratedCore.ruleFile} + ${hydratedPlatform.ruleFile} + ${hydratedLanguage.ruleFile}`,
    rulePath: `${hydratedCore.rulePath} + ${hydratedPlatform.rulePath} + ${hydratedLanguage.rulePath}`,
    ruleVersion: `${hydratedCore.ruleVersion}/${hydratedPlatform.ruleVersion}/${hydratedLanguage.ruleVersion}`,
    targetPlatform,
    outputLanguage,
    priority: hydratedCore.priority + hydratedPlatform.priority + hydratedLanguage.priority,
    matchedKeywords: [...hydratedCore.matchedKeywords, ...hydratedPlatform.matchedKeywords, ...hydratedLanguage.matchedKeywords],
    excludedKeywords: [...hydratedCore.excludedKeywords, ...hydratedPlatform.excludedKeywords, ...hydratedLanguage.excludedKeywords],
    ruleReason: `公共核心规则：${hydratedCore.ruleReason}；平台规则：${hydratedPlatform.ruleReason}；语言规则：${hydratedLanguage.ruleReason}`,
    decisionFile: path.relative(rootDir, decisionFile),
    ruleText: combinedText,
    commonRuleProfile: hydratedCore.ruleProfile,
    commonRuleName: hydratedCore.ruleName,
    commonRuleFile: hydratedCore.ruleFile,
    commonRulePath: hydratedCore.rulePath,
    commonRuleVersion: hydratedCore.ruleVersion,
    commonRuleReason: hydratedCore.ruleReason,
    commonRuleMatchedKeywords: hydratedCore.matchedKeywords,
    commonRuleText: hydratedCore.ruleText,
    platformRuleProfile: hydratedPlatform.ruleProfile,
    platformRuleName: hydratedPlatform.ruleName,
    platformRuleFile: hydratedPlatform.ruleFile,
    platformRulePath: hydratedPlatform.rulePath,
    platformRuleVersion: hydratedPlatform.ruleVersion,
    platformRuleReason: hydratedPlatform.ruleReason,
    platformRuleMatchedKeywords: hydratedPlatform.matchedKeywords,
    platformRuleText: hydratedPlatform.ruleText,
    languageRuleProfile: hydratedLanguage.ruleProfile,
    languageRuleName: hydratedLanguage.ruleName,
    languageRuleFile: hydratedLanguage.ruleFile,
    languageRulePath: hydratedLanguage.rulePath,
    languageRuleVersion: hydratedLanguage.ruleVersion,
    languageRuleReason: hydratedLanguage.ruleReason,
    languageRuleMatchedKeywords: hydratedLanguage.matchedKeywords,
    languageRuleText: hydratedLanguage.ruleText,
  };
}

async function hydrateRule(rootDir, rulesDir, selected, fallback) {
  const rulePath = safeRulePath(rootDir, rulesDir, selected.ruleFile);
  const ruleText = rulePath ? await fs.readFile(rulePath, "utf8").catch(() => "") : "";
  const version = extractField(ruleText, "规则版本") || selected.ruleVersion || "v1";
  return {
    ruleProfile: selected.ruleProfile || fallback.ruleProfile,
    ruleName: selected.ruleName || selected.title || selected.ruleProfile || fallback.ruleName,
    ruleFile: selected.ruleFile || fallback.ruleFile,
    rulePath: rulePath ? path.relative(rootDir, rulePath) : path.join(generationRulesDirName, selected.ruleFile || fallback.ruleFile),
    ruleVersion: version,
    targetPlatform: selected.targetPlatform || fallback.targetPlatform || "",
    outputLanguage: selected.outputLanguage || fallback.outputLanguage || "",
    priority: Number(selected.priority || 0),
    matchedKeywords: selected.matchedKeywords || [],
    excludedKeywords: selected.excludedKeywords || [],
    ruleReason: selected.ruleReason || "使用默认规则。",
    ruleText: ruleText || fallbackRuleText(selected, fallback),
  };
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return "";
}

function sectionBetween(markdown, startMarker, endMarker) {
  const start = markdown.indexOf(startMarker);
  if (start < 0) return "";
  const contentStart = start + startMarker.length;
  const end = markdown.indexOf(endMarker, contentStart);
  return (end >= 0 ? markdown.slice(contentStart, end) : markdown.slice(contentStart)).trim();
}

function sectionAfter(markdown, startMarker) {
  const start = markdown.indexOf(startMarker);
  if (start < 0) return "";
  return markdown.slice(start + startMarker.length).trim();
}

function splitRuleBlocks(markdown) {
  const blocks = [];
  const matches = [...String(markdown || "").matchAll(/^###\s+(.+?)\s*$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    blocks.push({
      title: match[1].trim(),
      body: markdown.slice((match.index || 0) + match[0].length, next?.index ?? markdown.length).trim(),
    });
  }
  return blocks;
}

function parseKeyValues(block) {
  const result = {};
  for (const rawLine of String(block || "").split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*+]\s+/, "");
    const match = line.match(/^([^:：|]{2,24})\s*[:：]\s*(.+)$/);
    if (!match) continue;
    const key = normalizeKey(match[1]);
    const value = match[2].trim();
    if (key === "规则ID") result.ruleProfile = value;
    else if (key === "规则文件") result.ruleFile = value;
    else if (key === "规则名称") result.ruleName = value;
    else if (key === "输出平台") result.targetPlatform = value;
    else if (key === "输出语言") result.outputLanguage = value;
    else if (key === "优先级") result.priority = Number(value) || 0;
    else if (key === "规则版本") result.ruleVersion = value;
    else if (key === "默认平台规则ID" || key === "平台规则ID") result.platformRuleProfile = value;
    else if (key === "默认平台规则文件" || key === "平台规则文件") result.platformRuleFile = value;
    else if (key === "默认平台规则名称" || key === "平台规则名称") result.platformRuleName = value;
    else if (key === "默认语言规则ID" || key === "语言规则ID") result.languageRuleProfile = value;
    else if (key === "默认语言规则文件" || key === "语言规则文件") result.languageRuleFile = value;
    else if (key === "默认语言规则名称" || key === "语言规则名称") result.languageRuleName = value;
    else if (key === "默认公共核心规则ID" || key === "公共核心规则ID") result.coreRuleProfile = value;
    else if (key === "默认公共核心规则文件" || key === "公共核心规则文件") result.coreRuleFile = value;
    else if (key === "默认公共核心规则名称" || key === "公共核心规则名称") result.coreRuleName = value;
  }
  return result;
}

function parseList(block, label) {
  const lines = String(block || "").split(/\r?\n/);
  const items = [];
  let active = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^([^:：]{2,20})\s*[:：]\s*$/);
    if (heading) {
      active = normalizeKey(heading[1]) === label;
      continue;
    }
    if (/^[^:：]{2,20}\s*[:：]/.test(line)) {
      active = false;
      continue;
    }
    if (active) {
      const item = line.replace(/^[-*+]\s+/, "").trim();
      if (item) items.push(item);
    }
  }
  return items;
}

function normalizeDecisionRule(rule) {
  return {
    ruleProfile: clean(rule.ruleProfile),
    ruleName: clean(rule.ruleName),
    ruleFile: clean(rule.ruleFile),
    priority: Number(rule.priority || 0),
    targetPlatform: clean(rule.targetPlatform),
    outputLanguage: canonicalOutputLanguage(rule.outputLanguage),
    ruleVersion: clean(rule.ruleVersion),
    matchedKeywords: Array.isArray(rule.matchedKeywords) ? rule.matchedKeywords.map(clean).filter(Boolean) : [],
    excludedKeywords: Array.isArray(rule.excludedKeywords) ? rule.excludedKeywords.map(clean).filter(Boolean) : [],
  };
}

function safeRulePath(rootDir, rulesDir, ruleFile) {
  const base = path.resolve(rulesDir);
  const resolved = path.resolve(rulesDir, String(ruleFile || ""));
  const relative = path.relative(base, resolved);
  if (!ruleFile || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  const rootRelative = path.relative(path.resolve(rootDir), resolved);
  if (rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) return "";
  return resolved;
}

function canonicalOutputLanguage(value) {
  const cleanValue = clean(value);
  if (/english|英文|英语/i.test(cleanValue)) return "English";
  if (/中文|简体|chinese|zh/i.test(cleanValue)) return "简体中文";
  return cleanValue;
}

function normalizeKey(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function normalizeMatchText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function extractField(markdown, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(markdown || "").match(new RegExp(`^${escaped}\\s*[:：]\\s*(.+)$`, "m"));
  return clean(match?.[1]);
}

function fallbackRuleText(selected, fallback) {
  return [
    `# ${selected.ruleName || fallback.ruleName}`,
    "",
    "规则版本：fallback",
    "",
    "## 强制规则",
    "- 保持当前上传商品主体特征不变。",
    "- 每张图片必须独立场景、独立卖点。",
    "- 文案必须具体绑定商品功能和画面证据，不得使用空泛模板句。",
  ].join("\n");
}

function clean(value) {
  return String(value || "").trim();
}
