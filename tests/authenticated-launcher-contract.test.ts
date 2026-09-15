import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(projectRoot, relativePath), "utf8");
}

test("legacy desktop entry points can only open authenticated pages", async () => {
  const [packageJson, nodeLauncher, powershellLauncher, cmdLauncher, oneClick, app] = await Promise.all([
    source("package.json"),
    source("scripts/dev-web-app.mjs"),
    source("scripts/start-web.ps1"),
    source("start-web.cmd"),
    source("一键启动项目.bat"),
    source("frontend/src/App.jsx")
  ]);

  const scripts = JSON.parse(packageJson).scripts as Record<string, string>;
  assert.equal(scripts.web, "node scripts/dev-web-app.mjs");
  assert.equal(scripts["frontend:dev"], "node scripts/dev-web-app.mjs");

  for (const launcher of [nodeLauncher, powershellLauncher]) {
    assert.match(launcher, /admin[\\", ]+scripts[\\", ]+start-user-portal\.ps1/);
    assert.match(launcher, /http:\/\/127\.0\.0\.1:8003\/portal\//);
    assert.doesNotMatch(launcher, /5173|START_FRONTEND_ONLY|LOCAL_WEB_ACCESS_MODE\s*=\s*["']off/);
  }

  assert.doesNotMatch(cmdLauncher, /-NoExit/);
  assert.match(oneClick, /-OpenBoth/);
  assert.match(oneClick, /http:\/\/127\.0\.0\.1:8001\//);
  assert.match(oneClick, /http:\/\/127\.0\.0\.1:8003\/portal\//);
  assert.match(app, /window\.location\.replace\("http:\/\/127\.0\.0\.1:8003\/portal\/"\)/);
  assert.match(app, /if \(!portalMode && !workbenchMode\)/);
});
