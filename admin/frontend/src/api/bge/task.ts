import axios, { type AxiosRequestConfig } from 'axios'
import { getToken } from '../../utils/auth'

const bgeRequest = axios.create({
  baseURL: import.meta.env.VITE_APP_BASE_API,
  timeout: 10000
})

bgeRequest.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.set('Authorization', `Bearer ${token}`)
  return config
})

export interface BgeApiResult<T> {
  code: number
  msg: string
  data: T
}

export interface BgeTaskQuery {
  productName?: string
  status?: string
}

export interface BgeProgress {
  stage?: string
  message?: string
  total?: number
  completed?: number
  mainCompleted?: number
  detailCompleted?: number
  retries?: number
  backpressureCount?: number
  concurrency?: number
  qualityRetryTotal?: number
  qualityRetryCompleted?: number
  firstPreviewAt?: string
  firstPreviewElapsedMs?: number
  updatedAt?: string
}

export interface BgeTiming {
  workflowStartedAt?: string
  firstPreviewAt?: string
  firstPreviewElapsedMs?: number
}

export interface BgeTaskEvent {
  id: string
  type: string
  message: string
  createdAt: string
}

export interface BgeAsset {
  name: string
  url: string
}

export interface BgeOutputFiles {
  main: BgeAsset[]
  detail: BgeAsset[]
  mainOverview?: string
  detailOverview?: string
  longDetail?: string
}

export interface BgeOutput {
  id: string
  folderName?: string
  productName: string
  displayName?: string
  taskId?: string
  submittedAt?: string
  submittedAtLocal?: string
  materialExists?: boolean
  status?: string
  errorMessage?: string
  updatedAt?: string
  mainImageCount?: number
  detailImageCount?: number
  imageResolutionId?: string
  imageResolutionLabel?: string
  files: BgeOutputFiles
}

export interface BgeTask {
  id: string
  taskId?: string
  productName: string
  outputId?: string
  status: string
  message?: string
  progress?: BgeProgress | null
  timing?: BgeTiming | null
  createdAt?: string
  updatedAt?: string
  submittedAtLocal?: string
  referenceCount?: number
  targetPlatform?: string
  outputLanguage?: string
  suiteRatio?: string
  generationProfileId?: string
  imageAspectRatioProfileId?: string
  imageResolutionId?: string
  imageResolutionLabel?: string
  mainImageCount?: number
  detailImageCount?: number
  promptAvailable?: boolean
  promptComplete?: boolean
  outputProductName?: string
  outputDisplayName?: string
  hasOutput?: boolean
  eventCount?: number
  latestEvent?: BgeTaskEvent | null
  events?: BgeTaskEvent[]
  output?: BgeOutput | null
}

export interface BgeTaskList {
  tasks: BgeTask[]
  activeJobId?: string | null
  activePhase?: string
}

export interface BgeHealth {
  state?: string
  status?: string
  message?: string
  upstreamAvailable?: boolean
  [key: string]: unknown
}

async function requestResult<T>(config: AxiosRequestConfig): Promise<BgeApiResult<T>> {
  const response = await bgeRequest.request<BgeApiResult<T>>(config)
  const result = response.data
  if (result.code !== 200) throw new Error(result.msg || 'BGE 管理接口请求失败。')
  return result
}

export function getBgeHealth(): Promise<BgeApiResult<BgeHealth>> {
  return requestResult<BgeHealth>({
    url: '/bge/health',
    method: 'get'
  })
}

export function listBgeTasks(query: BgeTaskQuery): Promise<BgeApiResult<BgeTaskList>> {
  return requestResult<BgeTaskList>({
    url: '/bge/tasks',
    method: 'get',
    params: query
  })
}

export function getBgeTask(taskId: string): Promise<BgeApiResult<BgeTask>> {
  return requestResult<BgeTask>({
    url: `/bge/tasks/${encodeURIComponent(taskId)}`,
    method: 'get'
  })
}

export function getBgeOutput(outputId: string): Promise<BgeApiResult<BgeOutput>> {
  return requestResult<BgeOutput>({
    url: `/bge/outputs/${encodeURIComponent(outputId)}`,
    method: 'get'
  })
}

export function isBgeAssetUrl(url: string): boolean {
  const match = url.match(/^\/bge\/outputs\/([^/?#]+)\/assets\/(?:main|detail|overview)\/([^/?#]+)$/)
  if (!match || /%(?:00|0a|0d|25|2f|5c)/i.test(url)) return false
  try {
    return match.slice(1).every((segment) => {
      const decoded = decodeURIComponent(segment)
      return decoded !== '.' && decoded !== '..' && ![/[\\/]/, /[\u0000-\u001f\u007f]/].some((pattern) => pattern.test(decoded))
    })
  } catch {
    return false
  }
}

export async function getBgeAsset(url: string, signal?: AbortSignal): Promise<Blob> {
  if (!isBgeAssetUrl(url)) {
    throw new Error('图片代理地址不合法。')
  }
  const response = await bgeRequest.request<Blob>({
    url,
    method: 'get',
    responseType: 'blob',
    signal
  })
  return response.data
}
