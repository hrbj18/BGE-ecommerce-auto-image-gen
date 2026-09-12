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

test("public image resolution profiles expose 1k, 2k and 4k but keep 720p submission disabled", () => {
  assert.equal(defaultImageResolutionId, "2k");
  assert.deepEqual(listImageResolutionProfiles().map((profile) => profile.id), ["1k", "2k", "4k"]);
  assert.equal(findImageResolutionProfile("720p"), null);
  assert.equal(findImageResolutionProfile("4K")?.id, "4k");
});

test("720p remains readable for existing task metadata", () => {
  const profile = imageResolutionProfileForTask({ imageResolutionId: "720p" });
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
    ["1k", 1024, 1366],
    ["2k", 2048, 2732],
    ["4k", 4096, 5462],
  ] as const;
  for (const [id, width, height] of expected) {
    const profile = resolveImageResolutionProfile(id);
    assert.deepEqual(imageDimensionsForRole(profile, "main", "3:4"), { width, height });
    assert.equal(imageDimensionsForRole(profile, "detail", "9:16").height, profile.detailHeight);
  }
});
