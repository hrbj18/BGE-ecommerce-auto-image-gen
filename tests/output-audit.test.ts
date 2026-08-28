import assert from "node:assert/strict";
import test from "node:test";
import { isActionableGeneratedVisualAuditFailure, normalizeGeneratedVisualAudit, skippedGeneratedVisualAudit } from "../src/output-audit.ts";

const expected = [
  { role: "main" as const, index: 1, title: "Hero" },
  { role: "main" as const, index: 2, title: "Proof" }
];

test("normalizes a complete passing visual audit", () => {
  const report = normalizeGeneratedVisualAudit({
    items: [
      { role: "main", index: 1, passed: true, identityMatch: true, sellingPointShown: true, noForbiddenObjects: true, sceneDistinct: true, artDirectionMatch: true, copyLanguageCorrect: true },
      { role: "main", index: 2, passed: true, identityMatch: true, sellingPointShown: true, noForbiddenObjects: true, sceneDistinct: true, artDirectionMatch: true, copyLanguageCorrect: true }
    ]
  }, expected);
  assert.equal(report.enabled, true);
  assert.equal(report.passed, true);
  assert.equal(report.items.length, 2);
});

test("missing items fail closed without triggering blind regeneration", () => {
  const report = normalizeGeneratedVisualAudit({
    items: [{ role: "main", index: 1, passed: false, reasons: ["Repeated scene"] }]
  }, expected);
  assert.equal(report.passed, false);
  assert.deepEqual(report.items[0]?.reasons, ["Repeated scene"]);
  assert.deepEqual(report.items[1]?.reasons, ["The visual audit did not return this image."]);
  assert.equal(report.matchedItemCount, 1);
  assert.equal(isActionableGeneratedVisualAuditFailure(report.items[1]!), false);
});

test("normalizes alternate grouped visual audit payloads", () => {
  const report = normalizeGeneratedVisualAudit({
    mainImages: [{ passed: false, identityMatch: true, sellingPointShown: false, noForbiddenObjects: true, sceneDistinct: true, artDirectionMatch: true, copyLanguageCorrect: true, reason: "Selling point is not visually proven." }],
    detailImages: [{ passed: true, identityMatch: true, sellingPointShown: true, noForbiddenObjects: true, sceneDistinct: true, artDirectionMatch: true, copyLanguageCorrect: true }]
  }, [
    { role: "main", index: 1, title: "Hero" },
    { role: "detail", index: 1, title: "Detail" }
  ]);

  assert.equal(report.responseItemCount, 2);
  assert.equal(report.matchedItemCount, 2);
  assert.equal(report.items[0]?.passed, false);
  assert.equal(isActionableGeneratedVisualAuditFailure(report.items[0]!), true);
  assert.equal(report.items[1]?.passed, true);
});

test("unavailable audit does not block generation", () => {
  const report = skippedGeneratedVisualAudit("No vision key configured");
  assert.equal(report.enabled, false);
  assert.equal(report.passed, true);
  assert.deepEqual(report.warnings, ["No vision key configured"]);
});
