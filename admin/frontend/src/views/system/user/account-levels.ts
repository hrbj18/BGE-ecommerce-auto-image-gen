export type AccountKind = 'customer' | 'administrator'
export type AccountTone = 'mint' | 'blue' | 'gold' | 'gray' | 'teal' | 'ink'

export interface AccountLevel {
  roleKey: string
  label: string
  level: string
  kind: AccountKind
  tone: AccountTone
  shortDescription: string
  description: string
  fixedRoleId?: number
}

export const ACCOUNT_LEVELS: readonly AccountLevel[] = [
  { roleKey: 'bge_portal_user', label: '体验用户', level: 'U1', kind: 'customer', tone: 'mint', shortDescription: '新注册账号', description: '登录用户端、使用积分生图' },
  { roleKey: 'bge_customer', label: '标准用户', level: 'U2', kind: 'customer', tone: 'blue', shortDescription: '正式使用客户', description: '登录用户端、使用积分生图' },
  { roleKey: 'bge_priority_customer', label: '重点用户', level: 'U3', kind: 'customer', tone: 'gold', shortDescription: '重点服务客户', description: '登录用户端、使用积分生图' },
  { roleKey: 'bge_viewer', label: '只读管理员', level: 'A1', kind: 'administrator', tone: 'gray', shortDescription: '只查看不修改', description: '查看任务、成品和积分记录' },
  { roleKey: 'bge_operator', label: '运营管理员', level: 'A2', kind: 'administrator', tone: 'teal', shortDescription: '负责日常运营', description: '作图、补图、调账和充值审核' },
  { roleKey: 'admin', label: '超级管理员', level: 'A3', kind: 'administrator', tone: 'ink', shortDescription: '管理全部功能', description: '账号、价格和全部系统权限', fixedRoleId: 1 }
]

export const ASSIGNABLE_ACCOUNT_ROLE_KEYS = ACCOUNT_LEVELS
  .filter((item) => item.roleKey !== 'admin')
  .map((item) => item.roleKey)
