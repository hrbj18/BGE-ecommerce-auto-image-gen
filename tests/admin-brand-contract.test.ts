import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(projectRoot, relativePath), "utf8");
}

test("admin entry points consistently use the Haike brand", async () => {
  const [html, sidebar, login, home, navbar, settings, themeStore, logo, favicon, ...environments] = await Promise.all([
    source("admin/frontend/index.html"),
    source("admin/frontend/src/layout/components/Sidebar/Logo.vue"),
    source("admin/frontend/src/views/login.vue"),
    source("admin/frontend/src/views/index.vue"),
    source("admin/frontend/src/layout/components/Navbar.vue"),
    source("admin/frontend/src/settings.ts"),
    source("admin/frontend/src/store/modules/settings.ts"),
    source("admin/frontend/src/assets/logo/haike-mark.svg"),
    source("admin/frontend/public/haike-mark.svg"),
    source("admin/frontend/.env.development"),
    source("admin/frontend/.env.production"),
    source("admin/frontend/.env.staging")
  ]);

  assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/haike-mark\.svg"/);
  assert.match(sidebar, /haike-mark\.svg/);
  assert.match(sidebar, /海客电商生图/);
  assert.match(login, /HAIKE COMMERCE AI/);
  assert.match(login, /海客电商生图/);
  assert.doesNotMatch(login, /login-background/);
  assert.match(home, /海客电商生图管理后台/);
  assert.match(home, /电商作图/);
  assert.match(home, /积分管理/);
  assert.doesNotMatch(home, /若依|RuoYi|ruoyi\.vip/);
  assert.doesNotMatch(navbar, /RuoYiGit|RuoYiDoc|ruo-yi-(?:git|doc)/);
  assert.match(settings, /Copyright © 2026 海客电商生图/);
  assert.match(themeStore, /'#0F766E'/);

  for (const environment of environments) {
    assert.match(environment, /VITE_APP_TITLE = 海客电商生图管理后台/);
  }

  for (const mark of [logo, favicon]) {
    assert.match(mark, /viewBox="0 0 64 64"/);
    assert.match(mark, /fill="#0f766e"/);
    assert.match(mark, /stroke="#fff"/);
  }
});

test("admin home actions and navbar stay within the product permission boundary", async () => {
  const [home, navbar] = await Promise.all([
    source("admin/frontend/src/views/index.vue"),
    source("admin/frontend/src/layout/components/Navbar.vue")
  ]);

  assert.match(home, /const visibleActions = computed\(\(\) => actions\.filter/);
  assert.match(home, /userStore\.permissions\.includes\('\*:\*:\*'\)/);
  assert.match(home, /userStore\.permissions\.includes\(item\.permission\)/);
  assert.match(home, /v-if="!visibleActions\.length"/);

  for (const legacyTool of [
    /NavbarSearch/,
    /Screenfull/,
    /SizeSelect/,
    /HeaderSearch/,
    /RuoYiGit/,
    /RuoYiDoc/,
    /openSettings/,
    /lockScreen/
  ]) {
    assert.doesNotMatch(navbar, legacyTool);
  }

  assert.match(navbar, /个人中心/);
  assert.match(navbar, /退出登录/);
});
