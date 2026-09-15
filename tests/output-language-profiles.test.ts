import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeOutputLanguage,
  outputLanguageDisplayLabel,
  outputLanguageInstruction,
  outputLanguageProfiles,
  outputLanguagePromptName,
  requireOutputLanguage,
  usesEnglishLanguageBaseline,
} from "../src/output-language-profiles.mjs";

const expectedLanguages = [
  "简体中文",
  "English",
  "日本語",
  "한국어",
  "Español",
  "Français",
  "Deutsch",
  "Italiano",
  "Português",
  "العربية",
];

const expectedDisplayLabels = [
  "简体中文/Chinese",
  "英语/English",
  "日语/日本語",
  "韩语/한국어",
  "西班牙语/Español",
  "法语/Français",
  "德语/Deutsch",
  "意大利语/Italiano",
  "葡萄牙语/Português",
  "阿拉伯语/العربية",
];

test("publishes exactly the ten supported output languages", () => {
  assert.deepEqual(outputLanguageProfiles.map((profile) => profile.label), expectedLanguages);
  assert.equal(new Set(outputLanguageProfiles.map((profile) => profile.id)).size, 10);
  assert.deepEqual(outputLanguageProfiles.map((profile) => profile.displayLabel), expectedDisplayLabels);
});

test("formats supported aliases as Chinese and native-language labels", () => {
  assert.equal(outputLanguageDisplayLabel("en-US"), "英语/English");
  assert.equal(outputLanguageDisplayLabel("Arabic"), "阿拉伯语/العربية");
});

test("normalizes native names, common aliases, and locale codes", () => {
  const cases = [
    ["zh-CN", "简体中文"],
    ["英语", "English"],
    ["Japanese", "日本語"],
    ["ko-KR", "한국어"],
    ["Espanol", "Español"],
    ["fr-FR", "Français"],
    ["German", "Deutsch"],
    ["it-IT", "Italiano"],
    ["pt-BR", "Português"],
    ["Arabic", "العربية"],
  ] as const;
  for (const [input, expected] of cases) assert.equal(normalizeOutputLanguage(input), expected);
});

test("rejects an unknown output language with a request error", () => {
  assert.throws(
    () => requireOutputLanguage("Klingon"),
    (error: unknown) => error instanceof Error
      && (error as Error & { statusCode?: number }).statusCode === 400
      && /不支持的输出语言/.test(error.message),
  );
});

test("new languages use the English planning baseline without becoming English output", () => {
  for (const language of expectedLanguages.slice(2)) {
    assert.equal(usesEnglishLanguageBaseline(language), true, language);
    const promptName = outputLanguagePromptName(language);
    const instruction = outputLanguageInstruction(language);
    assert.match(instruction, new RegExp(promptName));
    assert.match(instruction, /Never render the English localization source/);
  }
  assert.equal(usesEnglishLanguageBaseline("简体中文"), false);
});

test("Arabic includes right-to-left typography requirements", () => {
  const instruction = outputLanguageInstruction("العربية");
  assert.match(instruction, /right-to-left/);
  assert.match(instruction, /right-aligned/);
  assert.match(instruction, /letter shaping/);
});
