<template>
  <main class="account-page app-container">
    <header class="page-heading">
      <div>
        <span class="page-kicker">ACCOUNTS</span>
        <h1>账号管理</h1>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate" v-hasPermi="['system:user:add']">新增账号</el-button>
    </header>

    <section class="identity-section" aria-labelledby="identity-title">
      <div class="section-title">
        <h2 id="identity-title">账号等级</h2>
        <span>点击等级可筛选</span>
      </div>
      <div class="identity-groups">
        <div v-for="group in identityGroups" :key="group.kind" class="identity-group">
          <div class="group-label">
            <el-icon><component :is="group.icon" /></el-icon>
            {{ group.label }}
          </div>
          <div class="identity-row">
            <button
              v-for="identity in group.items"
              :key="identity.roleKey"
              type="button"
              class="identity-summary"
              :class="[`identity-summary--${identity.tone}`, { 'is-active': queryParams.roleId === identity.roleId }]"
              @click="filterByIdentity(identity)"
            >
              <span class="identity-level">{{ identity.level }}</span>
              <span class="identity-copy">
                <strong>{{ identity.label }}</strong>
                <small>{{ identity.shortDescription }}</small>
              </span>
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="account-list" aria-labelledby="account-list-title">
      <div class="list-toolbar">
        <div class="section-title list-title">
          <h2 id="account-list-title">账号列表</h2>
          <span>共 {{ total }} 个</span>
        </div>
        <div class="filters">
          <el-input
            v-model="queryParams.userName"
            clearable
            class="search-input"
            placeholder="搜索账号、昵称或手机号"
            @keyup.enter="handleQuery"
            @clear="handleQuery"
          >
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-select v-model="queryParams.roleId" clearable placeholder="全部等级" class="level-filter" @change="handleQuery">
            <el-option v-for="identity in identities" :key="identity.roleKey" :label="identity.label" :value="identity.roleId" />
          </el-select>
          <el-select v-model="queryParams.status" clearable placeholder="全部状态" class="status-filter" @change="handleQuery">
            <el-option label="正常使用" value="0" />
            <el-option label="已停用" value="1" />
          </el-select>
          <el-tooltip content="重置筛选" placement="top">
            <el-button :icon="Refresh" circle @click="resetQuery" />
          </el-tooltip>
        </div>
      </div>

      <el-table v-loading="loading" :data="userList" class="account-table" empty-text="暂无符合条件的账号">
        <el-table-column label="账号" min-width="190">
          <template #default="scope">
            <div class="account-cell">
              <span class="avatar" :class="`avatar--${identityFor(scope.row).tone}`">{{ initials(scope.row) }}</span>
              <span>
                <strong>{{ scope.row.nickName || scope.row.userName }}</strong>
                <small>{{ scope.row.userName }}</small>
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="账号等级" min-width="150">
          <template #default="scope">
            <span class="identity-badge" :class="`identity-badge--${identityFor(scope.row).tone}`">
              {{ identityFor(scope.row).label }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="可用范围" min-width="220">
          <template #default="scope"><span class="scope-copy">{{ identityFor(scope.row).description }}</span></template>
        </el-table-column>
        <el-table-column label="联系方式" min-width="170">
          <template #default="scope">
            <div class="contact-cell">
              <span>{{ scope.row.phonenumber || '未填写手机号' }}</span>
              <small>{{ scope.row.email || '未填写邮箱' }}</small>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="账号状态" width="116" align="center">
          <template #default="scope">
            <el-switch
              v-model="scope.row.status"
              active-value="0"
              inactive-value="1"
              :disabled="scope.row.userId === 1"
              @change="changeStatus(scope.row)"
            />
          </template>
        </el-table-column>
        <el-table-column label="最后登录" width="168">
          <template #default="scope">{{ displayTime(scope.row.loginDate) }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="168">
          <template #default="scope">{{ displayTime(scope.row.createTime as string | undefined) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="142" align="center" fixed="right">
          <template #default="scope">
            <template v-if="scope.row.userId !== 1">
              <el-tooltip content="编辑账号" placement="top">
                <el-button link type="primary" :icon="Edit" @click="openEdit(scope.row)" v-hasPermi="['system:user:edit']" />
              </el-tooltip>
              <el-tooltip content="重置密码" placement="top">
                <el-button link type="primary" :icon="Key" @click="resetPassword(scope.row)" v-hasPermi="['system:user:resetPwd']" />
              </el-tooltip>
              <el-tooltip content="删除账号" placement="top">
                <el-button link type="danger" :icon="Delete" @click="removeAccount(scope.row)" v-hasPermi="['system:user:remove']" />
              </el-tooltip>
            </template>
            <el-tooltip v-else content="内置超级管理员不可修改" placement="top">
              <el-icon class="protected-icon"><Lock /></el-icon>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>

      <pagination
        v-show="total > 0"
        :total="total"
        v-model:page="queryParams.pageNum"
        v-model:limit="queryParams.pageSize"
        @pagination="getList"
      />
    </section>

    <el-dialog v-model="editorOpen" :title="editorTitle" width="760px" append-to-body destroy-on-close>
      <el-form ref="userFormRef" :model="form" :rules="rules" label-position="top" class="account-form">
        <div class="form-grid">
          <el-form-item label="登录账号" prop="userName">
            <el-input v-model="form.userName" :disabled="form.userId !== undefined" maxlength="30" placeholder="用于登录" />
          </el-form-item>
          <el-form-item label="显示名称" prop="nickName">
            <el-input v-model="form.nickName" maxlength="30" placeholder="用户看到的名称" />
          </el-form-item>
          <el-form-item v-if="form.userId === undefined" label="登录密码" prop="password">
            <el-input v-model="form.password" type="password" show-password maxlength="32" placeholder="6–32 位" />
          </el-form-item>
          <el-form-item label="手机号码" prop="phonenumber">
            <el-input v-model="form.phonenumber" maxlength="11" placeholder="选填" />
          </el-form-item>
          <el-form-item label="邮箱" prop="email">
            <el-input v-model="form.email" maxlength="50" placeholder="选填" />
          </el-form-item>
          <el-form-item label="账号状态">
            <el-radio-group v-model="form.status">
              <el-radio-button value="0">正常使用</el-radio-button>
              <el-radio-button value="1">停用</el-radio-button>
            </el-radio-group>
          </el-form-item>
        </div>

        <el-form-item label="账号等级" prop="roleIds" class="identity-form-item">
          <div class="identity-picker">
            <button
              v-for="identity in identities"
              :key="identity.roleKey"
              type="button"
              class="identity-option"
              :class="[`identity-option--${identity.tone}`, { 'is-selected': selectedIdentity?.roleKey === identity.roleKey }]"
              :disabled="identity.roleKey === 'admin' || !identity.roleId"
              @click="selectIdentity(identity)"
            >
              <el-icon><component :is="identity.icon" /></el-icon>
              <span>
                <strong>{{ identity.label }}</strong>
                <small>{{ identity.description }}</small>
              </span>
              <el-icon v-if="selectedIdentity?.roleKey === identity.roleKey" class="selected-mark"><CircleCheckFilled /></el-icon>
              <span v-else-if="identity.roleKey === 'admin'" class="built-in-mark">内置</span>
            </button>
          </div>
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="200" show-word-limit placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="closeEditor">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveAccount">保存</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<script setup lang="ts" name="User">
import { computed, onMounted, reactive, ref, type Component } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Avatar, CircleCheckFilled, Delete, Edit, Key, Lock, Medal, Operation, Plus,
  Refresh, Search, Star, User, View
} from '@element-plus/icons-vue'
import { addUser, changeUserStatus, delUser, getUser, listUser, resetUserPwd, updateUser } from '@/api/system/user'
import type { SysUser, UserQueryParams } from '@/types/api/system/user'
import type { SysRole } from '@/types/api/system/role'
import { ACCOUNT_LEVELS, type AccountKind, type AccountTone } from './account-levels'

interface IdentityDefinition {
  roleKey: string
  label: string
  level: string
  kind: AccountKind
  tone: AccountTone
  shortDescription: string
  description: string
  icon: Component
  fixedRoleId?: number
}

interface ResolvedIdentity extends IdentityDefinition {
  roleId?: number
}

const identityIcons: Record<string, Component> = {
  bge_portal_user: User,
  bge_customer: Star,
  bge_priority_customer: Medal,
  bge_viewer: View,
  bge_operator: Operation,
  admin: Lock
}
const definitions: IdentityDefinition[] = ACCOUNT_LEVELS.map((item) => ({ ...item, icon: identityIcons[item.roleKey] }))

const userList = ref<SysUser[]>([])
const roles = ref<SysRole[]>([])
const loading = ref(false)
const saving = ref(false)
const editorOpen = ref(false)
const editorTitle = ref('新增账号')
const total = ref(0)
const userFormRef = ref<any>(null)
const queryParams = reactive<UserQueryParams>({ pageNum: 1, pageSize: 10, userName: undefined, status: undefined, roleId: undefined })

function emptyForm(): SysUser {
  return { userId: undefined, userName: '', nickName: '', password: '', phonenumber: '', email: '', sex: '2', status: '0', remark: '', deptId: undefined, postIds: [], roleIds: [] }
}

const form = reactive<SysUser>(emptyForm())
const rules = {
  userName: [
    { required: true, message: '请输入登录账号', trigger: 'blur' },
    { min: 2, max: 20, message: '登录账号长度为 2–20 位', trigger: 'blur' }
  ],
  nickName: [{ required: true, message: '请输入显示名称', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入登录密码', trigger: 'blur' },
    { min: 6, max: 32, message: '密码长度为 6–32 位', trigger: 'blur' },
    { pattern: /^[^<>"'|\\]+$/, message: '密码不能包含 < > " \' \\ |', trigger: 'blur' }
  ],
  phonenumber: [{ pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号码', trigger: 'blur' }],
  email: [{ type: 'email', message: '请输入正确的邮箱地址', trigger: ['blur', 'change'] }],
  roleIds: [{ type: 'array', required: true, min: 1, message: '请选择一个账号等级', trigger: 'change' }]
}

const identities = computed<ResolvedIdentity[]>(() => definitions.map((definition) => ({
  ...definition,
  roleId: definition.fixedRoleId ?? roles.value.find((role) => role.roleKey === definition.roleKey)?.roleId
})))

const identityGroups = computed(() => [
  { kind: 'customer', label: '用户等级', icon: Avatar, items: identities.value.filter((item) => item.kind === 'customer') },
  { kind: 'administrator', label: '管理员等级', icon: Lock, items: identities.value.filter((item) => item.kind === 'administrator') }
])

const selectedIdentity = computed(() => identities.value.find((identity) => form.roleIds?.includes(identity.roleId ?? -1)))
const unknownIdentity: ResolvedIdentity = {
  roleKey: 'unclassified', label: '待归类', level: '--', kind: 'customer', tone: 'gray',
  shortDescription: '尚未设置等级', description: '编辑账号后选择一个账号等级', icon: User
}

function identityFor(row: SysUser): ResolvedIdentity {
  if (row.userId === 1) return identities.value.find((item) => item.roleKey === 'admin') ?? unknownIdentity
  return identities.value.find((item) => item.roleId === row.roleId) ?? unknownIdentity
}

function initials(row: SysUser): string {
  return (row.nickName || row.userName || '?').trim().slice(0, 1).toUpperCase()
}

function displayTime(value?: string): string {
  return value ? value.replace('T', ' ').slice(0, 19) : '从未登录'
}

function mergeRoles(nextRoles: SysRole[]): void {
  const byKey = new Map(roles.value.map((role) => [role.roleKey, role]))
  nextRoles.forEach((role) => byKey.set(role.roleKey, role))
  roles.value = [...byKey.values()]
}

async function loadRoles(): Promise<void> {
  const response = await getUser()
  mergeRoles(response.roles)
}

async function getList(): Promise<void> {
  loading.value = true
  try {
    const response = await listUser(queryParams)
    userList.value = response.rows
    total.value = response.total
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '账号列表加载失败')
  } finally {
    loading.value = false
  }
}

function handleQuery(): void {
  queryParams.pageNum = 1
  void getList()
}

function resetQuery(): void {
  Object.assign(queryParams, { pageNum: 1, userName: undefined, status: undefined, roleId: undefined })
  void getList()
}

function filterByIdentity(identity: ResolvedIdentity): void {
  if (!identity.roleId) return
  queryParams.roleId = queryParams.roleId === identity.roleId ? undefined : identity.roleId
  handleQuery()
}

function selectIdentity(identity: ResolvedIdentity): void {
  if (!identity.roleId || identity.roleKey === 'admin') return
  form.roleIds = [identity.roleId]
  userFormRef.value?.validateField('roleIds').catch(() => undefined)
}

function resetForm(): void {
  Object.assign(form, emptyForm())
  userFormRef.value?.clearValidate()
}

function openCreate(): void {
  resetForm()
  const experience = identities.value.find((item) => item.roleKey === 'bge_portal_user')
  if (experience?.roleId) form.roleIds = [experience.roleId]
  editorTitle.value = '新增账号'
  editorOpen.value = true
}

async function openEdit(row: SysUser): Promise<void> {
  resetForm()
  try {
    const response = await getUser(row.userId)
    mergeRoles(response.roles)
    const currentIdentity = identities.value.find((identity) => identity.roleId === row.roleId && identity.roleKey !== 'admin')
    Object.assign(form, response.data ?? {}, {
      password: '',
      roleIds: currentIdentity?.roleId ? [currentIdentity.roleId] : [],
      postIds: response.postIds ?? []
    })
    editorTitle.value = `编辑账号 · ${row.userName}`
    editorOpen.value = true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '账号信息加载失败')
  }
}

function closeEditor(): void {
  editorOpen.value = false
}

async function saveAccount(): Promise<void> {
  const valid = await userFormRef.value?.validate().catch(() => false)
  if (!valid || selectedIdentity.value?.roleKey === 'admin') return
  saving.value = true
  try {
    if (form.userId === undefined) await addUser(form)
    else await updateUser(form)
    ElMessage.success(form.userId === undefined ? '账号已创建' : '账号已更新')
    editorOpen.value = false
    await getList()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '账号保存失败')
  } finally {
    saving.value = false
  }
}

async function changeStatus(row: SysUser): Promise<void> {
  if (!row.userId || row.userId === 1 || !row.status) return
  const enabling = row.status === '0'
  try {
    await ElMessageBox.confirm(
      `${enabling ? '启用' : '停用'}后${enabling ? '可以' : '将无法'}登录，确认继续吗？`,
      `${enabling ? '启用' : '停用'}「${row.userName}」`,
      { type: enabling ? 'success' : 'warning', confirmButtonText: '确认', cancelButtonText: '取消' }
    )
    await changeUserStatus(row.userId, row.status)
    ElMessage.success(enabling ? '账号已启用' : '账号已停用')
  } catch {
    row.status = enabling ? '1' : '0'
  }
}

async function resetPassword(row: SysUser): Promise<void> {
  if (!row.userId) return
  try {
    const result = await ElMessageBox.prompt('请输入 6–32 位新密码', `重置「${row.userName}」的密码`, {
      confirmButtonText: '确认重置', cancelButtonText: '取消', closeOnClickModal: false,
      inputType: 'password',
      inputValidator: (value: string) => {
        if (value.length < 6 || value.length > 32) return '密码长度必须为 6–32 位'
        if (!/^[^<>"'|\\]+$/.test(value)) return '密码包含不允许的字符'
        return true
      }
    })
    await resetUserPwd(row.userId, result.value)
    ElMessage.success('密码已重置')
  } catch {
    // User cancelled the prompt.
  }
}

async function removeAccount(row: SysUser): Promise<void> {
  if (!row.userId) return
  try {
    await ElMessageBox.confirm('删除后该账号不能再登录，历史任务和积分流水仍保留。', `删除「${row.userName}」`, {
      type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消'
    })
    await delUser(row.userId)
    ElMessage.success('账号已删除')
    await getList()
  } catch {
    // User cancelled the confirmation.
  }
}

onMounted(async () => {
  try {
    await loadRoles()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '账号等级加载失败')
  }
  await getList()
})
</script>

<style scoped lang="scss">
.account-page {
  min-height: calc(100vh - 84px);
  padding: 24px;
  background: #f5f7f6;
  color: #17231f;
  letter-spacing: 0;
}

.page-heading, .list-toolbar, .section-title, .group-label, .account-cell, .contact-cell {
  display: flex;
  align-items: center;
}

.page-heading { justify-content: space-between; gap: 20px; margin-bottom: 22px; }
.page-kicker { display: block; margin-bottom: 3px; color: #0f766e; font-size: 11px; font-weight: 700; }
h1, h2, p { margin: 0; }
h1 { font-size: 26px; line-height: 34px; }
h2 { font-size: 16px; line-height: 24px; }

.identity-section { padding: 18px 0 22px; border-top: 1px solid #dfe7e3; border-bottom: 1px solid #dfe7e3; }
.section-title { gap: 10px; }
.section-title span { color: #718078; font-size: 12px; }
.identity-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; margin-top: 14px; }
.identity-group { min-width: 0; }
.group-label { gap: 7px; margin-bottom: 9px; color: #42524a; font-size: 13px; font-weight: 600; }
.identity-row, .identity-picker { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }

.identity-summary, .identity-option {
  border: 1px solid #dce5e1;
  border-radius: 6px;
  background: #fff;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
}

.identity-summary { display: flex; align-items: center; min-width: 0; min-height: 58px; padding: 9px 10px; }
.identity-summary:hover, .identity-summary.is-active { border-color: #0f766e; box-shadow: 0 0 0 2px rgba(15, 118, 110, .1); }
.identity-level { flex: 0 0 28px; color: #0f766e; font-size: 11px; font-weight: 800; }
.identity-copy, .account-cell > span:last-child, .contact-cell { display: flex; min-width: 0; flex-direction: column; }
.identity-copy strong, .account-cell strong, .identity-option strong { overflow: hidden; font-size: 13px; line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
.identity-copy small, .account-cell small, .identity-option small, .contact-cell small { overflow: hidden; color: #7b8882; font-size: 11px; line-height: 17px; text-overflow: ellipsis; white-space: nowrap; }

.account-list { margin-top: 22px; }
.list-toolbar { justify-content: space-between; gap: 18px; margin-bottom: 12px; }
.filters { display: flex; align-items: center; justify-content: flex-end; flex: 1; gap: 8px; }
.search-input { width: min(300px, 34vw); }
.level-filter { width: 140px; }
.status-filter { width: 120px; }
.account-table { width: 100%; border-top: 1px solid #e2e8e5; }
.account-cell { gap: 10px; }

.avatar {
  display: grid;
  flex: 0 0 34px;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 6px;
  background: #e7f4ef;
  color: #0f766e;
  font-size: 14px;
  font-weight: 700;
}

.avatar--blue { background: #e9f0fb; color: #315d96; }
.avatar--gold { background: #fff2d6; color: #8a5d00; }
.avatar--gray { background: #edf0ef; color: #59645f; }
.avatar--teal { background: #dff3f1; color: #0b6a63; }
.avatar--ink { background: #27332f; color: #fff; }

.identity-badge {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 2px 8px;
  border: 1px solid #cfe4da;
  border-radius: 999px;
  background: #edf8f3;
  color: #19674e;
  font-size: 12px;
  font-weight: 600;
}

.identity-badge--blue { border-color: #d5e1f2; background: #f0f5fc; color: #315d96; }
.identity-badge--gold { border-color: #f1ddb0; background: #fff8e8; color: #8a5d00; }
.identity-badge--gray { border-color: #dfe3e1; background: #f4f6f5; color: #59645f; }
.identity-badge--teal { border-color: #badfd9; background: #e8f7f4; color: #0b6a63; }
.identity-badge--ink { border-color: #27332f; background: #27332f; color: #fff; }
.scope-copy { color: #56645d; font-size: 12px; }
.contact-cell { align-items: flex-start; }
.contact-cell span { font-size: 12px; line-height: 20px; }
.protected-icon { color: #87928d; font-size: 16px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.identity-picker { width: 100%; }

.identity-option {
  position: relative;
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) 18px;
  gap: 8px;
  min-height: 72px;
  padding: 11px;
  align-items: center;
}

.identity-option:hover:not(:disabled), .identity-option.is-selected { border-color: #0f766e; background: #f1faf7; box-shadow: 0 0 0 2px rgba(15, 118, 110, .1); }
.identity-option:disabled { cursor: not-allowed; opacity: .58; }
.identity-option > .el-icon:first-child { color: #0f766e; font-size: 20px; }
.identity-option > span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; }
.selected-mark { color: #0f766e; }
.built-in-mark { color: #69756f; font-size: 10px; }

@media (max-width: 1100px) {
  .identity-groups { grid-template-columns: 1fr; }
}

@media (max-width: 760px) {
  .account-page { padding: 16px; }
  .page-heading, .list-toolbar { align-items: stretch; flex-direction: column; }
  .filters { justify-content: flex-start; flex-wrap: wrap; }
  .search-input { width: 100%; }
  .identity-row, .identity-picker { grid-template-columns: 1fr; }
  .form-grid { grid-template-columns: 1fr; }
}
</style>
