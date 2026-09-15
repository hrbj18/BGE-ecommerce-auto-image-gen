import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(projectRoot, relativePath), "utf8");
}

test("admin account management exposes six fixed business identities", async () => {
  const [page, levels, migration, initializer, mapper, home, integration] = await Promise.all([
    source("admin/frontend/src/views/system/user/index.vue"),
    source("admin/frontend/src/views/system/user/account-levels.ts"),
    source("admin/sql/005-bge-account-levels.sql"),
    source("admin/scripts/initialize-admin-db.ps1"),
    source("admin/backend/ruoyi-system/src/main/resources/mapper/system/SysUserMapper.xml"),
    source("admin/frontend/src/views/index.vue"),
    source("admin/scripts/smoke-admin-integration.ps1")
  ]);

  for (const label of ["体验用户", "标准用户", "重点用户", "只读管理员", "运营管理员", "超级管理员"]) {
    assert.match(levels, new RegExp(label));
    assert.match(migration, new RegExp(label));
  }

  for (const roleKey of [
    "bge_portal_user",
    "bge_customer",
    "bge_priority_customer",
    "bge_viewer",
    "bge_operator",
    "admin"
  ]) {
    assert.match(levels, new RegExp(roleKey));
    assert.match(migration, new RegExp(roleKey));
  }

  assert.match(page, /form\.roleIds = \[identity\.roleId\]/);
  assert.match(page, /roleIds: currentIdentity\?\.roleId \? \[currentIdentity\.roleId\] : \[\]/);
  assert.match(page, /maxlength="32"/);
  assert.match(page, /账号状态/);
  assert.match(page, /最后登录/);
  assert.doesNotMatch(page, /TreePanel|组织机构|归属部门|岗位|权限字符|分配角色|handleAuthRole|handleImport|handleExport/);

  assert.match(migration, /path = 'role'[\s\S]*visible = '1'|visible = '1'[\s\S]*path = 'role'/);
  assert.match(migration, /path = 'role'[\s\S]*status = '1'|status = '1'[\s\S]*path = 'role'/);
  assert.match(migration, /path = 'user'[\s\S]*menu_name = '账号列表'|menu_name = '账号列表'[\s\S]*path = 'user'/);
  assert.match(initializer, /005-bge-account-levels\.sql/);
  assert.match(initializer, /customerRoleCount/);
  assert.match(mapper, /primary_role_id/);
  assert.match(mapper, /roleId != null and roleId != 0/);
  assert.match(home, /title: '账号管理'/);
  assert.match(integration, /accountLevelsReady = \$false/);
  assert.match(integration, /accountLevelFilter = \$false/);
  assert.match(integration, /roleManagementHidden = \$false/);
  assert.match(integration, /roleId=\$portalRoleId&userName=\$encodedPortalName/);
});
