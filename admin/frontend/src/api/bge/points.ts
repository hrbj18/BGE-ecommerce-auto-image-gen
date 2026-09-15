import axios, { type AxiosError, type AxiosRequestConfig } from 'axios'
import { getToken } from '@/utils/auth'

const pointRequest = axios.create({
  baseURL: import.meta.env.VITE_APP_BASE_API,
  timeout: 10000
})

pointRequest.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.set('Authorization', `Bearer ${token}`)
  return config
})

export interface PointSummary {
  accountCount: number
  totalBalance: number
  lifetimeCredited: number
  lifetimeSpent: number
  pendingRechargeCount: number
  pendingRechargePoints: number
  reservedChargeCount: number
  reservedPoints: number
  anomalyCount: number
}

export interface PointAccount {
  userId: number
  username: string
  nickName: string
  balance: number
  lifetimeCredited: number
  lifetimeSpent: number
  updatedAt: string
}

export interface PointPrice {
  generationProfileId: string
  profileLabel: string
  imageCount: number
  imageResolutionId: string
  resolutionLabel: string
  points: number
}

export interface PointLedger {
  id: number
  userId: number
  username: string
  nickName: string
  change: number
  balanceAfter: number
  eventType: string
  referenceKey: string
  description: string
  operatorName: string
  createdAt: string
}

export interface PointCharge {
  id: number
  userId: number
  username: string
  nickName: string
  taskId: string
  profileId: string
  resolutionId: string
  expectedImages: number
  quotedPoints: number
  reservedPoints: number
  chargedPoints: number
  deliveredImages: number
  status: string
  updatedAt: string
  settledAt: string
}

export interface RechargeRequest {
  id: number
  userId: number
  username: string
  nickName: string
  points: number
  status: 'pending' | 'approved' | 'rejected'
  userNote: string
  reviewNote: string
  reviewerName: string
  requestedAt: string
  reviewedAt: string
}

export interface PointAnomaly {
  code: string
  severity: 'critical' | 'warning'
  userId: number
  username: string
  reference: string
  description: string
  detectedAt: string
}

export interface PriceHistory {
  id: number
  requestKey: string
  profileId: string
  resolutionId: string
  oldPoints: number
  newPoints: number
  reason: string
  operatorName: string
  createdAt: string
}

export interface PageResult<T> {
  rows: T[]
  total: number
}

interface ApiResult<T> {
  code: number
  msg: string
  data: T
}

async function result<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await pointRequest.request<ApiResult<T>>(config)
    if (response.data.code !== 200) throw new Error(response.data.msg || '积分管理请求失败。')
    return response.data.data
  } catch (error) {
    const response = (error as AxiosError<ApiResult<unknown>>).response
    throw new Error(response?.data?.msg || (error instanceof Error ? error.message : '积分管理请求失败。'))
  }
}

export function getPointSummary() {
  return result<PointSummary>({ url: '/bge/points/summary', method: 'get' })
}

export function listPointAccounts(params: { username?: string; pageNum: number; pageSize: number }) {
  return result<PageResult<PointAccount>>({ url: '/bge/points/users', method: 'get', params })
}

export function adjustPoints(userId: number, change: number, note: string, idempotencyKey: string) {
  return result<PointAccount>({
    url: `/bge/points/users/${userId}/adjust`, method: 'post', data: { change, note, idempotencyKey }
  })
}

export function listPointLedger(params: { username?: string; eventType?: string; from?: string; to?: string; pageNum: number; pageSize: number }) {
  return result<PageResult<PointLedger>>({ url: '/bge/points/ledger', method: 'get', params })
}

export function listPointCharges(params: { username?: string; taskId?: string; status?: string; pageNum: number; pageSize: number }) {
  return result<PageResult<PointCharge>>({ url: '/bge/points/charges', method: 'get', params })
}

export function listPointPrices() {
  return result<PointPrice[]>({ url: '/bge/points/prices', method: 'get' })
}

export function updatePointPrices(data: { idempotencyKey: string; reason: string; prices: Array<{ profileId: string; resolutionId: string; points: number }> }) {
  return result<PointPrice[]>({ url: '/bge/points/prices', method: 'put', data })
}

export function listPriceHistory() {
  return result<PriceHistory[]>({ url: '/bge/points/price-history', method: 'get' })
}

export function listRechargeRequests(params: { status?: string; pageNum: number; pageSize: number }) {
  return result<PageResult<RechargeRequest>>({ url: '/bge/points/recharges', method: 'get', params })
}

export function reviewRecharge(requestId: number, approve: boolean, note: string) {
  return result<RechargeRequest>({ url: `/bge/points/recharges/${requestId}/review`, method: 'post', data: { approve, note } })
}

export function listPointAnomalies() {
  return result<PointAnomaly[]>({ url: '/bge/points/reconciliation', method: 'get' })
}
