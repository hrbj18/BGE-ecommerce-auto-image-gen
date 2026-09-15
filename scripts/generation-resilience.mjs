const DEFAULT_RECOVERY_DELAYS_MS = [60_000, 180_000, 600_000];
const PROVIDERS = new Set(["openai", "aiecho"]);

function text(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(text(value), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function recoveryDelaysMs(environment = process.env) {
  const configured = text(environment.LOCAL_WEB_RECOVERY_DELAYS_MS)
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .slice(0, 8);
  return configured.length ? configured : [...DEFAULT_RECOVERY_DELAYS_MS];
}

export function automaticRecoveryEnabled(environment = process.env) {
  return !/^(0|false|no|off)$/i.test(text(environment.LOCAL_WEB_AUTO_RECOVERY_ENABLED));
}

export function classifyWorkflowFailure(input = {}) {
  const combined = [input.errorCode, input.message, input.log]
    .map(text)
    .filter(Boolean)
    .join("\n");
  const lower = combined.toLowerCase();

  if (/ambiguous|受理状态不明确|无法确认(?:请求|任务)是否受理|aiecho_task_ambiguous/.test(lower)) {
    return classification("ambiguous", false, "PROVIDER_ACCEPTANCE_AMBIGUOUS",
      "供应商受理状态需要确认，系统已暂停自动提交以避免重复扣费。");
  }
  if (/cancel|取消|submission_cancelled/.test(lower) || input.cancelled) {
    return classification("cancelled", false, "TASK_CANCELLED", "任务已取消。");
  }
  // Once an attempt has produced part of the requested suite, preserving and
  // filling those exact missing slots is safer than asking the user to submit
  // a new top-level task. The bounded task recovery budget still prevents an
  // endless loop when the underlying problem is permanent.
  if (input.incomplete) {
    return classification("retryable", true, "OUTPUT_INCOMPLETE",
      "部分图片尚未完成，系统正在自动补齐。");
  }
  if (/missing required environment|配置不合法|must be openai|must be 1k|must be 2k|api[_ ]?key|activation[_ ]?code|\b401\b|\b403\b|unauthori[sz]ed|forbidden/.test(lower)) {
    return classification("permanent", false, "PROVIDER_CONFIGURATION_INVALID",
      "生图服务配置需要管理员处理，任务已保留，可在修复配置后继续生成。");
  }
  if (/产品身份审核|提示词审核|创意分镜审核|素材目录|没有参考图|没有需求模板|invalid[_ -]?(?:input|parameter)|\b400\b|\b404\b|\b413\b|\b422\b/.test(lower)) {
    return classification("validation", false, "WORKFLOW_VALIDATION_FAILED",
      "任务素材或生成规则未通过校验，请调整后重新提交。");
  }
  if (/no available compatible accounts|capacity|insufficient quota|resource exhausted|账号池|无可用账号|容量|配额|\b429\b|rate\s*limit|too many requests|限流|繁忙|排队/.test(lower)) {
    return classification("capacity", true, "PROVIDER_CAPACITY_LIMITED",
      "生图服务当前繁忙，系统正在自动恢复任务。");
  }
  if (input.timedOut || /timeout|timed out|aborterror|econnreset|econnrefused|enotfound|socket|network|fetch failed|terminated|service unavailable|bad gateway|gateway timeout|连接|网络|超时|\b500\b|\b502\b|\b503\b|\b504\b|image_provider_unavailable/.test(lower)) {
    return classification("retryable", true, input.timedOut ? "WORKFLOW_TIMEOUT" : "PROVIDER_TEMPORARY_FAILURE",
      "生图服务出现临时波动，系统正在自动恢复任务。");
  }
  if (input.exitCode !== undefined && input.exitCode !== null && Number(input.exitCode) !== 0) {
    return classification("retryable", true, "WORKFLOW_PROCESS_FAILED",
      "生图流程意外中断，系统正在自动恢复任务。");
  }
  return classification("unknown", false, "WORKFLOW_FAILURE_UNKNOWN",
    "生图流程未能完成，任务和已生成图片均已保留。");
}

function classification(category, retryable, code, userMessage) {
  return { category, retryable, code, userMessage };
}

export function configuredProviderOrder(environment = process.env, preferredProvider = "") {
  const preferred = normalizeProvider(preferredProvider || environment.IMAGE_PROVIDER || "aiecho");
  const requested = text(environment.IMAGE_PROVIDER_FAILOVER_ORDER)
    .split(",")
    .map(normalizeProvider)
    .filter(Boolean);
  const candidates = [preferred, ...requested, "openai", "aiecho"];
  return [...new Set(candidates)].filter((provider) => provider && providerConfigured(provider, environment));
}

export function providerConfigured(provider, environment = process.env) {
  const normalized = normalizeProvider(provider);
  if (/^(1|true|yes)$/i.test(text(environment.LOCAL_IMAGE_TEST_MODE))) return Boolean(normalized);
  if (normalized === "openai") return Boolean(text(environment.OPENAI_API_KEY));
  if (normalized === "aiecho") return Boolean(text(environment.AIECHO_ACTIVATION_CODE));
  return false;
}

function normalizeProvider(value) {
  const normalized = text(value).toLowerCase();
  return PROVIDERS.has(normalized) ? normalized : "";
}

export class ProviderCircuitBreaker {
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.failureThreshold = positiveInteger(options.failureThreshold, 2, 1, 20);
    this.cooldownMs = positiveInteger(options.cooldownMs, 5 * 60_000, 1_000, 24 * 60 * 60_000);
    this.states = new Map();
    for (const [provider, state] of Object.entries(options.snapshot || {})) {
      if (!normalizeProvider(provider) || !state || typeof state !== "object") continue;
      this.states.set(provider, normalizeCircuitState(state));
    }
  }

  recordSuccess(provider) {
    const normalized = normalizeProvider(provider);
    if (!normalized) return;
    this.states.set(normalized, { consecutiveFailures: 0, openedUntil: 0, lastFailureCategory: "", updatedAt: new Date(this.now()).toISOString() });
  }

  recordFailure(provider, failure) {
    const normalized = normalizeProvider(provider);
    if (!normalized || !failure?.retryable || failure.category === "ambiguous") return;
    const previous = this.states.get(normalized) || normalizeCircuitState({});
    const consecutiveFailures = previous.consecutiveFailures + 1;
    const openedUntil = consecutiveFailures >= this.failureThreshold ? this.now() + this.cooldownMs : previous.openedUntil;
    this.states.set(normalized, {
      consecutiveFailures,
      openedUntil,
      lastFailureCategory: text(failure.category),
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  choose(providers, preferredProvider = "") {
    const available = [...new Set((providers || []).map(normalizeProvider).filter(Boolean))];
    if (!available.length) return "";
    const preferred = normalizeProvider(preferredProvider);
    const ordered = preferred && available.includes(preferred)
      ? [preferred, ...available.filter((provider) => provider !== preferred)]
      : available;
    const now = this.now();
    return ordered.find((provider) => (this.states.get(provider)?.openedUntil || 0) <= now)
      || ordered.sort((left, right) => (this.states.get(left)?.openedUntil || 0) - (this.states.get(right)?.openedUntil || 0))[0];
  }

  snapshot() {
    return Object.fromEntries([...this.states.entries()].map(([provider, state]) => [provider, { ...state }]));
  }
}

function normalizeCircuitState(value) {
  return {
    consecutiveFailures: Math.max(0, Number(value.consecutiveFailures || 0) || 0),
    openedUntil: Math.max(0, Number(value.openedUntil || 0) || 0),
    lastFailureCategory: text(value.lastFailureCategory),
    updatedAt: text(value.updatedAt),
  };
}

export function createProviderCircuitBreaker(environment = process.env, snapshot = {}) {
  return new ProviderCircuitBreaker({
    failureThreshold: positiveInteger(environment.IMAGE_PROVIDER_CIRCUIT_FAILURE_THRESHOLD, 2, 1, 20),
    cooldownMs: positiveInteger(environment.IMAGE_PROVIDER_CIRCUIT_COOLDOWN_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
    snapshot,
  });
}

export function buildResilienceMetrics(jobs, now = Date.now()) {
  const list = [...(jobs || [])].filter((job) => job && job.kind !== "brief-expansion");
  const terminalStatuses = new Set(["done", "failed", "partial", "interrupted", "cancelled", "canceled"]);
  const settled = list.filter((job) => terminalStatuses.has(text(job.status).toLowerCase()));
  const attempts = list.flatMap((job) => Array.isArray(job.attemptHistory) ? job.attemptHistory : []);
  const durations = attempts.map((item) => Number(item.durationMs || 0)).filter((value) => value > 0).sort((a, b) => a - b);
  const firstPassDone = settled.filter((job) => job.status === "done" && (job.attemptHistory?.length || 0) <= 1).length;
  const recoveredDone = settled.filter((job) => job.status === "done" && (job.attemptHistory?.length || 0) > 1).length;
  const complete = settled.filter((job) => job.status === "done").length;
  const capacityEvents = attempts.filter((item) => item.classification === "capacity").length;
  const rateLimitEvents = attempts.filter((item) => /429|rate.?limit|限流/i.test(text(item.errorCode) + text(item.failureSummary))).length;
  return {
    generatedAt: new Date(now).toISOString(),
    taskCount: list.length,
    terminalTaskCount: settled.length,
    activeTaskCount: list.length - settled.length,
    attemptCount: attempts.length,
    firstPassSuccessRate: ratio(firstPassDone, settled.length),
    recoveredTaskCount: recoveredDone,
    completeSuccessRate: ratio(complete, settled.length),
    retryRate: ratio(settled.filter((job) => (job.attemptHistory?.length || 0) > 1).length, settled.length),
    p95AttemptDurationMs: percentile(durations, 0.95),
    capacityEventCount: capacityEvents,
    rateLimitEventCount: rateLimitEvents,
    byProvider: groupMetrics(attempts, (item) => text(item.provider) || "unknown"),
    byLanguage: groupMetrics(settled, (item) => text(item.outputLanguage) || "未记录", true),
    byResolution: groupMetrics(settled, (item) => text(item.imageResolutionId) || "未记录", true),
  };
}

function groupMetrics(items, keyFor, jobs = false) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key) || { total: 0, successful: 0, failed: 0 };
    group.total += 1;
    const successful = jobs ? item.status === "done" : item.outcome === "done";
    if (successful) group.successful += 1;
    else if (jobs ? ["failed", "partial", "interrupted"].includes(item.status) : item.outcome && item.outcome !== "running") group.failed += 1;
    groups.set(key, group);
  }
  return Object.fromEntries([...groups.entries()].map(([key, group]) => [key, { ...group, successRate: ratio(group.successful, group.total) }]));
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))];
}
