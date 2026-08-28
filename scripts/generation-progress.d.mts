export interface GenerationProgress {
  stage: string;
  message: string;
  total: number;
  completed: number;
  mainCompleted: number;
  detailCompleted: number;
  retries: number;
  backpressureCount: number;
  concurrency: number;
  qualityRetryTotal: number;
  qualityRetryCompleted: number;
  nextRetryDelayMs?: number;
  firstPreviewAt?: string;
  firstPreviewElapsedMs?: number;
  updatedAt: string;
}

export function normalizeGenerationProgress(value: unknown): GenerationProgress | null;
export function parseNativeProgressLines(text: unknown): GenerationProgress | null;
