<template>
  <main class="home app-container">
    <section class="welcome-band">
      <div class="brand-copy">
        <img :src="brandMark" alt="海客" class="brand-mark" />
        <div>
          <span class="brand-kicker">HAIKE COMMERCE AI</span>
          <h1>海客电商生图管理后台</h1>
          <p>今天是 {{ today }}，欢迎回来。</p>
        </div>
      </div>
      <div class="brand-status">
        <span class="status-dot" aria-hidden="true"></span>
        管理服务
      </div>
    </section>

    <section class="workspace" aria-labelledby="workspace-title">
      <div class="section-heading">
        <div>
          <span class="section-kicker">WORKSPACE</span>
          <h2 id="workspace-title">快捷入口</h2>
        </div>
      </div>

      <div class="action-grid">
        <button
          v-for="item in visibleActions"
          :key="item.title"
          type="button"
          class="action-item"
          @click="openAction(item)"
        >
          <span class="action-icon" :class="`action-icon--${item.tone}`">
            <el-icon><component :is="item.icon" /></el-icon>
          </span>
          <span class="action-label">
            <strong>{{ item.title }}</strong>
            <small>{{ item.caption }}</small>
          </span>
          <el-icon class="action-arrow"><ArrowRight /></el-icon>
        </button>
        <p v-if="!visibleActions.length" class="empty-actions">当前账号暂无业务入口，请联系管理员分配权限。</p>
      </div>
    </section>

    <section class="system-strip" aria-label="平台能力">
      <div v-for="item in capabilities" :key="item.label" class="capability">
        <el-icon><component :is="item.icon" /></el-icon>
        <div>
          <strong>{{ item.value }}</strong>
          <span>{{ item.label }}</span>
        </div>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts" name="Index">
import { computed } from 'vue'
import { ArrowRight, Coin, Connection, Finished, List, MagicStick, UserFilled } from '@element-plus/icons-vue'
import brandMark from '@/assets/logo/haike-mark.svg'
import useUserStore from '@/store/modules/user'

interface HomeAction {
  title: string
  caption: string
  to: string
  external?: boolean
  permission: string
  tone: 'teal' | 'blue' | 'amber' | 'gray'
  icon: typeof MagicStick
}

const router = useRouter()
const userStore = useUserStore()
const today = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long'
}).format(new Date())

const actions: HomeAction[] = [
  { title: '电商作图', caption: '进入工作台', to: '/workbench/', external: true, permission: 'bge:workbench:use', tone: 'teal', icon: MagicStick },
  { title: '任务中心', caption: '查看生成任务', to: '/bge/task', permission: 'bge:task:list', tone: 'blue', icon: List },
  { title: '积分管理', caption: '积分与充值', to: '/bge/points', permission: 'bge:points:list', tone: 'amber', icon: Coin },
  { title: '账号管理', caption: '用户与管理员', to: '/system/user', permission: 'system:user:list', tone: 'gray', icon: UserFilled }
]

const visibleActions = computed(() => actions.filter((item) =>
  userStore.permissions.includes('*:*:*') || userStore.permissions.includes(item.permission)
))

const capabilities = [
  { value: 'AI', label: '智能生图', icon: MagicStick },
  { value: '10', label: '多语言适配', icon: Connection },
  { value: '1K - 4K', label: '分辨率支持', icon: Finished }
]

function openAction(item: HomeAction): void {
  if (item.external) {
    window.location.href = item.to
    return
  }
  router.push(item.to)
}
</script>

<style scoped lang="scss">
.home {
  min-height: calc(100vh - 84px);
  padding: 24px;
  background: #f4f7f6;
  color: #17231f;
  letter-spacing: 0;
}

.welcome-band {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 164px;
  padding: 30px 34px;
  box-sizing: border-box;
  border-radius: 8px;
  background: #132824;
  color: #fff;
  box-shadow: 0 12px 28px rgba(18, 50, 44, 0.12);
}

.brand-copy {
  display: flex;
  align-items: center;
  gap: 20px;
  min-width: 0;

  .brand-mark {
    width: 70px;
    height: 70px;
    flex: 0 0 70px;
    border-radius: 8px;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
  }

  h1 {
    margin: 5px 0 7px;
    font-size: 28px;
    line-height: 38px;
    font-weight: 700;
    letter-spacing: 0;
  }

  p {
    margin: 0;
    color: #b8cfca;
    font-size: 14px;
    line-height: 22px;
  }
}

.brand-kicker,
.section-kicker {
  display: block;
  color: #65cdbf;
  font-size: 11px;
  line-height: 16px;
  font-weight: 700;
  letter-spacing: 0;
}

.brand-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 8px 11px;
  border: 1px solid rgba(125, 211, 199, 0.25);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: #d9e8e5;
  font-size: 13px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #5eead4;
  box-shadow: 0 0 0 3px rgba(94, 234, 212, 0.12);
}

.workspace {
  margin-top: 28px;
}

.section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 14px;

  h2 {
    margin: 3px 0 0;
    color: #17231f;
    font-size: 19px;
    line-height: 28px;
    font-weight: 700;
    letter-spacing: 0;
  }

  .section-kicker {
    color: #678079;
  }
}

.action-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.empty-actions {
  grid-column: 1 / -1;
  margin: 0;
  padding: 24px 0;
  color: #7d8985;
}

.action-item {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 88px;
  padding: 17px;
  border: 1px solid #dfe7e4;
  border-radius: 8px;
  background: #fff;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;

  &:hover,
  &:focus-visible {
    border-color: #80b9af;
    box-shadow: 0 10px 24px rgba(32, 71, 64, 0.09);
    transform: translateY(-2px);
    outline: none;
  }
}

.action-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  border-radius: 7px;
  font-size: 22px;

  &--teal { background: #dff5f0; color: #0f766e; }
  &--blue { background: #e8f0fb; color: #2563a5; }
  &--amber { background: #fbefd7; color: #a55a13; }
  &--gray { background: #ecefed; color: #4b5a55; }
}

.action-label {
  display: block;
  min-width: 0;
  margin-left: 13px;

  strong,
  small {
    display: block;
    letter-spacing: 0;
  }

  strong {
    color: #1b2924;
    font-size: 15px;
    line-height: 22px;
  }

  small {
    margin-top: 2px;
    color: #7d8985;
    font-size: 12px;
    line-height: 18px;
  }
}

.action-arrow {
  flex: 0 0 auto;
  margin-left: auto;
  color: #9aa7a3;
}

.system-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 28px;
  padding: 20px 0;
  border-top: 1px solid #dbe4e1;
  border-bottom: 1px solid #dbe4e1;
}

.capability {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-width: 0;
  color: #587069;

  & + & {
    border-left: 1px solid #dbe4e1;
  }

  > .el-icon {
    font-size: 24px;
    color: #0f766e;
  }

  strong,
  span {
    display: block;
    letter-spacing: 0;
  }

  strong {
    color: #1e302a;
    font-size: 17px;
    line-height: 24px;
  }

  span {
    font-size: 12px;
    line-height: 18px;
  }
}

html.dark .home {
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);

  .welcome-band { background: #0b1815; }
  .section-heading h2 { color: var(--el-text-color-primary); }
  .action-item { background: var(--el-bg-color-overlay); border-color: var(--el-border-color); }
  .action-label strong { color: var(--el-text-color-primary); }
  .system-strip, .capability + .capability { border-color: var(--el-border-color); }
  .capability strong { color: var(--el-text-color-primary); }
}

@media (max-width: 1100px) {
  .action-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 700px) {
  .home { padding: 16px; }
  .welcome-band { align-items: flex-start; padding: 24px; }
  .brand-copy { align-items: flex-start; gap: 14px; }
  .brand-copy .brand-mark { width: 52px; height: 52px; flex-basis: 52px; }
  .brand-copy h1 { font-size: 22px; line-height: 30px; }
  .brand-status { display: none; }
  .action-grid { grid-template-columns: 1fr; }
  .system-strip { grid-template-columns: 1fr; padding: 0; }
  .capability { justify-content: flex-start; padding: 15px 6px; }
  .capability + .capability { border-left: 0; border-top: 1px solid #dbe4e1; }
}
</style>
