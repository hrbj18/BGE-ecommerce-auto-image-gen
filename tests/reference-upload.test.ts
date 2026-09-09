import assert from "node:assert/strict";
import test from "node:test";
import {
  isReferenceImageFile,
  planReferenceFileAddition,
  referenceFileFingerprint,
  referenceUploadFeedback,
} from "../frontend/src/reference-upload.js";

interface TestImage {
  name: string;
  size: number;
  lastModified: number;
  type: string;
}

function image(name: string, overrides: Partial<TestImage> = {}): TestImage {
  return {
    name,
    size: 1024,
    lastModified: 100,
    type: "image/png",
    ...overrides,
  };
}

test("recognizes browser image MIME types and supported image extensions", () => {
  assert.equal(isReferenceImageFile(image("product.bin", { type: "image/png" })), true);
  assert.equal(isReferenceImageFile(image("product.WEBP", { type: "" })), true);
  assert.equal(isReferenceImageFile(image("notes.txt", { type: "text/plain" })), false);
});

test("keeps one or multiple valid images in their incoming order", () => {
  const first = image("first.png");
  const second = image("second.jpg", { type: "image/jpeg", lastModified: 101 });
  const plan = planReferenceFileAddition([], [first, second], 5);

  assert.deepEqual(plan.accepted, [first, second]);
  assert.equal(plan.invalidCount, 0);
  assert.equal(plan.duplicateCount, 0);
  assert.equal(plan.overflowCount, 0);
});

test("rejects non-images without discarding valid images from the same batch", () => {
  const accepted = image("product.png");
  const plan = planReferenceFileAddition([], [image("notes.txt", { type: "text/plain" }), accepted], 5);

  assert.deepEqual(plan.accepted, [accepted]);
  assert.equal(plan.invalidCount, 1);
});

test("skips files duplicated against existing images or inside the incoming batch", () => {
  const existing = image("product.png");
  const duplicateCopy = image("PRODUCT.PNG");
  const newImage = image("detail.png", { lastModified: 102 });
  const plan = planReferenceFileAddition([existing], [duplicateCopy, newImage, newImage], 5);

  assert.deepEqual(plan.accepted, [newImage]);
  assert.equal(plan.duplicateCount, 2);
  assert.equal(referenceFileFingerprint(existing), referenceFileFingerprint(duplicateCopy));
});

test("accepts only the remaining capacity and reports overflow", () => {
  const current = [image("one.png"), image("two.png"), image("three.png")];
  const incoming = [
    image("four.png", { lastModified: 104 }),
    image("five.png", { lastModified: 105 }),
    image("six.png", { lastModified: 106 }),
  ];
  const plan = planReferenceFileAddition(current, incoming, 5);

  assert.deepEqual(plan.accepted, incoming.slice(0, 2));
  assert.equal(plan.overflowCount, 1);
  assert.equal(referenceUploadFeedback(plan), "已添加 2 张参考图；已跳过1 张超出 5 张上限的图片。");
});

test("a full list rejects new unique images and gives a clear limit message", () => {
  const current = Array.from({ length: 5 }, (_, index) => image(`${index}.png`, { lastModified: index }));
  const plan = planReferenceFileAddition(current, [image("new.png", { lastModified: 200 })], 5);

  assert.deepEqual(plan.accepted, []);
  assert.equal(plan.overflowCount, 1);
  assert.equal(referenceUploadFeedback(plan), "最多上传 5 张参考图，未添加新图片。");
});

test("combines invalid, duplicate, and overflow feedback", () => {
  const existing = [image("existing.png")];
  const plan = planReferenceFileAddition(existing, [
    image("notes.txt", { type: "text/plain", lastModified: 1 }),
    image("existing.png"),
    image("new-one.png", { lastModified: 2 }),
    image("new-two.png", { lastModified: 3 }),
  ], 2);

  assert.equal(plan.accepted.length, 1);
  assert.equal(plan.invalidCount, 1);
  assert.equal(plan.duplicateCount, 1);
  assert.equal(plan.overflowCount, 1);
  assert.equal(
    referenceUploadFeedback(plan),
    "已添加 1 张参考图；已跳过1 个非图片文件、1 张重复图片、1 张超出 2 张上限的图片。",
  );
});
