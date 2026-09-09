import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultImageResolutionId,
  findImageResolutionProfile,
  imageDimensionsForRole,
  imageResolutionProfileForTask,
  listImageResolutionProfiles,
  resolveImageResolutionProfile,
} from "../src/image-resolution-profiles.mjs";

test("public image resolution profiles expose 720p, 1k and 2k but keep 4k hidden", () => {
  assert.equal(defaultImageResolutionId, "2k");
  assert.deepEqual(listImageResolutionProfiles().map((profile) => profile.id), ["720p", "1k", "2k"]);
  assert.equal(findImageResolutionProfile("4k"), null);
});

test("720p is a downscaled delivery profile backed by the provider 1k request", () => {
  const profile = resolveImageResolutionProfile("720P");
  assert.equal(profile.id, "720p");
  assert.equal(profile.providerResolution, "1k");
  assert.equal(profile.nativeProviderSize, false);
  assert.deepEqual(imageDimensionsForRole(profile, "main"), { width: 720, height: 720 });
  assert.deepEqual(imageDimensionsForRole(profile, "detail"), { width: 720, height: 1280 });
});

test("task resolution wins while old tasks fall back to the configured provider resolution", () => {
  assert.equal(imageResolutionProfileForTask({ imageResolutionId: "1k" }, "2k").id, "1k");
  assert.equal(imageResolutionProfileForTask({}, "1k").id, "1k");
  assert.equal(imageResolutionProfileForTask({}, "4k").id, "4k");
  assert.equal(imageResolutionProfileForTask({ imageResolutionId: "unknown" }, "2k").id, "2k");
});

test("role dimensions support the selectable portrait main ratio", () => {
  const expected = [
    ["720p", 720, 960],
    ["1k", 1024, 1366],
    ["2k", 2048, 2732],
  ] as const;
  for (const [id, width, height] of expected) {
    const profile = resolveImageResolutionProfile(id);
    assert.deepEqual(imageDimensionsForRole(profile, "main", "3:4"), { width, height });
    assert.equal(imageDimensionsForRole(profile, "detail", "9:16").height, profile.detailHeight);
  }
});
