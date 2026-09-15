export interface WorkflowFailureClassification {
  category: "ambiguous" | "cancelled" | "permanent" | "validation" | "capacity" | "retryable" | "unknown";
  retryable: boolean;
  code: string;
  userMessage: string;
}

export function recoveryDelaysMs(environment?: NodeJS.ProcessEnv): number[];
export function automaticRecoveryEnabled(environment?: NodeJS.ProcessEnv): boolean;
export function classifyWorkflowFailure(input?: Record<string, unknown>): WorkflowFailureClassification;
export function configuredProviderOrder(environment?: NodeJS.ProcessEnv, preferredProvider?: string): string[];
export function providerConfigured(provider: string, environment?: NodeJS.ProcessEnv): boolean;
export class ProviderCircuitBreaker {
  constructor(options?: Record<string, unknown>);
  recordSuccess(provider: string): void;
  recordFailure(provider: string, failure: WorkflowFailureClassification): void;
  choose(providers: string[], preferredProvider?: string): string;
  snapshot(): Record<string, unknown>;
}
export function createProviderCircuitBreaker(environment?: NodeJS.ProcessEnv, snapshot?: Record<string, unknown>): ProviderCircuitBreaker;
export interface ResilienceMetricGroup {
  total: number;
  successful: number;
  failed: number;
  successRate: number;
}
export interface ResilienceMetrics {
  generatedAt: string;
  taskCount: number;
  terminalTaskCount: number;
  activeTaskCount: number;
  attemptCount: number;
  firstPassSuccessRate: number;
  recoveredTaskCount: number;
  completeSuccessRate: number;
  retryRate: number;
  p95AttemptDurationMs: number;
  capacityEventCount: number;
  rateLimitEventCount: number;
  byProvider: Record<string, ResilienceMetricGroup>;
  byLanguage: Record<string, ResilienceMetricGroup>;
  byResolution: Record<string, ResilienceMetricGroup>;
}
export function buildResilienceMetrics(jobs: Iterable<Record<string, unknown>>, now?: number): ResilienceMetrics;
