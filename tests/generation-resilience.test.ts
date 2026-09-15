import test from "node:test";
import assert from "node:assert/strict";
import {
  ProviderCircuitBreaker,
  buildResilienceMetrics,
  classifyWorkflowFailure,
  configuredProviderOrder,
  recoveryDelaysMs,
} from "../scripts/generation-resilience.mjs";

test("classifies capacity, temporary, permanent, and ambiguous failures", () => {
  assert.deepEqual(classifyWorkflowFailure({ log: "No available compatible accounts", exitCode: 1 }).category, "capacity");
  assert.equal(classifyWorkflowFailure({ log: "HTTP 503 gateway timeout", exitCode: 1 }).retryable, true);
  assert.equal(classifyWorkflowFailure({ log: "Missing required environment variable: OPENAI_API_KEY", exitCode: 1 }).retryable, false);
  assert.equal(classifyWorkflowFailure({ log: "aiEcho task is ambiguous", exitCode: 1 }).category, "ambiguous");
  const partialWithValidationNoise = classifyWorkflowFailure({
    message: "部分图片生成失败",
    log: "one candidate failed prompt validation",
    incomplete: true,
  });
  assert.equal(partialWithValidationNoise.category, "retryable");
  assert.equal(partialWithValidationNoise.code, "OUTPUT_INCOMPLETE");
});

test("reads a bounded recovery schedule and discovers configured failover providers", () => {
  const environment = {
    IMAGE_PROVIDER: "openai",
    IMAGE_PROVIDER_FAILOVER_ORDER: "openai,aiecho,invalid",
    OPENAI_API_KEY: "redacted",
    AIECHO_ACTIVATION_CODE: "redacted",
    LOCAL_WEB_RECOVERY_DELAYS_MS: "0,25,100",
  };
  assert.deepEqual(recoveryDelaysMs(environment), [0, 25, 100]);
  assert.deepEqual(configuredProviderOrder(environment), ["openai", "aiecho"]);
});

test("provider circuit breaker opens after consecutive failures and selects the backup", () => {
  let now = 1_000;
  const breaker = new ProviderCircuitBreaker({ now: () => now, failureThreshold: 2, cooldownMs: 5_000 });
  const failure = classifyWorkflowFailure({ log: "429 rate limit" });
  breaker.recordFailure("openai", failure);
  assert.equal(breaker.choose(["openai", "aiecho"], "openai"), "openai");
  breaker.recordFailure("openai", failure);
  assert.equal(breaker.choose(["openai", "aiecho"], "openai"), "aiecho");
  now += 5_001;
  assert.equal(breaker.choose(["openai", "aiecho"], "openai"), "openai");
});

test("resilience metrics expose first-pass, recovered, provider, language, and resolution rates", () => {
  const metrics = buildResilienceMetrics([
    { status: "done", outputLanguage: "English", imageResolutionId: "2k", attemptHistory: [{ provider: "openai", outcome: "done", durationMs: 100 }] },
    { status: "done", outputLanguage: "日本語", imageResolutionId: "4k", attemptHistory: [{ provider: "openai", outcome: "failed", classification: "capacity", durationMs: 200 }, { provider: "aiecho", outcome: "done", durationMs: 300 }] },
    { status: "failed", outputLanguage: "English", imageResolutionId: "2k", attemptHistory: [{ provider: "openai", outcome: "failed", failureSummary: "HTTP 429", durationMs: 400 }] },
    { status: "recovering", outputLanguage: "English", imageResolutionId: "2k", attemptHistory: [{ provider: "openai", outcome: "running", durationMs: 0 }] },
  ], 1234);
  assert.equal(metrics.taskCount, 4);
  assert.equal(metrics.terminalTaskCount, 3);
  assert.equal(metrics.activeTaskCount, 1);
  assert.equal(metrics.recoveredTaskCount, 1);
  assert.equal(metrics.completeSuccessRate, 0.6667);
  assert.equal(metrics.capacityEventCount, 1);
  assert.equal(metrics.rateLimitEventCount, 1);
  assert.equal(metrics.p95AttemptDurationMs, 400);
  assert.equal(metrics.byProvider.openai.total, 4);
  assert.equal(metrics.byLanguage.English.total, 2);
  assert.equal(metrics.byResolution["4k"].successful, 1);
});
