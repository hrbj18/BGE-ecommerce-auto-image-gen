import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultGenerationProfileId,
  detailImageCountForTask,
  findGenerationProfile,
  listGenerationProfiles,
  overviewFilename,
  resolveGenerationProfile,
} from "../src/generation-profiles.mjs";

test("generation profiles keep the standard suite as the legacy-compatible default", () => {
  assert.equal(defaultGenerationProfileId, "standard-5-8");
  assert.deepEqual(listGenerationProfiles().map((profile) => profile.id), [
    "standard-5-8",
    "compact-1-2",
    "compact-2-3",
    "compact-3-4",
  ]);
  assert.deepEqual(resolveGenerationProfile("").id, "standard-5-8");
  assert.equal(findGenerationProfile("not-a-profile"), null);
});

test("each registered compact profile derives its exact counts and overview names", () => {
  for (const expected of [
    { id: "compact-1-2", mainImageCount: 1, detailImageCount: 2 },
    { id: "compact-2-3", mainImageCount: 2, detailImageCount: 3 },
    { id: "compact-3-4", mainImageCount: 3, detailImageCount: 4 },
  ]) {
    const profile = resolveGenerationProfile(expected.id);
    assert.equal(profile.mainImageCount, expected.mainImageCount);
    assert.equal(profile.detailImageCount, expected.detailImageCount);
    assert.equal(detailImageCountForTask({ generationProfileId: profile.id, detailImageCount: 8, generateDetail: true }), expected.detailImageCount);
    assert.equal(detailImageCountForTask({ generationProfileId: profile.id, generateDetail: false }), 0);
    assert.equal(overviewFilename("main", profile.mainImageCount), `${expected.mainImageCount}张主图总览.jpg`);
    assert.equal(overviewFilename("detail", profile.detailImageCount), `${expected.detailImageCount}张详情页总览.jpg`);
  }
});
