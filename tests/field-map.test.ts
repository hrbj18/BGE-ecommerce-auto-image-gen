import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAttachments, normalizeText, parseTask } from "../src/field-map.ts";

test("normalizeText handles Feishu rich values", () => {
  assert.equal(normalizeText("  abc  "), "abc");
  assert.equal(normalizeText([{ text: "A" }, { text: "B" }]), "A、B");
  assert.equal(normalizeText({ name: "SKU" }), "SKU");
});

test("normalizeAttachments accepts common token shapes", () => {
  const attachments = normalizeAttachments([{ file_token: "tok", name: "a.jpg", mime_type: "image/jpeg" }]);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].fileToken, "tok");
  assert.equal(attachments[0].name, "a.jpg");
  assert.equal(attachments[0].type, "image/jpeg");
});

test("parseTask validates required fields", () => {
  const task = parseTask({
    recordId: "rec",
    fields: {
      SKU: "SKU001",
      商品名称: "测试商品",
      商品图: [{ file_token: "tok", name: "a.jpg" }]
    }
  });
  assert.equal(task.sku, "SKU001");
  assert.equal(task.productName, "测试商品");
  assert.equal(task.productImages.length, 1);

  assert.throws(
    () =>
      parseTask({
        recordId: "rec",
        fields: {
          SKU: "SKU001"
        }
      }),
    /Missing required field/
  );
});
