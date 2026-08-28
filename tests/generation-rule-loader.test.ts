import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// @ts-ignore - The local web helper is an ESM script exercised directly by runtime tests.
import { generationRuleDecisionFileName, generationRulesDirName, parseRuleDecisionMarkdown, selectGenerationRule } from "../scripts/generation-rule-loader.mjs";

const decisionMarkdown = `# 生图规则判断

规则版本：v2

## 默认规则

默认公共核心规则ID：common-quality-core
默认公共核心规则名称：公共核心规则
默认公共核心规则文件：公共核心规则.md

默认平台规则ID：domestic-default
默认平台规则名称：默认国内平台
默认平台规则文件：平台规则/默认国内平台.md
输出平台：国内通用

默认语言规则ID：zh-CN
默认语言规则名称：简体中文
默认语言规则文件：语言规则/简体中文.md
输出语言：简体中文

## 平台判断规则

### Amazon
规则ID：amazon
规则名称：Amazon
规则文件：平台规则/Amazon.md
输出平台：Amazon
优先级：100

命中关键词：
- Amazon
- 亚马逊

排除关键词：
- 不走亚马逊

### 默认国内平台
规则ID：domestic-default
规则名称：默认国内平台
规则文件：平台规则/默认国内平台.md
输出平台：国内通用
优先级：10

命中关键词：
- 国内
- 淘宝
- 天猫

排除关键词：
- 不走国内

## 语言判断规则

### English
规则ID：english
规则名称：English
规则文件：语言规则/English.md
输出语言：English
优先级：100

命中关键词：
- English
- 输出语言：English
- 全英文
- 英文文案

排除关键词：
- 不要英文
- 禁止英文

### 简体中文
规则ID：zh-CN
规则名称：简体中文
规则文件：语言规则/简体中文.md
输出语言：简体中文
优先级：20

命中关键词：
- 简体中文
- 中文文案
- 输出中文

排除关键词：
- 不要中文
`;

test("parses decoupled generation rule decision markdown", () => {
  const parsed = parseRuleDecisionMarkdown(decisionMarkdown);
  assert.equal(parsed.defaultPlatformRule.ruleProfile, "domestic-default");
  assert.equal(parsed.defaultLanguageRule.ruleProfile, "zh-CN");
  assert.equal(parsed.defaultCoreRule.ruleProfile, "common-quality-core");
  assert.equal(parsed.platformRules.length, 2);
  assert.equal(parsed.languageRules.length, 2);
  assert.equal(parsed.platformRules[0].ruleProfile, "amazon");
  assert.equal(parsed.languageRules[0].ruleProfile, "english");
});

test("selects domestic plus Chinese defaults with no explicit selection", async () => {
  const root = await makeRuleFixture();
  const selected = await selectGenerationRule(root, "产品名称：晴雨两用折叠伞\n禁用元素：随机英文；错误中文");
  assert.equal(selected.platformRuleProfile, "domestic-default");
  assert.equal(selected.languageRuleProfile, "zh-CN");
  assert.equal(selected.targetPlatform, "国内通用");
  assert.equal(selected.outputLanguage, "简体中文");
  assert.equal(selected.commonRuleProfile, "common-quality-core");
  assert.match(selected.ruleText, /Core quality rule/);
});

test("selects Amazon platform plus English language explicitly", async () => {
  const root = await makeRuleFixture();
  const selected = await selectGenerationRule(root, "产品名称：AI Robot", {
    targetPlatform: "Amazon",
    outputLanguage: "English",
  });
  assert.equal(selected.platformRuleProfile, "amazon");
  assert.equal(selected.languageRuleProfile, "english");
  assert.equal(selected.targetPlatform, "Amazon");
  assert.equal(selected.outputLanguage, "English");
  assert.equal(selected.commonRuleProfile, "common-quality-core");
  assert.match(selected.ruleText, /Core quality rule/);
  assert.match(selected.ruleText, /Amazon-style platform rule/);
  assert.match(selected.ruleText, /English language rule/);
});

test("supports Amazon platform with Chinese language", async () => {
  const root = await makeRuleFixture();
  const selected = await selectGenerationRule(root, "产品名称：豆包AI机器人", {
    targetPlatform: "Amazon",
    outputLanguage: "简体中文",
  });
  assert.equal(selected.platformRuleProfile, "amazon");
  assert.equal(selected.languageRuleProfile, "zh-CN");
  assert.equal(selected.outputLanguage, "简体中文");
});

test("supports domestic platform with English language", async () => {
  const root = await makeRuleFixture();
  const selected = await selectGenerationRule(root, "产品名称：豆包AI机器人", {
    targetPlatform: "国内通用",
    outputLanguage: "English",
  });
  assert.equal(selected.platformRuleProfile, "domestic-default");
  assert.equal(selected.languageRuleProfile, "english");
  assert.equal(selected.targetPlatform, "国内通用");
  assert.equal(selected.outputLanguage, "English");
});

test("does not treat banned random English as English output", async () => {
  const root = await makeRuleFixture();
  const selected = await selectGenerationRule(root, "目标平台：淘宝/天猫\n禁用元素：竞品商标；平台水印；随机英文；错误中文");
  assert.equal(selected.platformRuleProfile, "domestic-default");
  assert.equal(selected.languageRuleProfile, "zh-CN");
  assert.equal(selected.outputLanguage, "简体中文");
});

async function makeRuleFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "generation-rules-"));
  const rulesDir = path.join(root, generationRulesDirName);
  await fs.mkdir(path.join(rulesDir, "平台规则"), { recursive: true });
  await fs.mkdir(path.join(rulesDir, "语言规则"), { recursive: true });
  await fs.writeFile(path.join(rulesDir, generationRuleDecisionFileName), decisionMarkdown, "utf8");
  await fs.writeFile(path.join(rulesDir, "公共核心规则.md"), "# 公共核心规则\n\n规则版本：v9\n\nCore quality rule.", "utf8");
  await fs.writeFile(path.join(rulesDir, "平台规则", "默认国内平台.md"), "# 默认国内平台\n\n规则版本：v2\n\nDomestic platform rule.", "utf8");
  await fs.writeFile(path.join(rulesDir, "平台规则", "Amazon.md"), "# Amazon\n\n规则版本：v2\n\nAmazon-style platform rule.", "utf8");
  await fs.writeFile(path.join(rulesDir, "语言规则", "简体中文.md"), "# 简体中文\n\n规则版本：v2\n\nChinese language rule.", "utf8");
  await fs.writeFile(path.join(rulesDir, "语言规则", "English.md"), "# English\n\n规则版本：v2\n\nEnglish language rule.", "utf8");
  return root;
}
