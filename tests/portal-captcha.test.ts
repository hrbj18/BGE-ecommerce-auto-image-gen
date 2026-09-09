import test from "node:test";
import assert from "node:assert/strict";
import { captchaImageSource } from "../frontend/src/portal-captcha.js";

test("normalizes RuoYi raw captcha Base64 into a browser image data URL", () => {
  assert.equal(captchaImageSource("YWJjZA=="), "data:image/jpeg;base64,YWJjZA==");
});

test("keeps an existing captcha data URL and ignores missing image data", () => {
  const existing = "data:image/gif;base64,ZWZnaA==";
  assert.equal(captchaImageSource(existing), existing);
  assert.equal(captchaImageSource(""), "");
  assert.equal(captchaImageSource(undefined), "");
});
