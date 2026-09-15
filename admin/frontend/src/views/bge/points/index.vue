<template>
  <main class="app-container point-admin">
    <header class="page-heading">
      <div>
        <h2>积分运营</h2>
        <p>查看积分经营情况，处理充值、调账、结算与异常。</p>
      </div>
      <el-button icon="Refresh" :loading="loading" @click="refreshCurrent">刷新</el-button>
    </header>

    <section class="metric-strip" aria-label="积分经营概览">
      <div v-for="item in metrics" :key="item.label" class="metric-item">
        <span>{{ item.label }}</span>
        <strong :class="item.tone">{{ formatNumber(item.value) }}</strong>
        <small>{{ item.hint }}</small>
      </div>
    </section>

    <el-tabs v-model="activeTab" class="point-tabs" @tab-change="refreshCurrent">
      <el-tab-pane label="经营概览" name="overview">
        <section class="overview-grid">
          <div class="overview-block">
            <h3>待处理事项</h3>
            <button type="button" class="todo-row" @click="activeTab = 'recharges'">
              <span><el-icon><Wallet /></el-icon>待审核充值</span>
              <strong>{{ formatNumber(summary.pendingRechargeCount) }} 笔</strong>
            </button>
            <button type="button" class="todo-row" @click="activeTab = 'reconciliation'">
              <span><el-icon><Warning /></el-icon>需要核查的异常</span>
              <strong :class="{ danger: summary.anomalyCount > 0 }">{{ formatNumber(summary.anomalyCount) }} 项</strong>
            </button>
            <button type="button" class="todo-row" @click="activeTab = 'charges'">
              <span><el-icon><Timer /></el-icon>冻结中的生图任务</span>
              <strong>{{ formatNumber(summary.reservedChargeCount) }} 笔</strong>
            </button>
          </div>
          <div class="overview-block">
            <h3>当前运营规则</h3>
            <dl class="rules-list">
              <div><dt>新用户赠送</dt><dd>30 积分，仅发放一次</dd></div>
              <div><dt>充值方式</dt><dd>用户申请，后台人工审核</dd></div>
              <div><dt>任务计费</dt><dd>提交冻结，按实际交付结算</dd></div>
              <div><dt>失败处理</dt><dd>零交付全退，部分交付按比例退款</dd></div>
            </dl>
          </div>
        </section>
      </el-tab-pane>

      <el-tab-pane label="用户账户" name="accounts">
        <el-form :model="accountQuery" inline class="filter-row">
          <el-form-item label="用户"><el-input v-model="accountQuery.username" clearable placeholder="用户名或昵称" @keyup.enter="searchAccounts" /></el-form-item>
          <el-form-item><el-button type="primary" icon="Search" @click="searchAccounts">查询</el-button></el-form-item>
        </el-form>
        <el-table v-loading="loading" :data="accounts" stripe empty-text="暂无积分账户">
          <el-table-column prop="username" label="用户名" min-width="140" />
          <el-table-column prop="nickName" label="昵称" min-width="130" />
          <el-table-column prop="balance" label="可用积分" width="110" align="right">
            <template #default="scope"><strong class="balance">{{ formatNumber(scope.row.balance) }}</strong></template>
          </el-table-column>
          <el-table-column prop="lifetimeCredited" label="累计获得" width="110" align="right" />
          <el-table-column prop="lifetimeSpent" label="累计消耗" width="110" align="right" />
          <el-table-column prop="updatedAt" label="更新时间" min-width="170" />
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="scope"><el-button link type="primary" icon="EditPen" v-hasPermi="['bge:points:adjust']" @click="openAdjustment(scope.row)">调账</el-button></template>
          </el-table-column>
        </el-table>
        <pagination v-show="accountTotal > 0" v-model:page="accountQuery.pageNum" v-model:limit="accountQuery.pageSize" :total="accountTotal" @pagination="loadAccounts" />
      </el-tab-pane>

      <el-tab-pane label="积分流水" name="ledger">
        <el-form :model="ledgerQuery" inline class="filter-row">
          <el-form-item label="用户"><el-input v-model="ledgerQuery.username" clearable placeholder="用户名或昵称" /></el-form-item>
          <el-form-item label="类型">
            <el-select v-model="ledgerQuery.eventType" clearable placeholder="全部类型" style="width: 160px">
              <el-option v-for="item in eventOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="时间"><el-date-picker v-model="ledgerDates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" /></el-form-item>
          <el-form-item><el-button type="primary" icon="Search" @click="searchLedger">查询</el-button></el-form-item>
        </el-form>
        <el-table v-loading="loading" :data="ledger" stripe empty-text="暂无积分流水">
          <el-table-column prop="createdAt" label="时间" min-width="170" />
          <el-table-column prop="username" label="用户" min-width="130" />
          <el-table-column label="变化" width="100" align="right"><template #default="scope"><strong :class="scope.row.change >= 0 ? 'credit' : 'debit'">{{ signed(scope.row.change) }}</strong></template></el-table-column>
          <el-table-column prop="balanceAfter" label="变更后" width="100" align="right" />
          <el-table-column label="类型" min-width="130"><template #default="scope">{{ eventLabel(scope.row.eventType) }}</template></el-table-column>
          <el-table-column prop="description" label="原因" min-width="190" show-overflow-tooltip />
          <el-table-column prop="operatorName" label="操作人" min-width="110"><template #default="scope">{{ scope.row.operatorName || '系统' }}</template></el-table-column>
          <el-table-column prop="referenceKey" label="业务引用" min-width="210" show-overflow-tooltip />
        </el-table>
        <pagination v-show="ledgerTotal > 0" v-model:page="ledgerQuery.pageNum" v-model:limit="ledgerQuery.pageSize" :total="ledgerTotal" @pagination="loadLedger" />
      </el-tab-pane>

      <el-tab-pane label="任务结算" name="charges">
        <el-form :model="chargeQuery" inline class="filter-row">
          <el-form-item label="用户"><el-input v-model="chargeQuery.username" clearable placeholder="用户名或昵称" /></el-form-item>
          <el-form-item label="任务"><el-input v-model="chargeQuery.taskId" clearable placeholder="任务号" /></el-form-item>
          <el-form-item label="状态">
            <el-select v-model="chargeQuery.status" clearable placeholder="全部状态" style="width: 140px">
              <el-option label="冻结中" value="reserved" /><el-option label="已释放" value="released" /><el-option label="已结算" value="settled" />
            </el-select>
          </el-form-item>
          <el-form-item><el-button type="primary" icon="Search" @click="searchCharges">查询</el-button></el-form-item>
        </el-form>
        <el-table v-loading="loading" :data="charges" stripe empty-text="暂无任务结算">
          <el-table-column prop="taskId" label="任务号" min-width="190"><template #default="scope">{{ scope.row.taskId || '待绑定' }}</template></el-table-column>
          <el-table-column prop="username" label="用户" min-width="120" />
          <el-table-column label="套餐" min-width="150"><template #default="scope">{{ profileLabel(scope.row.profileId) }} / {{ scope.row.resolutionId.toUpperCase() }}</template></el-table-column>
          <el-table-column label="交付" width="90" align="center"><template #default="scope">{{ scope.row.deliveredImages }}/{{ scope.row.expectedImages }}</template></el-table-column>
          <el-table-column prop="quotedPoints" label="报价" width="80" align="right" />
          <el-table-column prop="reservedPoints" label="冻结" width="80" align="right" />
          <el-table-column prop="chargedPoints" label="实扣" width="80" align="right" />
          <el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="chargeTag(scope.row.status)">{{ chargeLabel(scope.row.status) }}</el-tag></template></el-table-column>
          <el-table-column prop="updatedAt" label="更新时间" min-width="170" />
        </el-table>
        <pagination v-show="chargeTotal > 0" v-model:page="chargeQuery.pageNum" v-model:limit="chargeQuery.pageSize" :total="chargeTotal" @pagination="loadCharges" />
      </el-tab-pane>

      <el-tab-pane name="recharges">
        <template #label>充值申请 <el-badge v-if="summary.pendingRechargeCount" :value="summary.pendingRechargeCount" /></template>
        <div class="filter-row segmented-row"><el-segmented v-model="rechargeQuery.status" :options="rechargeStatuses" @change="searchRecharges" /></div>
        <el-table v-loading="loading" :data="recharges" stripe empty-text="暂无充值申请">
          <el-table-column prop="requestedAt" label="申请时间" min-width="170" />
          <el-table-column prop="username" label="用户" min-width="130" />
          <el-table-column prop="points" label="申请积分" width="110" align="right" />
          <el-table-column prop="userNote" label="用户备注" min-width="170" show-overflow-tooltip />
          <el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="rechargeTag(scope.row.status)">{{ rechargeLabel(scope.row.status) }}</el-tag></template></el-table-column>
          <el-table-column prop="reviewerName" label="审核人" min-width="110"><template #default="scope">{{ scope.row.reviewerName || '-' }}</template></el-table-column>
          <el-table-column prop="reviewNote" label="审核说明" min-width="170" show-overflow-tooltip />
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="scope">
              <template v-if="scope.row.status === 'pending'">
                <el-button link type="success" icon="Check" v-hasPermi="['bge:points:recharge:review']" @click="review(scope.row, true)">通过</el-button>
                <el-button link type="danger" icon="Close" v-hasPermi="['bge:points:recharge:review']" @click="review(scope.row, false)">拒绝</el-button>
              </template>
              <span v-else>-</span>
            </template>
          </el-table-column>
        </el-table>
        <pagination v-show="rechargeTotal > 0" v-model:page="rechargeQuery.pageNum" v-model:limit="rechargeQuery.pageSize" :total="rechargeTotal" @pagination="loadRecharges" />
      </el-tab-pane>

      <el-tab-pane label="套餐价格" name="prices">
        <div class="section-toolbar">
          <p>价格整表保存并记录历史；已提交任务仍按下单快照结算。</p>
          <el-button type="primary" icon="Check" :loading="saving" v-hasPermi="['bge:points:price:manage']" @click="savePrices">保存全部价格</el-button>
        </div>
        <el-table v-loading="loading" :data="priceRows" stripe empty-text="暂无套餐价格">
          <el-table-column prop="profileLabel" label="套图" min-width="190" />
          <el-table-column prop="imageCount" label="图片数" width="90" align="center" />
          <el-table-column v-for="resolution in resolutions" :key="resolution.id" :label="resolution.label" min-width="170" align="center">
            <template #default="scope"><el-input-number v-model="scope.row.values[resolution.id]" :min="1" :max="100000" :step="1" controls-position="right" /></template>
          </el-table-column>
        </el-table>
        <h3 class="subheading">最近改价记录</h3>
        <el-table v-loading="loading" :data="priceHistory" stripe empty-text="暂无改价记录">
          <el-table-column prop="createdAt" label="时间" min-width="170" />
          <el-table-column label="套餐" min-width="160"><template #default="scope">{{ profileLabel(scope.row.profileId) }} / {{ scope.row.resolutionId.toUpperCase() }}</template></el-table-column>
          <el-table-column label="价格变化" width="130" align="center"><template #default="scope">{{ scope.row.oldPoints }} → {{ scope.row.newPoints }}</template></el-table-column>
          <el-table-column prop="reason" label="变更原因" min-width="220" show-overflow-tooltip />
          <el-table-column prop="operatorName" label="操作人" min-width="120" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane name="reconciliation">
        <template #label>异常对账 <el-badge v-if="summary.anomalyCount" :value="summary.anomalyCount" type="danger" /></template>
        <el-alert v-if="!anomalies.length && !loading" title="当前未发现积分账本异常" type="success" :closable="false" show-icon />
        <el-table v-else v-loading="loading" :data="anomalies" stripe empty-text="当前未发现异常">
          <el-table-column label="级别" width="90"><template #default="scope"><el-tag :type="scope.row.severity === 'critical' ? 'danger' : 'warning'">{{ scope.row.severity === 'critical' ? '严重' : '关注' }}</el-tag></template></el-table-column>
          <el-table-column prop="description" label="问题" min-width="230" />
          <el-table-column prop="username" label="用户" min-width="130" />
          <el-table-column prop="reference" label="业务引用" min-width="190" show-overflow-tooltip />
          <el-table-column prop="detectedAt" label="发现时间" min-width="170" />
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="adjustVisible" title="调整用户积分" width="min(460px, 92vw)">
      <el-descriptions v-if="adjustUser" :column="1" border>
        <el-descriptions-item label="用户">{{ adjustUser.username }}</el-descriptions-item>
        <el-descriptions-item label="当前余额">{{ formatNumber(adjustUser.balance) }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-position="top" class="adjust-form">
        <el-form-item label="积分变化"><el-input-number v-model="adjustForm.change" :min="-1000000" :max="1000000" :step="10" /></el-form-item>
        <el-form-item label="调账原因"><el-input v-model="adjustForm.note" maxlength="200" show-word-limit placeholder="至少 4 个字符，将写入积分流水" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitAdjustment">确认调账</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<script setup lang="ts" name="BgePoints">
import { computed, onMounted, reactive, ref } from 'vue'
import { Timer, Wallet, Warning } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  adjustPoints, getPointSummary, listPointAccounts, listPointAnomalies, listPointCharges,
  listPointLedger, listPointPrices, listPriceHistory, listRechargeRequests, reviewRecharge,
  updatePointPrices, type PointAccount, type PointAnomaly, type PointCharge, type PointLedger,
  type PointPrice, type PointSummary, type PriceHistory, type RechargeRequest
} from '@/api/bge/points'

interface PriceRow { profileId: string; profileLabel: string; imageCount: number; values: Record<string, number> }

const emptySummary: PointSummary = { accountCount: 0, totalBalance: 0, lifetimeCredited: 0, lifetimeSpent: 0, pendingRechargeCount: 0, pendingRechargePoints: 0, reservedChargeCount: 0, reservedPoints: 0, anomalyCount: 0 }
const activeTab = ref('overview')
const loading = ref(false)
const saving = ref(false)
const summary = reactive<PointSummary>({ ...emptySummary })
const accounts = ref<PointAccount[]>([])
const ledger = ref<PointLedger[]>([])
const charges = ref<PointCharge[]>([])
const recharges = ref<RechargeRequest[]>([])
const priceRows = ref<PriceRow[]>([])
const priceHistory = ref<PriceHistory[]>([])
const anomalies = ref<PointAnomaly[]>([])
const accountTotal = ref(0)
const ledgerTotal = ref(0)
const chargeTotal = ref(0)
const rechargeTotal = ref(0)
const accountQuery = reactive({ username: '', pageNum: 1, pageSize: 20 })
const ledgerQuery = reactive({ username: '', eventType: '', pageNum: 1, pageSize: 20 })
const chargeQuery = reactive({ username: '', taskId: '', status: '', pageNum: 1, pageSize: 20 })
const rechargeQuery = reactive({ status: 'pending', pageNum: 1, pageSize: 20 })
const ledgerDates = ref<string[]>([])
const adjustVisible = ref(false)
const adjustUser = ref<PointAccount | null>(null)
const adjustForm = reactive({ change: 0, note: '', idempotencyKey: '' })
const resolutions = [{ id: '1k', label: '1K 积分' }, { id: '2k', label: '2K 积分' }, { id: '4k', label: '4K 积分' }]
const rechargeStatuses = [{ label: '待审核', value: 'pending' }, { label: '全部', value: '' }, { label: '已通过', value: 'approved' }, { label: '已拒绝', value: 'rejected' }]
const eventOptions = [
  { label: '新用户赠送', value: 'welcome' }, { label: '生图冻结', value: 'generation_reserve' },
  { label: '补图冻结', value: 'generation_retry' }, { label: '冻结释放', value: 'generation_release' },
  { label: '生图退款', value: 'generation_refund' }, { label: '充值到账', value: 'recharge' },
  { label: '后台调账', value: 'admin_adjustment' }
]
const metrics = computed(() => [
  { label: '积分账户', value: summary.accountCount, hint: '已激活账户', tone: '' },
  { label: '流通余额', value: summary.totalBalance, hint: '用户可用积分', tone: '' },
  { label: '累计发放', value: summary.lifetimeCredited, hint: '赠送、充值与退款', tone: '' },
  { label: '累计消耗', value: summary.lifetimeSpent, hint: '实际结算积分', tone: '' },
  { label: '待审充值', value: summary.pendingRechargeCount, hint: `${formatNumber(summary.pendingRechargePoints)} 积分`, tone: summary.pendingRechargeCount ? 'attention' : '' },
  { label: '对账异常', value: summary.anomalyCount, hint: '需人工核查', tone: summary.anomalyCount ? 'danger' : '' }
])

function requestKey(prefix: string) { return `${prefix}-${Date.now()}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}` }
function formatNumber(value: number) { return new Intl.NumberFormat('zh-CN').format(value || 0) }
function signed(value: number) { return value > 0 ? `+${formatNumber(value)}` : formatNumber(value) }
function showError(error: unknown) { ElMessage.error(error instanceof Error ? error.message : '请求失败，请稍后重试。') }
function eventLabel(value: string) { return eventOptions.find((item) => item.value === value)?.label || value }
function profileLabel(value: string) { return ({ 'compact-1-2': '1 主图 + 2 详情', 'compact-2-3': '2 主图 + 3 详情', 'compact-3-4': '3 主图 + 4 详情', 'standard-5-8': '5 主图 + 8 详情' } as Record<string, string>)[value] || value }
function chargeLabel(value: string) { return value === 'reserved' ? '冻结中' : value === 'released' ? '已释放' : '已结算' }
function chargeTag(value: string) { return value === 'reserved' ? 'warning' : value === 'settled' ? 'success' : 'info' }
function rechargeLabel(value: string) { return value === 'pending' ? '待审核' : value === 'approved' ? '已通过' : '已拒绝' }
function rechargeTag(value: string) { return value === 'pending' ? 'warning' : value === 'approved' ? 'success' : 'info' }

async function loadSummary() { Object.assign(summary, await getPointSummary()) }
async function loadAccounts() { const data = await listPointAccounts(accountQuery); accounts.value = data.rows; accountTotal.value = data.total }
async function loadLedger() { const data = await listPointLedger({ ...ledgerQuery, from: ledgerDates.value?.[0] || '', to: ledgerDates.value?.[1] || '' }); ledger.value = data.rows; ledgerTotal.value = data.total }
async function loadCharges() { const data = await listPointCharges(chargeQuery); charges.value = data.rows; chargeTotal.value = data.total }
async function loadRecharges() { const data = await listRechargeRequests(rechargeQuery); recharges.value = data.rows; rechargeTotal.value = data.total }
async function loadPrices() {
  const [prices, history] = await Promise.all([listPointPrices(), listPriceHistory()])
  const rows = new Map<string, PriceRow>()
  prices.forEach((item: PointPrice) => {
    if (!rows.has(item.generationProfileId)) rows.set(item.generationProfileId, { profileId: item.generationProfileId, profileLabel: item.profileLabel, imageCount: item.imageCount, values: {} })
    rows.get(item.generationProfileId)!.values[item.imageResolutionId] = item.points
  })
  priceRows.value = [...rows.values()]
  priceHistory.value = history
}
async function loadAnomalies() { anomalies.value = await listPointAnomalies() }

async function refreshCurrent() {
  loading.value = true
  try {
    await loadSummary()
    if (activeTab.value === 'accounts') await loadAccounts()
    else if (activeTab.value === 'ledger') await loadLedger()
    else if (activeTab.value === 'charges') await loadCharges()
    else if (activeTab.value === 'recharges') await loadRecharges()
    else if (activeTab.value === 'prices') await loadPrices()
    else if (activeTab.value === 'reconciliation') await loadAnomalies()
  } catch (error) { showError(error) } finally { loading.value = false }
}

function searchAccounts() { accountQuery.pageNum = 1; void refreshCurrent() }
function searchLedger() { ledgerQuery.pageNum = 1; void refreshCurrent() }
function searchCharges() { chargeQuery.pageNum = 1; void refreshCurrent() }
function searchRecharges() { rechargeQuery.pageNum = 1; void refreshCurrent() }
function openAdjustment(user: PointAccount) { adjustUser.value = user; Object.assign(adjustForm, { change: 0, note: '', idempotencyKey: requestKey('adjust') }); adjustVisible.value = true }

async function submitAdjustment() {
  if (!adjustUser.value || adjustForm.change === 0) return ElMessage.warning('积分变化不能为 0')
  if (adjustForm.note.trim().length < 4) return ElMessage.warning('请填写至少 4 个字符的调账原因')
  saving.value = true
  try {
    await ElMessageBox.confirm(`确认将 ${adjustUser.value.username} 的积分调整 ${signed(adjustForm.change)}？`, '确认调账', { type: 'warning' })
    await adjustPoints(adjustUser.value.userId, adjustForm.change, adjustForm.note, adjustForm.idempotencyKey)
    ElMessage.success('积分调整已记入流水')
    adjustVisible.value = false
    await Promise.all([loadAccounts(), loadSummary()])
  } catch (error) { if (error !== 'cancel' && error !== 'close') showError(error) } finally { saving.value = false }
}

async function review(item: RechargeRequest, approve: boolean) {
  const action = approve ? '通过' : '拒绝'
  try {
    const { value } = await ElMessageBox.prompt(`${action} ${item.username} 的 ${item.points} 积分申请`, '充值审核', { inputPlaceholder: approve ? '审核说明（选填）' : '拒绝原因（至少 4 个字符）', inputValidator: (text: string) => approve || String(text || '').trim().length >= 4 || '拒绝时必须填写至少 4 个字符的原因', confirmButtonText: action, cancelButtonText: '取消' })
    await reviewRecharge(item.id, approve, String(value || ''))
    ElMessage.success(approve ? '积分已到账' : '申请已拒绝')
    await Promise.all([loadRecharges(), loadSummary()])
  } catch (error) { if (error !== 'cancel' && error !== 'close') showError(error) }
}

async function savePrices() {
  const prices = priceRows.value.flatMap((row) => resolutions.map((resolution) => ({ profileId: row.profileId, resolutionId: resolution.id, points: row.values[resolution.id] })))
  if (prices.length !== 12 || prices.some((item) => !Number.isInteger(item.points) || item.points < 1)) return ElMessage.warning('请填写完整且有效的 12 项套餐价格')
  try {
    const { value } = await ElMessageBox.prompt('本次将原子保存整张套餐价格表。', '保存套餐价格', { inputPlaceholder: '填写改价原因（至少 4 个字符）', inputValidator: (text: string) => String(text || '').trim().length >= 4 || '改价原因至少 4 个字符', confirmButtonText: '确认保存', cancelButtonText: '取消' })
    await ElMessageBox.confirm('新价格只影响后续任务，已提交任务仍按原报价结算。确认继续？', '确认价格生效范围', { type: 'warning' })
    saving.value = true
    await updatePointPrices({ idempotencyKey: requestKey('price'), reason: String(value), prices })
    ElMessage.success('12 项套餐价格已保存并记录历史')
    await loadPrices()
  } catch (error) { if (error !== 'cancel' && error !== 'close') showError(error) } finally { saving.value = false }
}

onMounted(() => { void refreshCurrent() })
</script>

<style scoped lang="scss">
.point-admin { min-height: calc(100vh - 84px); color: #17231f; letter-spacing: 0; }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.page-heading h2 { margin: 0; font-size: 22px; line-height: 30px; }
.page-heading p, .section-toolbar p { margin: 5px 0 0; color: #71807b; font-size: 13px; }
.metric-strip { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); margin-top: 20px; border: 1px solid #dce6e2; border-radius: 8px; background: #fff; }
.metric-item { min-width: 0; padding: 16px 18px; }
.metric-item + .metric-item { border-left: 1px solid #e6ece9; }
.metric-item span, .metric-item small, .metric-item strong { display: block; }
.metric-item span { color: #667670; font-size: 12px; }
.metric-item strong { margin-top: 5px; font-size: 22px; line-height: 28px; color: #17231f; }
.metric-item small { margin-top: 2px; color: #929d99; font-size: 11px; line-height: 17px; }
.metric-item .attention { color: #a65c12; }
.metric-item .danger, .danger { color: #c2413b; }
.point-tabs { margin-top: 20px; }
.overview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 36px; padding-top: 4px; }
.overview-block h3, .subheading { margin: 0 0 12px; font-size: 15px; line-height: 22px; }
.todo-row { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 48px; padding: 0 4px; border: 0; border-bottom: 1px solid #e6ece9; background: transparent; color: inherit; cursor: pointer; }
.todo-row:hover { color: #0f766e; }
.todo-row span { display: inline-flex; align-items: center; gap: 9px; }
.todo-row strong { font-size: 14px; }
.rules-list { margin: 0; }
.rules-list div { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 11px 4px; border-bottom: 1px solid #e6ece9; }
.rules-list dt { color: #667670; }
.rules-list dd { margin: 0; color: #273b34; }
.filter-row { margin-bottom: 14px; }
.filter-row :deep(.el-form-item) { margin-bottom: 8px; }
.segmented-row { overflow-x: auto; padding-bottom: 2px; }
.balance { color: #0f766e; font-size: 16px; }
.credit { color: #15803d; }
.debit { color: #c2413b; }
.section-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.section-toolbar p { margin: 0; }
.subheading { margin-top: 28px; padding-top: 20px; border-top: 1px solid #dce6e2; }
.adjust-form { margin-top: 18px; }
@media (max-width: 1180px) {
  .metric-strip { grid-template-columns: repeat(3, 1fr); }
  .metric-item:nth-child(4) { border-left: 0; }
  .metric-item:nth-child(n+4) { border-top: 1px solid #e6ece9; }
}
@media (max-width: 720px) {
  .point-admin { padding: 16px; }
  .page-heading p { max-width: 240px; }
  .metric-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metric-item { padding: 13px; }
  .metric-item:nth-child(odd) { border-left: 0; }
  .metric-item:nth-child(n+3) { border-top: 1px solid #e6ece9; }
  .metric-item strong { font-size: 19px; }
  .overview-grid { grid-template-columns: 1fr; gap: 28px; }
  .section-toolbar { align-items: flex-start; flex-direction: column; }
  .section-toolbar .el-button { width: 100%; }
  .rules-list div { grid-template-columns: 96px 1fr; }
}
</style>
