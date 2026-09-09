import assert from "node:assert/strict";
import test from "node:test";
import {
  aspectRatioForRole,
  defaultImageAspectRatioProfileId,
  findImageAspectRatioProfile,
  imageAspectRatioProfileForTask,
  listImageAspectRatioProfiles,
  resolveImageAspectRatioProfile,
} from "../src/image-aspect-ratio-profiles.mjs";

test("public image aspect ratio profiles are controlled and default to ecommerce standard", () => {
  const profiles = listImageAspectRatioProfiles();
  assert.deepEqual(profiles.map((profile) => profile.id), ["ecommerce-standard", "portrait-main"]);
  assert.equal(defaultImageAspectRatioProfileId, "ecommerce-standard");
  assert.equal(resolveImageAspectRatioProfile(undefined).id, "ecommerce-standard");
  assert.equal(findImageAspectRatioProfile("unknown"), null);
});

test("aspect ratio profiles map main and detail roles independently", () => {
  const portrait = resolveImageAspectRatioProfile("portrait-main");
  assert.equal(aspectRatioForRole(portrait, "main"), "3:4");
  assert.equal(aspectRatioForRole(portrait, "detail"), "9:16");
});

test("historical tasks recover a known ratio and otherwise keep the legacy default", () => {
  assert.equal(imageAspectRatioProfileForTask({ suiteRatio: "主图 3:4 / 详情页 9:16" }).id, "portrait-main");
  assert.equal(imageAspectRatioProfileForTask({ suiteRatio: "主图 1:1 / 详情页 9:16" }).id, "ecommerce-standard");
  assert.equal(imageAspectRatioProfileForTask({ imageAspectRatioProfileId: "portrait-main" }).id, "portrait-main");
});
