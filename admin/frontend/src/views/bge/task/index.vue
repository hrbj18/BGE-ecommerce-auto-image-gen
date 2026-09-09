<template>
  <div class="app-container bge-task-center">
    <el-card shadow="never" class="overview-card">
      <div class="page-heading">
        <div>
          <h2>生图任务中心</h2>
          <p>只读查看本机商品生图进度、安全事件和已完成图片。</p>
        </div>
        <div class="health-status" aria-live="polite">
          <span class="health-label">生图引擎</span>
          <el-tag :type="healthTagType" effect="light" round>
            {{ healthText }}
          </el-tag>
        </div>
      </div>

      <el-alert
        v-if="pageError"
        class="page-alert"
        type="error"
        :title="pageError"
        :closable="false"
        show-icon
      />

      <el-form :model="query" inline class="query-form">
        <el-form-item label="商品名">
          <el-input
            v-model="query.productName"
            placeholder="输入商品名称"
            clearable
            maxlength="120"
            @keyup.enter="handleQuery"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" placeholder="全部状态" clearable>
            <el-option
              v-for="option in statusOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" icon="Search" @click="handleQuery">查询</el-button>
          <el-button icon="Refresh" @click="resetQuery">重置筛选</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="task-card">
      <template #header>
        <div class="card-heading">
          <div>
            <span class="card-title">任务列表</span>
            <span class="task-count">共 {{ tasks.length }} 条</span>
          </div>
          <el-tag v-if="autoRefreshEnabled" type="primary" effect="plain" round>
            活动任务每 5 秒自动刷新
          </el-tag>
        </div>
      </template>

      <el-table
        v-if="tasks.length || listLoading"
        v-loading="listLoading"
        :data="tasks"
        row-key="id"
        stripe
      >
        <el-table-column label="商品" min-width="210">
          <template #default="scope">
            <div class="product-cell">
              <strong>{{ scope.row.productName || '未命名商品' }}</strong>
              <span>{{ scope.row.taskId || scope.row.id }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120" align="center">
          <template #default="scope">
            <el-tag :type="statusTagType(scope.row.status)" effect="light">
              {{ statusLabel(scope.row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="套图进度" min-width="230">
          <template #default="scope">
            <div class="suite-progress">
              <div class="progress-line">
                <span>主图 {{ progressCount(scope.row, 'main') }}/{{ progressLimit(scope.row, 'main') }}</span>
                <el-progress
                  :percentage="progressPercent(scope.row, 'main')"
                  :stroke-width="7"
                  :show-text="false"
                />
              </div>
              <div class="progress-line">
                <span>详情图 {{ progressCount(scope.row, 'detail') }}/{{ progressLimit(scope.row, 'detail') }}</span>
                <el-progress
                  :percentage="progressPercent(scope.row, 'detail')"
                  :stroke-width="7"
                  :show-text="false"
                  color="#67c23a"
                />
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="首图耗时" width="120" align="center">
          <template #default="scope">
            {{ firstPreviewText(scope.row) }}
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="180">
          <template #default="scope">
            {{ formatDateTime(scope.row.updatedAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right" align="center">
          <template #default="scope">
            <el-button
              link
              type="primary"
              icon="View"
              v-hasPermi="['bge:task:query']"
              @click="openDetail(scope.row)"
            >查看详情</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty
        v-else
        :description="emptyDescription"
        :image-size="110"
      />
    </el-card>

    <el-drawer
      v-model="detailVisible"
      title="任务详情"
      size="min(780px, 96vw)"
      destroy-on-close
      @closed="clearDetail"
    >
      <div v-loading="detailLoading" class="detail-content">
        <el-alert
          v-if="detailError"
          type="error"
          :title="detailError"
          :closable="false"
          show-icon
        />

        <template v-if="selectedTask">
          <div class="detail-heading">
            <div>
              <h3>{{ selectedTask.productName || '未命名商品' }}</h3>
              <span>{{ selectedTask.taskId || selectedTask.id }}</span>
            </div>
            <el-tag :type="statusTagType(selectedTask.status)" effect="light">
              {{ statusLabel(selectedTask.status) }}
            </el-tag>
          </div>

          <el-alert
            v-if="selectedTask.message"
            class="detail-message"
            type="info"
            :title="selectedTask.message"
            :closable="false"
            show-icon
          />

          <section class="detail-section">
            <h4>基本信息</h4>
            <el-descriptions :column="2" border>
              <el-descriptions-item label="目标平台">
                {{ selectedTask.targetPlatform || '未记录' }}
              </el-descriptions-item>
              <el-descriptions-item label="输出语言">
                {{ selectedTask.outputLanguage || '未记录' }}
              </el-descriptions-item>
              <el-descriptions-item label="套图比例">
                {{ selectedTask.suiteRatio || '未记录' }}
              </el-descriptions-item>
              <el-descriptions-item label="参考图">
                {{ selectedTask.referenceCount ?? 0 }} 张
              </el-descriptions-item>
              <el-descriptions-item label="提交时间">
                {{ selectedTask.submittedAtLocal || formatDateTime(selectedTask.createdAt) }}
              </el-descriptions-item>
              <el-descriptions-item label="更新时间">
                {{ formatDateTime(selectedTask.updatedAt) }}
              </el-descriptions-item>
            </el-descriptions>
          </section>

          <section class="detail-section">
            <h4>{{ suiteProgressLabel(selectedTask) }}</h4>
            <div class="progress-panels">
              <div class="progress-panel">
                <span>主图</span>
                <strong>{{ progressCount(selectedTask, 'main') }} / {{ progressLimit(selectedTask, 'main') }}</strong>
                <el-progress :percentage="progressPercent(selectedTask, 'main')" />
              </div>
              <div class="progress-panel">
                <span>详情图</span>
                <strong>{{ progressCount(selectedTask, 'detail') }} / {{ progressLimit(selectedTask, 'detail') }}</strong>
                <el-progress
                  :percentage="progressPercent(selectedTask, 'detail')"
                  color="#67c23a"
                />
              </div>
              <div class="metric-panel">
                <span>首图耗时</span>
                <strong>{{ firstPreviewText(selectedTask) }}</strong>
              </div>
            </div>
          </section>

          <section class="detail-section">
            <div class="section-heading">
              <h4>安全事件</h4>
              <span>仅显示后端已裁剪的事件摘要</span>
            </div>
            <el-timeline v-if="detailEvents.length" class="event-timeline">
              <el-timeline-item
                v-for="event in detailEvents"
                :key="event.id"
                :timestamp="formatDateTime(event.createdAt)"
                placement="top"
              >
                <div class="event-card">
                  <strong>{{ event.type || '任务事件' }}</strong>
                  <p>{{ event.message || '无详细信息' }}</p>
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else description="暂无可展示的事件" :image-size="80" />
          </section>

          <section v-hasPermi="['bge:output:view']" class="detail-section">
            <div class="section-heading">
              <h4>成品缩略图</h4>
              <span>图片通过若依鉴权代理读取</span>
            </div>

            <el-alert
              v-if="outputError"
              type="warning"
              :title="outputError"
              :closable="false"
              show-icon
            />
            <el-alert
              v-if="blockedAssetCount"
              type="warning"
              :title="`已拦截 ${blockedAssetCount} 个不符合鉴权代理规则的图片地址。`"
              :closable="false"
              show-icon
            />

            <template v-if="assetGroups.length">
              <div v-for="group in assetGroups" :key="group.key" class="asset-group">
                <h5>{{ group.title }} <span>{{ group.assets.length }} 张</span></h5>
                <div class="asset-grid">
                  <figure v-for="asset in group.assets" :key="asset.url" class="asset-card">
                    <AuthenticatedImage :src="asset.url" :alt="asset.name" />
                    <figcaption :title="asset.name">{{ asset.name }}</figcaption>
                  </figure>
                </div>
              </div>
            </template>
            <el-empty v-else description="该任务暂无可展示的成品图" :image-size="90" />
          </section>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts" name="BgeTaskCenter">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import AuthenticatedImage from './AuthenticatedImage.vue'
import {
  getBgeHealth,
  getBgeOutput,
  getBgeTask,
  isBgeAssetUrl,
  listBgeTasks
} from '../../../api/bge/task'
import type {
  BgeAsset,
  BgeHealth,
  BgeOutput,
  BgeTask,
  BgeTaskEvent
} from '../../../api/bge/task'

type StatusTagType = 'primary' | 'success' | 'warning' | 'info' | 'danger'
type ProgressGroup = 'main' | 'detail'

interface AssetGroup {
  key: string
  title: string
  assets: BgeAsset[]
}

const POLL_INTERVAL_MS = 5000
const activeStatuses = new Set([
  'receiving',
  'submitting',
  'queued',
  'running',
  'canceling',
  'planning',
  'generating',
  'generating-main',
  'generating-detail',
  'recovering'
])

const statusOptions = [
  { label: '接收中', value: 'receiving' },
  { label: '提交中', value: 'submitting' },
  { label: '排队中', value: 'queued' },
  { label: '生成中', value: 'running' },
  { label: '已完成', value: 'done' },
  { label: '部分完成', value: 'partial' },
  { label: '已取消', value: 'cancelled' },
  { label: '失败', value: 'failed' },
  { label: '已中断', value: 'interrupted' }
]

const query = reactive({
  productName: '',
  status: ''
})
const tasks = ref<BgeTask[]>([])
const activeJobId = ref<string | null>(null)
const activePhase = ref('idle')
const listLoading = ref(false)
const pageError = ref('')
const health = ref<BgeHealth | null>(null)
const healthLoaded = ref(false)
const healthError = ref('')
const detailVisible = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const outputError = ref('')
const selectedTask = ref<BgeTask | null>(null)
const selectedOutput = ref<BgeOutput | null>(null)
let listRequestSequence = 0
let detailRequestSequence = 0
let pollTimer: ReturnType<typeof setTimeout> | null = null
let disposed = false

const autoRefreshEnabled = computed(() => Boolean(
  !pageError.value && (
    activeJobId.value ||
    activePhase.value !== 'idle' ||
    tasks.value.some((task) => isActiveTask(task))
  )
))

const healthText = computed(() => {
  if (healthError.value) return '连接异常'
  if (!healthLoaded.value) return '正在检查'
  if (!isHealthAvailable(health.value)) return '暂不可用'
  return '运行正常'
})

const healthTagType = computed<StatusTagType>(() => {
  if (!healthLoaded.value) return 'info'
  return isHealthAvailable(health.value) && !healthError.value ? 'success' : 'danger'
})

const emptyDescription = computed(() => {
  if (pageError.value) return '生图引擎当前无法返回任务数据'
  if (query.productName || query.status) return '没有符合筛选条件的任务'
  return '还没有可查看的生图任务'
})

const detailEvents = computed<BgeTaskEvent[]>(() => {
  const events = selectedTask.value?.events || []
  if (events.length) return [...events].reverse()
  return selectedTask.value?.latestEvent ? [selectedTask.value.latestEvent] : []
})

const allOutputAssets = computed<BgeAsset[]>(() => {
  const files = selectedOutput.value?.files || selectedTask.value?.output?.files
  if (!files) return []
  const overview = [
    files.mainOverview ? { name: '主图总览', url: files.mainOverview } : null,
    files.detailOverview ? { name: '详情图总览', url: files.detailOverview } : null,
    files.longDetail ? { name: '详情页完整长图', url: files.longDetail } : null
  ].filter((asset): asset is BgeAsset => Boolean(asset))
  return [...(files.main || []), ...(files.detail || []), ...overview]
})

const blockedAssetCount = computed(() => allOutputAssets.value.filter((asset) => !isBgeAssetUrl(asset.url)).length)

const assetGroups = computed<AssetGroup[]>(() => {
  const files = selectedOutput.value?.files || selectedTask.value?.output?.files
  if (!files) return []
  const groups: AssetGroup[] = [
    { key: 'main', title: '主图', assets: safeAssets(files.main || []) },
    { key: 'detail', title: '详情图', assets: safeAssets(files.detail || []) },
    {
      key: 'overview',
      title: '总览图',
      assets: safeAssets([
        ...(files.mainOverview ? [{ name: '主图总览', url: files.mainOverview }] : []),
        ...(files.detailOverview ? [{ name: '详情图总览', url: files.detailOverview }] : []),
        ...(files.longDetail ? [{ name: '详情页完整长图', url: files.longDetail }] : [])
      ])
    }
  ]
  return groups.filter((group) => group.assets.length)
})

function safeAssets(assets: BgeAsset[]): BgeAsset[] {
  return assets.filter((asset) => Boolean(asset?.name) && isBgeAssetUrl(asset.url))
}

function isHealthAvailable(value: BgeHealth | null): boolean {
  if (!value || value.upstreamAvailable === false) return false
  const state = String(value.state || value.status || '').toLowerCase()
  return !['degraded', 'down', 'offline', 'unavailable', 'failed', 'error'].includes(state)
}

function isActiveTask(task: BgeTask): boolean {
  const status = String(task.status || '').toLowerCase()
  const stage = String(task.progress?.stage || '').toLowerCase()
  return activeStatuses.has(status) || activeStatuses.has(stage)
}

function statusLabel(status?: string): string {
  const labels: Record<string, string> = {
    receiving: '接收中',
    submitting: '提交中',
    queued: '排队中',
    running: '生成中',
    canceling: '取消中',
    planning: '规划中',
    generating: '生成中',
    'generating-main': '生成主图',
    'generating-detail': '生成详情图',
    recovering: '恢复中',
    done: '已完成',
    completed: '已完成',
    '已完成': '已完成',
    partial: '部分完成',
    cancelled: '已取消',
    canceled: '已取消',
    failed: '失败',
    error: '失败',
    interrupted: '已中断'
  }
  const normalized = String(status || '').toLowerCase()
  return labels[normalized] || status || '未知'
}

function statusTagType(status?: string): StatusTagType {
  const normalized = String(status || '').toLowerCase()
  if (['done', 'completed', '已完成'].includes(normalized)) return 'success'
  if (['failed', 'error', 'interrupted'].includes(normalized)) return 'danger'
  if (['partial', 'canceling'].includes(normalized)) return 'warning'
  if (['cancelled', 'canceled'].includes(normalized)) return 'info'
  return isActiveTask({ id: '', productName: '', status: normalized }) ? 'primary' : 'info'
}

function progressCount(task: BgeTask, group: ProgressGroup): number {
  const limit = progressLimit(task, group)
  const value = group === 'main' ? task.progress?.mainCompleted : task.progress?.detailCompleted
  const parsed = Number(value || 0)
  return Math.min(limit, Math.max(0, Number.isFinite(parsed) ? Math.floor(parsed) : 0))
}

function progressPercent(task: BgeTask, group: ProgressGroup): number {
  const limit = progressLimit(task, group)
  return Math.round((progressCount(task, group) / limit) * 100)
}

function progressLimit(task: BgeTask, group: ProgressGroup): number {
  const fallback = group === 'main' ? 5 : 8
  const value = group === 'main' ? task.mainImageCount : task.detailImageCount
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > fallback) return fallback
  return Math.floor(parsed)
}

function suiteProgressLabel(task: BgeTask): string {
  return `${progressLimit(task, 'main')} + ${progressLimit(task, 'detail')} 生成进度`
}

function firstPreviewText(task: BgeTask): string {
  const milliseconds = Number(task.timing?.firstPreviewElapsedMs || task.progress?.firstPreviewElapsedMs || 0)
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '尚未产生'
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`
  const seconds = milliseconds / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
}

function formatDateTime(value?: string): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date)
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    if (/network error|timeout|status code/i.test(error.message)) return fallback
    return error.message
  }
  if (typeof error === 'string' && error && error !== 'error') return error
  return fallback
}

async function loadHealth() {
  try {
    const response = await getBgeHealth()
    health.value = response.data
    healthError.value = ''
  } catch (error) {
    health.value = null
    healthError.value = errorText(error, '无法连接生图引擎。')
  } finally {
    healthLoaded.value = true
  }
}

async function loadTasks(silent = false) {
  const sequence = ++listRequestSequence
  if (!silent) listLoading.value = true
  try {
    const response = await listBgeTasks({
      productName: query.productName.trim() || undefined,
      status: query.status || undefined
    })
    if (sequence !== listRequestSequence || disposed) return
    tasks.value = Array.isArray(response.data?.tasks) ? response.data.tasks : []
    activeJobId.value = response.data?.activeJobId || null
    activePhase.value = response.data?.activePhase || 'idle'
    pageError.value = ''
  } catch (error) {
    if (sequence !== listRequestSequence || disposed) return
    pageError.value = errorText(error, '生图引擎当前不可用，请确认 Node 服务已启动。')
  } finally {
    if (sequence === listRequestSequence) listLoading.value = false
  }
}

async function refreshOverview(silent = false) {
  await Promise.all([loadHealth(), loadTasks(silent)])
}

async function loadSelectedTask(taskId: string, silent = false) {
  const sequence = ++detailRequestSequence
  if (!silent) detailLoading.value = true
  detailError.value = ''
  outputError.value = ''
  try {
    const response = await getBgeTask(taskId)
    if (sequence !== detailRequestSequence || disposed || !detailVisible.value) return
    selectedTask.value = response.data
    selectedOutput.value = response.data.output || null
    const outputId = response.data.outputId || response.data.output?.id
    if (outputId && response.data.hasOutput !== false) {
      try {
        const outputResponse = await getBgeOutput(outputId)
        if (sequence === detailRequestSequence && !disposed && detailVisible.value) {
          selectedOutput.value = outputResponse.data
        }
      } catch (error) {
        if (sequence === detailRequestSequence) {
          outputError.value = errorText(error, '成品图暂时无法读取。')
        }
      }
    }
  } catch (error) {
    if (sequence === detailRequestSequence) {
      detailError.value = errorText(error, '任务详情暂时无法读取。')
    }
  } finally {
    if (sequence === detailRequestSequence) detailLoading.value = false
  }
}

function openDetail(task: BgeTask) {
  selectedTask.value = task
  selectedOutput.value = task.output || null
  detailVisible.value = true
  void loadSelectedTask(task.id)
}

function clearDetail() {
  detailRequestSequence += 1
  selectedTask.value = null
  selectedOutput.value = null
  detailError.value = ''
  outputError.value = ''
  detailLoading.value = false
}

async function handleQuery() {
  clearPollTimer()
  await refreshOverview()
  schedulePoll()
}

async function resetQuery() {
  query.productName = ''
  query.status = ''
  await handleQuery()
}

function clearPollTimer() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function schedulePoll() {
  clearPollTimer()
  if (disposed || document.hidden || !autoRefreshEnabled.value) return
  pollTimer = setTimeout(async () => {
    pollTimer = null
    await refreshOverview(true)
    if (detailVisible.value && selectedTask.value && isActiveTask(selectedTask.value)) {
      await loadSelectedTask(selectedTask.value.id, true)
    }
    schedulePoll()
  }, POLL_INTERVAL_MS)
}

function handleVisibilityChange() {
  if (document.hidden) {
    clearPollTimer()
    return
  }
  void refreshOverview(true).finally(schedulePoll)
}

watch(autoRefreshEnabled, schedulePoll)

onMounted(async () => {
  disposed = false
  document.addEventListener('visibilitychange', handleVisibilityChange)
  await refreshOverview()
  schedulePoll()
})

onBeforeUnmount(() => {
  disposed = true
  listRequestSequence += 1
  detailRequestSequence += 1
  clearPollTimer()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<style scoped lang="scss">
.bge-task-center {
  min-height: calc(100vh - 84px);
  background: var(--el-bg-color-page);
}

.overview-card,
.task-card {
  border-radius: 10px;
}

.task-card {
  margin-top: 16px;
}

.page-heading,
.card-heading,
.detail-heading,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.page-heading h2,
.detail-heading h3,
.detail-section h4,
.asset-group h5 {
  margin: 0;
  color: var(--el-text-color-primary);
}

.page-heading h2 {
  font-size: 22px;
}

.page-heading p {
  margin: 8px 0 0;
  color: var(--el-text-color-secondary);
}

.health-status {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}

.health-label,
.task-count,
.section-heading span,
.asset-group h5 span {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  font-weight: 400;
}

.page-alert {
  margin-top: 16px;
}

.query-form {
  margin-top: 20px;
}

.query-form :deep(.el-form-item) {
  margin-bottom: 0;
}

.query-form :deep(.el-input) {
  width: 250px;
}

.query-form :deep(.el-select) {
  width: 170px;
}

.card-title {
  margin-right: 10px;
  font-weight: 600;
}

.product-cell {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.product-cell strong,
.product-cell span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-cell span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.suite-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.progress-line {
  display: grid;
  grid-template-columns: 86px minmax(80px, 1fr);
  align-items: center;
  gap: 10px;
  color: var(--el-text-color-regular);
  font-size: 13px;
}

.detail-content {
  min-height: 240px;
}

.detail-heading {
  margin-bottom: 14px;
}

.detail-heading h3 {
  font-size: 20px;
}

.detail-heading span {
  display: inline-block;
  margin-top: 5px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.detail-message {
  margin-bottom: 18px;
}

.detail-section {
  margin-top: 24px;
}

.detail-section h4 {
  margin-bottom: 12px;
  font-size: 16px;
}

.section-heading {
  align-items: baseline;
  margin-bottom: 12px;
}

.section-heading h4 {
  margin-bottom: 0;
}

.progress-panels {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.progress-panel,
.metric-panel {
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-blank);
}

.progress-panel span,
.metric-panel span {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.progress-panel strong,
.metric-panel strong {
  display: block;
  margin: 8px 0;
  font-size: 20px;
}

.event-timeline {
  padding-left: 6px;
}

.event-card {
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 7px;
  background: var(--el-fill-color-light);
}

.event-card p {
  margin: 6px 0 0;
  color: var(--el-text-color-regular);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.asset-group {
  margin-top: 18px;
}

.asset-group h5 {
  margin-bottom: 10px;
  font-size: 14px;
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.asset-card {
  min-width: 0;
  margin: 0;
}

.asset-card figcaption {
  margin-top: 6px;
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 760px) {
  .page-heading,
  .card-heading,
  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .query-form :deep(.el-form-item),
  .query-form :deep(.el-input),
  .query-form :deep(.el-select) {
    width: 100%;
  }

  .progress-panels {
    grid-template-columns: 1fr;
  }

  .asset-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
