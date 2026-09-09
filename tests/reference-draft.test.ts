import test from "node:test";
import assert from "node:assert/strict";

import { referenceDraftScope, referenceDraftSnapshot, restoreReferenceDraft } from "../frontend/src/reference-draft.js";

test("reference drafts are isolated by portal username", () => {
  assert.equal(referenceDraftScope({ username: "haike_1" }), "portal:haike_1");
  assert.equal(referenceDraftScope({ username: "haike_2" }), "portal:haike_2");
  assert.equal(referenceDraftScope(null), "local-workbench");
});

test("reference draft snapshot omits transient object URLs and preserves controls", () => {
  const file = new File(["image"], "umbrella.png", { type: "image/png", lastModified: 123 });
  const [saved] = referenceDraftSnapshot([{
    id: "ref-1",
    file,
    previewUrl: "blob:temporary",
    originalName: "umbrella.png",
    role: "主参考图",
    useForExpansion: false,
  }]);

  assert.equal(saved.file, file);
  assert.equal(saved.originalName, "umbrella.png");
  assert.equal(saved.role, "主参考图");
  assert.equal(saved.useForExpansion, false);
  assert.equal("previewUrl" in saved, false);
});

test("stored blobs are restored as submit-ready files with fresh preview URLs", () => {
  const blob = new Blob(["image"], { type: "image/png" });
  const [restored] = restoreReferenceDraft([{
    id: "ref-1",
    file: blob,
    originalName: "umbrella.png",
    role: "细节图",
    useForExpansion: true,
    type: "image/png",
    lastModified: 123,
  }], () => "blob:restored");

  assert.ok(restored.file instanceof File);
  assert.equal(restored.file.name, "umbrella.png");
  assert.equal(restored.previewUrl, "blob:restored");
  assert.equal(restored.role, "细节图");
  assert.equal(restored.useForExpansion, true);
});
