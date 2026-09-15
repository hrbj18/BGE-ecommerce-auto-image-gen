import test from "node:test";
import assert from "node:assert/strict";
import {
  listPlatformStyleProfiles,
  normalizeTargetPlatform,
  platformStyleProfile,
  requireTargetPlatform,
} from "../src/platform-style-profiles.mjs";

const expectedPlatforms = [
  "国内通用",
  "国外通用",
];

test("publishes only the two general styles", () => {
  const profiles = listPlatformStyleProfiles();
  assert.deepEqual(profiles.map((profile) => profile.label), expectedPlatforms);
  assert.deepEqual(profiles.map((profile) => profile.id), ["domestic-general", "global-general"]);
  assert.equal(profiles.filter((profile) => profile.region === "domestic").length, 1);
  assert.equal(profiles.filter((profile) => profile.region === "global").length, 1);
});

test("keeps legacy aliases readable but accepts only public styles for new submissions", () => {
  const aliases = new Map([
    ["国内", "国内通用"],
    ["海外通用", "国外通用"],
    ["Tmall", "淘宝/天猫"],
    ["JD.com", "京东"],
    ["Douyin Shop", "抖音电商"],
    ["RedNote", "小红书"],
    ["亚马逊", "Amazon"],
    ["tiktokshop", "TikTok Shop"],
    ["虾皮", "Shopee"],
    ["来赞达", "Lazada"],
  ]);
  for (const [alias, expected] of aliases) assert.equal(normalizeTargetPlatform(alias), expected, alias);
  assert.equal(requireTargetPlatform("国内"), "国内通用");
  assert.equal(requireTargetPlatform("海外通用"), "国外通用");
  assert.throws(() => requireTargetPlatform("Amazon"), (error: Error & { statusCode?: number; code?: string }) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "TARGET_PLATFORM_INVALID");
    assert.match(error.message, /国内通用、国外通用/);
    return true;
  });
  assert.equal(platformStyleProfile("unknown-marketplace"), undefined);
  assert.throws(() => requireTargetPlatform("unknown-marketplace"), (error: Error & { statusCode?: number; code?: string }) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "TARGET_PLATFORM_INVALID");
    return true;
  });
});
