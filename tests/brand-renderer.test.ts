import test from "node:test";
import assert from "node:assert/strict";
import { wrapText } from "../src/brand-renderer.ts";

test("wrapText limits Chinese copy and adds an ellipsis", () => {
  const lines = wrapText("这是一段非常长的中文商品标题用于验证安全区域不会溢出模板", 8, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /…$/);
});

test("wrapText handles mixed ASCII and Chinese text", () => {
  const lines = wrapText("500ml轻量保温杯", 8, 2);
  assert.ok(lines.length <= 2);
  assert.ok(lines.every((line) => line.length > 0));
});
