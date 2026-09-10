import test from "node:test";
import assert from "node:assert/strict";

import {
  clampPreviewZoom,
  defaultPreviewFit,
  defaultPreviewMode,
  isCompositePreviewAsset,
  previewModeLabel,
  relatedPreviewAssets,
} from "../frontend/src/preview-viewer.js";

const assets = [
  { id: "main/01.jpg", group: "main" },
  { id: "main/02.jpg", group: "main" },
  { id: "detail/01.jpg", group: "detail" },
  { id: "detail/02.jpg", group: "detail" },
  { id: "overview/main", group: "overview" },
  { id: "overview/detail", group: "overview" },
  { id: "overview/long", group: "overview" },
];

test("overview assets only review their matching source image group", () => {
  assert.deepEqual(relatedPreviewAssets(assets[4], assets).map((asset) => asset.id), ["main/01.jpg", "main/02.jpg"]);
  assert.deepEqual(relatedPreviewAssets(assets[5], assets).map((asset) => asset.id), ["detail/01.jpg", "detail/02.jpg"]);
  assert.deepEqual(relatedPreviewAssets(assets[6], assets).map((asset) => asset.id), ["detail/01.jpg", "detail/02.jpg"]);
  assert.deepEqual(relatedPreviewAssets(assets[0], assets), []);
});

test("standard 5 plus 8 outputs keep their real review counts", () => {
  const standardAssets = [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `main/${index + 1}.jpg`, group: "main" })),
    ...Array.from({ length: 8 }, (_, index) => ({ id: `detail/${index + 1}.jpg`, group: "detail" })),
  ];
  assert.equal(relatedPreviewAssets({ id: "overview/main" }, standardAssets).length, 5);
  assert.equal(relatedPreviewAssets({ id: "overview/detail" }, standardAssets).length, 8);
  assert.equal(relatedPreviewAssets({ id: "overview/long" }, standardAssets).length, 8);
});

test("preview defaults reflect the asset purpose", () => {
  assert.equal(defaultPreviewMode(assets[4]), "overview");
  assert.equal(defaultPreviewMode(assets[5]), "overview");
  assert.equal(defaultPreviewMode(assets[6]), "composite");
  assert.equal(defaultPreviewMode(assets[0]), "single");
  assert.equal(defaultPreviewFit(assets[6]), "width");
  assert.equal(defaultPreviewFit(assets[0]), "window");
  assert.equal(previewModeLabel(assets[6]), "完整长图");
  assert.equal(previewModeLabel(assets[4]), "拼接图");
  assert.equal(isCompositePreviewAsset(assets[4]), true);
  assert.equal(isCompositePreviewAsset(assets[0]), false);
});

test("zoom is clamped to the documented 25 to 300 percent range", () => {
  assert.equal(clampPreviewZoom(0), 0.25);
  assert.equal(clampPreviewZoom(0.5), 0.5);
  assert.equal(clampPreviewZoom(3.5), 3);
  assert.equal(clampPreviewZoom(Number.NaN), 1);
});
