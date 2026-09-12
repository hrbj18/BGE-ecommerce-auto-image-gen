import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(projectRoot, relativePath), "utf8");
}

test("clickable RuoYi launchers use the built-in PowerShell without changing global policy", async () => {
  const launchers = await Promise.all([
    source("启动若依管理后台.cmd"),
    source("启动用户端.cmd"),
    source("修复若依本机环境.cmd"),
    source("复制若依管理员密码.cmd")
  ]);

  for (const launcher of launchers) {
    assert.match(launcher, /%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
    assert.match(launcher, /-ExecutionPolicy Bypass -File/);
    assert.doesNotMatch(launcher, /pwsh\.exe/i);
  }
});

test("the desktop launchers serialize startup, refresh stale backend artifacts, and open their selected entry", async () => {
  const [launcher, adminLauncher, portalStart, adminStart, artifact, refresh, nodeRefresh] = await Promise.all([
    source("启动用户端.cmd"),
    source("启动若依管理后台.cmd"),
    source("admin/scripts/start-user-portal.ps1"),
    source("admin/scripts/start-admin.ps1"),
    source("admin/scripts/backend-artifact.ps1"),
    source("admin/scripts/refresh-admin-backend.ps1"),
    source("admin/scripts/refresh-bge-node.ps1")
  ]);

  assert.match(launcher, /admin\\scripts\\start-user-portal\.ps1/);
  assert.match(adminLauncher, /admin\\scripts\\start-user-portal\.ps1/);
  assert.match(adminLauncher, /-EntryUri "http:\/\/127\.0\.0\.1:8001\/"/);
  for (const desktopLauncher of [launcher, adminLauncher]) {
    assert.match(desktopLauncher, /ping\.exe 127\.0\.0\.1 -n 4/);
    assert.match(desktopLauncher, /exit \/b 0/);
    assert.doesNotMatch(desktopLauncher, /timeout \/t/i);
  }
  assert.match(portalStart, /Test-UserPortalStack/);
  assert.match(portalStart, /127\.0\.0\.1:8787\/health/);
  assert.match(portalStart, /127\.0\.0\.1:\$env:RUOYI_SERVER_PORT\/captchaImage/);
  assert.match(portalStart, /127\.0\.0\.1:8003\/portal\//);
  assert.match(portalStart, /Docker\\Docker\\Docker Desktop\.exe/);
  assert.match(portalStart, /-WindowStyle Hidden/);
  assert.match(portalStart, /docker start \"bge-ruoyi-mysql\" \"bge-ruoyi-redis\"/);
  assert.match(portalStart, /Wait-InfrastructurePorts/);
  assert.match(portalStart, /Test-PortalConfiguration/);
  assert.match(portalStart, /Import-PortalEnvironment/);
  assert.match(portalStart, /Test-BgeBackendArtifactFresh/);
  assert.match(portalStart, /refresh-admin-backend\.ps1/);
  assert.match(portalStart, /Test-BgeNodeSourceFresh/);
  assert.match(portalStart, /Test-BgeNodeBusy/);
  assert.match(portalStart, /refresh-bge-node\.ps1/);
  assert.match(portalStart, /recover-admin-infrastructure\.ps1/);
  assert.match(portalStart, /if \(\$environmentReady -and \$mysqlExists -and \$redisExists\)/);
  assert.match(portalStart, /& \(Join-Path \$PSScriptRoot 'start-admin\.ps1'\)/);
  assert.match(portalStart, /Local\\BGE-RuoYi-Startup/);
  assert.match(portalStart, /WaitOne\(\[TimeSpan\]::FromMinutes\(4\)\)/);
  assert.match(portalStart, /ReleaseMutex\(\)/);
  assert.match(portalStart, /Start-Process -FilePath \$EntryUri/);
  assert.match(portalStart, /\$portalUri = 'http:\/\/127\.0\.0\.1:8001\/portal\/'/);
  assert.match(portalStart, /ValidateSet\('http:\/\/127\.0\.0\.1:8001\/', 'http:\/\/127\.0\.0\.1:8001\/portal\/'\)/);
  assert.doesNotMatch(portalStart, /(?:password|secret|token)\s*=\s*['"][^'"]+['"]/i);
  assert.doesNotMatch(portalStart, /[^\x00-\x7F]/);
  assert.match(adminStart, /Update-BgeBackendArtifact/);
  assert.match(artifact, /src/);
  assert.match(artifact, /main/);
  assert.match(artifact, /-DskipTests/);
  assert.doesNotMatch(artifact, /(?:password|secret|token)\s*=\s*['"][^'"]+['"]/i);
  assert.match(refresh, /recorded RuoYi backend process could not be verified/);
  assert.match(refresh, /Wait-BackendPortClosed/);
  assert.match(refresh, /Wait-BackendReady/);
  assert.match(refresh, /backendRefreshedAt/);
  assert.match(nodeRefresh, /active image workflow; refusing to interrupt it/);
  assert.match(nodeRefresh, /recorded BGE Node process could not be verified/);
  assert.match(nodeRefresh, /scripts\/local-web-server\.mjs/);
  assert.match(nodeRefresh, /Wait-EngineReady/);
  assert.match(nodeRefresh, /nodeRefreshedAt/);
  assert.doesNotMatch(nodeRefresh, /(?:password|secret|token)\s*=\s*['"][^'"]+['"]/i);
});

test("RuoYi BGE frontend remains read-only and releases polling and Blob resources", async () => {
  const [api, page, image] = await Promise.all([
    source("admin/frontend/src/api/bge/task.ts"),
    source("admin/frontend/src/views/bge/task/index.vue"),
    source("admin/frontend/src/views/bge/task/AuthenticatedImage.vue")
  ]);

  assert.doesNotMatch(api, /method\s*:\s*["'](?:post|put|patch|delete)["']/i);
  assert.doesNotMatch(page, />\s*(?:提交|取消|删除|重试|返工|下载)(?:任务|图片|成品)?\s*</);
  assert.match(page, /const POLL_INTERVAL_MS = 5000/);
  assert.match(page, /document\.hidden/);
  assert.match(page, /onBeforeUnmount\(\(\) =>/);
  assert.match(page, /clearPollTimer\(\)/);
  assert.match(page, /removeEventListener\(['"]visibilitychange['"]/);
  assert.match(image, /URL\.createObjectURL\(blob\)/);
  assert.match(image, /URL\.revokeObjectURL\(objectUrl\.value\)/);
  assert.match(image, /activeController\?\.abort\(\)/);
});

test("RuoYi mode keeps Node reads behind the shared internal token", async () => {
  const [server, environment, client] = await Promise.all([
    source("scripts/local-web-server.mjs"),
    source("admin/scripts/import-admin-environment.ps1"),
    source("admin/backend/ruoyi-bge/src/main/java/com/ruoyi/bge/client/BgeEngineClient.java")
  ]);

  assert.match(server, /requireReadToken && req\.method === ["']GET["']/);
  assert.match(environment, /LOCAL_WEB_HOST = '127\.0\.0\.1'/);
  assert.match(environment, /LOCAL_WEB_REQUIRE_READ_TOKEN = 'true'/);
  assert.match(environment, /BGE_ENGINE_ACCESS_TOKEN = \$localWebToken/);
  assert.match(client, /header\("Authorization", "Bearer " \+ accessToken\)/);
});

test("the dedicated database role is rebuilt from a four-item BGE read allowlist", async () => {
  const sql = await source("admin/sql/001-bge-readonly-menu.sql");
  assert.match(sql, /DELETE FROM sys_role_menu WHERE role_id = @bge_role_id/);
  assert.match(sql, /'bge:task:list'/);
  assert.match(sql, /'bge:task:query'/);
  assert.match(sql, /'bge:output:view'/);
  assert.doesNotMatch(sql, /bge:(?:task|output):(?!list|query|view)[a-z]+/i);
});

test("the unified 8001 entry keeps the workbench behind RuoYi authorization", async () => {
  const [adminVite, start, sql, controller, cookieFilter, workbenchVite] = await Promise.all([
    source("admin/frontend/vite.config.ts"),
    source("admin/scripts/start-admin.ps1"),
    source("admin/sql/001-bge-readonly-menu.sql"),
    source("admin/backend/ruoyi-bge/src/main/java/com/ruoyi/bge/controller/BgeWorkbenchController.java"),
    source("admin/backend/ruoyi-bge/src/main/java/com/ruoyi/bge/filter/BgeWorkbenchCookieAuthenticationFilter.java"),
    source("frontend/vite.config.mjs")
  ]);

  assert.match(adminVite, /port:\s*8001/);
  assert.match(adminVite, /['"]\/workbench['"]:\s*\{/);
  assert.match(adminVite, /target:\s*workbenchUrl/);
  assert.match(start, /@\(8787, 8001, 8002, 8003, \$backendPort\)/);
  assert.match(start, /BGE_WORKBENCH_BASE = ['"]\/workbench\//);
  assert.match(workbenchVite, /base:\s*process\.env\.BGE_WORKBENCH_BASE \|\| ['"]\/['"]/);
  assert.match(sql, /'bge_operator'/);
  assert.match(sql, /'bge:workbench:use'/);
  const viewerSection = sql.slice(sql.indexOf("SET @bge_role_id :="), sql.indexOf("SET @bge_operator_role_id :="));
  assert.doesNotMatch(viewerSection, /bge:workbench:use/);
  assert.match(controller, /@PreAuthorize\(WORKBENCH_PERMISSION\)/);
  assert.match(controller, /private boolean isAllowed/);
  assert.match(controller, /RequestMethod\.GET, RequestMethod\.POST, RequestMethod\.DELETE/);
  assert.match(cookieFilter, /['"]\/workbench-api\//);
  assert.match(cookieFilter, /['"]\/portal-api\//);
  assert.match(cookieFilter, /TOKEN_COOKIE = ['"]Admin-Token['"]/);
  assert.match(cookieFilter, /authorization = ['"]Bearer ['"] \+ token/);
});

test("self-service portal uses a dedicated no-menu role and a server-side ownership boundary", async () => {
  const [portalSql, portalController, authController, userService, app, adminVite, start, security] = await Promise.all([
    source("admin/sql/002-bge-portal-users.sql"),
    source("admin/backend/ruoyi-bge/src/main/java/com/ruoyi/bge/controller/BgePortalController.java"),
    source("admin/backend/ruoyi-bge/src/main/java/com/ruoyi/bge/controller/PortalAuthController.java"),
    source("admin/backend/ruoyi-bge/src/main/java/com/ruoyi/bge/portal/PortalUserService.java"),
    source("frontend/src/App.jsx"),
    source("admin/frontend/vite.config.ts"),
    source("admin/scripts/start-admin.ps1"),
    source("admin/backend/ruoyi-framework/src/main/java/com/ruoyi/framework/config/SecurityConfig.java")
  ]);

  assert.match(portalSql, /'bge_portal_user'/);
  assert.match(portalSql, /DELETE FROM sys_role_menu WHERE role_id = @portal_role_id/);
  assert.doesNotMatch(portalSql, /bge:workbench:use/);
  assert.match(portalSql, /CREATE TABLE IF NOT EXISTS bge_portal_job/);
  assert.match(portalController, /@RequestMapping\("\/portal-api"\)/);
  assert.match(portalController, /@PreAuthorize\("isAuthenticated\(\)"\)/);
  assert.match(portalController, /requireOwnedImage\(/);
  assert.match(portalController, /requireOwnedOutput\(/);
  assert.match(portalController, /ownership\.claim\(/);
  assert.match(portalController, /\/portal-api\/outputs\//);
  assert.match(portalController, /\/api\/examples/);
  assert.match(authController, /@RequestMapping\("\/portal-auth"\)/);
  assert.match(authController, /httpOnly\(true\)/);
  assert.match(userService, /PORTAL_ROLE = "bge_portal_user"/);
  assert.match(userService, /setRoleIds\(new Long\[\] \{ roleId \}\)/);
  assert.match(app, /PortalAccessPage/);
  assert.match(app, /\/portal-auth\/register/);
  assert.match(app, /\/portal-api/);
  assert.doesNotMatch(app, /bge-local-web-access-token[\s\S]{0,200}portal-auth\/login/);
  assert.match(adminVite, /['"]\/portal['"]:\s*\{/);
  assert.match(adminVite, /target:\s*portalUrl/);
  assert.match(adminVite, /['"]\/portal-api['"]:\s*\{/);
  assert.match(start, /--port', '8003'/);
  assert.match(start, /BGE_WORKBENCH_BASE = ['"]\/portal\//);
  assert.match(security, /\/portal-auth\/login", "\/portal-auth\/register/);
});

test("RuoYi local bootstrap removes upstream demo and default-credential write paths", async () => {
  const [common, login, application, security, environment, bootstrap, databaseInit, secretInit, recovery, start, passwordUpdate, encodingRepair] = await Promise.all([
    source("admin/backend/ruoyi-admin/src/main/java/com/ruoyi/web/controller/common/CommonController.java"),
    source("admin/frontend/src/views/login.vue"),
    source("admin/backend/ruoyi-admin/src/main/resources/application.yml"),
    source("admin/backend/ruoyi-framework/src/main/java/com/ruoyi/framework/config/SecurityConfig.java"),
    source("admin/scripts/import-admin-environment.ps1"),
    source("admin/backend/ruoyi-admin/src/main/java/com/ruoyi/web/core/config/AdminPasswordBootstrap.java"),
    source("admin/scripts/initialize-admin-db.ps1"),
    source("admin/scripts/initialize-admin-secrets.ps1"),
    source("admin/scripts/recover-admin-infrastructure.ps1"),
    source("admin/scripts/start-admin.ps1"),
    source("admin/scripts/set-admin-password.ps1"),
    source("admin/scripts/repair-admin-encoding.ps1")
  ]);

  await assert.rejects(
    fs.stat(path.join(projectRoot, "admin/backend/ruoyi-admin/src/main/java/com/ruoyi/web/controller/tool/TestController.java")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );
  assert.equal((common.match(/@PreAuthorize\("@ss\.hasRole\('admin'\)"\)/g) ?? []).length, 4);
  assert.doesNotMatch(login, /password:\s*["']admin123["']/);
  assert.match(application, /api-docs:\s*\r?\n\s+enabled:\s*\$\{RUOYI_SPRINGDOC_ENABLED:false\}/);
  assert.doesNotMatch(security, /requestMatchers\([^\r\n]*\/v3\/api-docs/);
  assert.match(environment, /RUOYI_ADMIN_BOOTSTRAP_PASSWORD = \$adminPassword/);
  assert.match(bootstrap, /MINIMUM_LOCAL_PASSWORD_LENGTH = 6/);
  assert.match(bootstrap, /bootstrapPassword\.length\(\) < MINIMUM_LOCAL_PASSWORD_LENGTH/);
  assert.match(bootstrap, /matchesPassword\(UPSTREAM_DEFAULT_PASSWORD, admin\.getPassword\(\)\)/);
  assert.match(bootstrap, /resetUserPwd\(admin\.getUserId\(\), SecurityUtils\.encryptPassword\(bootstrapPassword\)\)/);
  assert.match(databaseInit, /拒绝使用 MySQL root/);
  assert.match(secretInit, /\$adminPassword = New-RandomSecureSecret -ByteCount 12/);
  assert.match(secretInit, /RuoYiAdminPassword = \$adminPassword/);
  assert.match(secretInit, /\$existingTokenSecret -is \[System\.Security\.SecureString\]/);
  assert.match(secretInit, /\$existingLocalWebToken -is \[System\.Security\.SecureString\]/);
  assert.doesNotMatch(secretInit, /Write-(?:Host|Output)[^\r\n]*\$(?:plainTextSecret|adminPassword)/);
  assert.match(recovery, /if \(\$mysqlExists -xor \$redisExists\)/);
  assert.match(recovery, /if \(\$mysqlExists -and -not \$validInfrastructure\)/);
  assert.match(recovery, /Backup-ReplacedCredential/);
  assert.match(recovery, /127\.0\.0\.1:3306:3306/);
  assert.match(recovery, /127\.0\.0\.1:6379:6379/);
  assert.doesNotMatch(recovery, /docker\s+(?:container\s+)?rm\b/i);
  assert.match(start, /-WorkingDirectory \$frontendRoot/);
  assert.match(start, /'--strictPort'/);
  assert.match(passwordUpdate, /\/system\/user\/profile\/updatePwd/);
  assert.doesNotMatch(passwordUpdate, /\/system\/user\/resetPwd/);
  assert.match(passwordUpdate, /RuoYiAdminPassword = \$NewPassword/);
  assert.doesNotMatch(passwordUpdate, /Write-(?:Host|Output)[^\r\n]*\$(?:newPlainPassword|oldPassword)/);
  assert.match(databaseInit, /docker cp \$Path \$containerTarget/);
  assert.doesNotMatch(databaseInit, /Get-Content[^\r\n]*\|[\s\S]{0,160}mysql --default-character-set=utf8mb4/);
  assert.match(encodingRepair, /mysql:8\.4/);
  assert.match(encodingRepair, /sys_menu current_row JOIN bge_encoding_menu reference_row/);
  assert.match(encodingRepair, /menu_name REGEXP '\^\[\?\]\+\$'/);
});
