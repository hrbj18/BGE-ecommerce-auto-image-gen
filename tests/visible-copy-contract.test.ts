import assert from "node:assert/strict";
import test from "node:test";
import { extractAllowedVisibleCopy } from "../src/openai-image-generator.ts";

test("extracts approved copy from the compact prompt contract with curly quotes", () => {
  const prompt = [
    "VISIBLE COPY CONTRACT",
    "Language: English. All newly added marketing copy must use this language only.",
    "Use only these approved marketing lines: “NAD+ Liquid Dietary Supplement” | “Everyday Dropper Format”",
  ].join("\n");

  assert.deepEqual(extractAllowedVisibleCopy(prompt), [
    "NAD+ Liquid Dietary Supplement",
    "Everyday Dropper Format",
  ]);
});

test("keeps compatibility with straight-quote and legacy exact-copy contracts", () => {
  assert.deepEqual(
    extractAllowedVisibleCopy('Use only these approved marketing lines: "Product Hero" | "Clear Details"'),
    ["Product Hero", "Clear Details"],
  );
  assert.deepEqual(
    extractAllowedVisibleCopy('Visible marketing copy may only use the following exact English text: "Daily Routine", "Liquid Format". The specified text may be used as headline.'),
    ["Daily Routine", "Liquid Format"],
  );
});
