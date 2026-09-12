import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("isolated API admits one workflow, deduplicates retries, rejects bad uploads, and cancels cleanly", { timeout: 45_000 }, async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bge-local-web-api-"));
  const inputRoot = path.join(tempRoot, "input");
  const outputRoot = path.join(tempRoot, "output");
  const stateRoot = path.join(tempRoot, "state");
  const marker = path.join(tempRoot, "workflow-starts.txt");
  await Promise.all([fs.mkdir(inputRoot), fs.mkdir(outputRoot), fs.mkdir(stateRoot)]);
  const port = await availablePort();
  const server = spawn(process.execPath, ["scripts/local-web-server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOCAL_WEB_HOST: "127.0.0.1",
      LOCAL_WEB_PORT: String(port),
      LOCAL_WEB_INPUT_ROOT: inputRoot,
      LOCAL_WEB_OUTPUT_ROOT: outputRoot,
      LOCAL_WEB_STATE_ROOT: stateRoot,
      LOCAL_WEB_ACCESS_MODE: "token",
      LOCAL_WEB_ACCESS_TOKEN: "test-secret",
      LOCAL_WEB_REQUIRE_READ_TOKEN: "",
      LOCAL_WEB_MAX_REQUEST_MB: "1",
      LOCAL_WEB_MAX_FILE_MB: "1",
      LOCAL_WEB_MIN_FREE_GB: "0.000001",
      LOCAL_WEB_TEST_WORKFLOW_SCRIPT: "tests/fixtures/local-web-mock-workflow.mjs",
      LOCAL_WEB_TEST_WORKFLOW_MODE: "hang",
      LOCAL_WEB_TEST_MARKER: marker,
      LOCAL_WEB_WORKFLOW_TIMEOUT_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  t.after(async () => {
    await stopServer(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, server, () => serverOutput);
  const healthResponse = await fetch(`${baseUrl}/health`, { headers: { Origin: "https://evil.example" } });
  assert.equal(healthResponse.headers.get("access-control-allow-origin"), null);
  const health = await healthResponse.json() as {
    state: string;
    accessMode: string;
    generationProfiles: Array<{ id: string }>;
    imageAspectRatioProfiles: Array<{ id: string }>;
    imageResolutionProfiles: Array<{ id: string }>;
  };
  assert.equal(health.state, "ready");
  assert.equal(health.accessMode, "token");
  assert.deepEqual(health.generationProfiles.map((profile) => profile.id), [
    "standard-5-8",
    "compact-1-2",
    "compact-2-3",
    "compact-3-4",
  ]);
  assert.deepEqual(health.imageResolutionProfiles.map((profile) => profile.id), ["1k", "2k", "4k"]);
  assert.deepEqual(health.imageAspectRatioProfiles.map((profile) => profile.id), ["ecommerce-standard", "portrait-main"]);

  const unauthorized = await fetch(`${baseUrl}/api/jobs`, { method: "POST", body: new FormData() });
  assert.equal(unauthorized.status, 401);

  const differentTimed = await Promise.all(Array.from({ length: 20 }, (_, index) => timedSubmitJob(baseUrl, `distinct-${index}`)));
  const different = differentTimed.map(({ response }) => response);
  assert.equal(different.filter((response) => response.status === 202).length, 1, `statuses=${different.map((response) => response.status).join(",")}\n${serverOutput}`);
  assert.equal(different.filter((response) => response.status === 409).length, 19, `statuses=${different.map((response) => response.status).join(",")}\n${serverOutput}`);
  const acceptedLatency = differentTimed.find(({ response }) => response.status === 202)?.elapsedMs ?? Infinity;
  assert.ok(acceptedLatency < 1500, `accepted mock submission took ${acceptedLatency.toFixed(1)}ms`);
  const first = await different.find((response) => response.status === 202)!.json() as { id: string };
  await waitForJob(baseUrl, first.id, ["running"]);
  await waitForMarker(marker, 1);
  const cancelled = await authorizedFetch(`${baseUrl}/api/jobs/${encodeURIComponent(first.id)}/cancel`, { method: "POST" });
  const cancelledPayload = await cancelled.json() as { status: string; error?: string };
  assert.equal(cancelled.status, 200, cancelledPayload.error);
  assert.equal(cancelledPayload.status, "cancelled");

  for (const expected of [
    { id: "compact-1-2", mainImageCount: 1, detailImageCount: 2, imageResolutionId: "1k" },
    { id: "compact-2-3", mainImageCount: 2, detailImageCount: 3, imageResolutionId: "2k" },
    { id: "compact-3-4", mainImageCount: 3, detailImageCount: 4, imageResolutionId: "4k" },
  ]) {
    const compactResponse = await submitJob(baseUrl, `compact-suite-${expected.id}`, expected.id, "隔离 测试商品", expected.imageResolutionId, "portrait-main");
    const compactJob = await compactResponse.json() as {
      id: string;
      generationProfileId: string;
      mainImageCount: number;
      detailImageCount: number;
      progress: { total: number };
      materialDir: string;
      imageResolutionId: string;
      imageAspectRatioProfileId: string;
      suiteRatio: string;
    };
    assert.equal(compactResponse.status, 202);
    assert.equal(compactJob.generationProfileId, expected.id);
    assert.equal(compactJob.mainImageCount, expected.mainImageCount);
    assert.equal(compactJob.detailImageCount, expected.detailImageCount);
    assert.equal(compactJob.progress.total, expected.mainImageCount + expected.detailImageCount);
    assert.equal(compactJob.imageResolutionId, expected.imageResolutionId);
    assert.equal(compactJob.imageAspectRatioProfileId, "portrait-main");
    assert.equal(compactJob.suiteRatio, "主图 3:4 / 详情页 9:16");
    assert.equal(path.basename(compactJob.materialDir).includes(" "), false, "API task directory must use the workflow's hyphenated segment rule");
    const compactMetadata = JSON.parse(await fs.readFile(path.join(compactJob.materialDir, "任务信息.json"), "utf8"));
    assert.equal(compactMetadata.generationProfileId, expected.id);
    assert.equal(compactMetadata.mainImageCount, expected.mainImageCount);
    assert.equal(compactMetadata.detailImageCount, expected.detailImageCount);
    assert.equal(compactMetadata.imageResolutionId, expected.imageResolutionId);
    assert.equal(compactMetadata.imageAspectRatioProfileId, "portrait-main");
    await waitForJob(baseUrl, compactJob.id, ["running"]);
    const cancelledCompact = await authorizedFetch(`${baseUrl}/api/jobs/${encodeURIComponent(compactJob.id)}/cancel`, { method: "POST" });
    assert.equal(cancelledCompact.status, 200);
  }

  const invalidProfile = await submitJob(baseUrl, "invalid-profile", "not-a-profile");
  const invalidProfilePayload = await invalidProfile.json() as { code?: string; error?: string };
  assert.equal(invalidProfile.status, 400, invalidProfilePayload.error);
  assert.equal(invalidProfilePayload.code, "GENERATION_PROFILE_INVALID");

  const invalidResolution = await submitJob(baseUrl, "invalid-resolution", "compact-1-2", "分辨率校验商品", "720p");
  const invalidResolutionPayload = await invalidResolution.json() as { code?: string; error?: string };
  assert.equal(invalidResolution.status, 400, invalidResolutionPayload.error);
  assert.equal(invalidResolutionPayload.code, "IMAGE_RESOLUTION_INVALID");

  const invalidAspectRatio = await submitJob(baseUrl, "invalid-aspect-ratio", "compact-1-2", "比例校验商品", "1k", "arbitrary-ratio");
  const invalidAspectRatioPayload = await invalidAspectRatio.json() as { code?: string; error?: string };
  assert.equal(invalidAspectRatio.status, 400, invalidAspectRatioPayload.error);
  assert.equal(invalidAspectRatioPayload.code, "IMAGE_ASPECT_RATIO_INVALID");

  const invalidExpansionForm = new FormData();
  invalidExpansionForm.append("productName", "扩写比例校验商品");
  invalidExpansionForm.append("imageAspectRatioProfileId", "arbitrary-ratio");
  const invalidExpansionRatio = await authorizedFetch(`${baseUrl}/api/brief-expansions`, {
    method: "POST",
    body: invalidExpansionForm,
  });
  const invalidExpansionRatioPayload = await invalidExpansionRatio.json() as { code?: string; error?: string };
  assert.equal(invalidExpansionRatio.status, 400, invalidExpansionRatioPayload.error);
  assert.equal(invalidExpansionRatioPayload.code, "IMAGE_ASPECT_RATIO_INVALID");

  const repeatedTimed = await Promise.all(Array.from({ length: 20 }, () => timedSubmitJob(baseUrl, "same-retry-key")));
  const repeated = repeatedTimed.map(({ response }) => response);
  assert.equal(repeated.every((response) => response.status === 202), true, serverOutput);
  const retryP95 = percentile(repeatedTimed.map(({ elapsedMs }) => elapsedMs), 0.95);
  assert.ok(retryP95 < 300, `idempotent retry P95 took ${retryP95.toFixed(1)}ms`);
  const repeatedJobs = await Promise.all(repeated.map((response) => response.json() as Promise<{ id: string }>));
  assert.equal(new Set(repeatedJobs.map((job) => job.id)).size, 1);
  await waitForJob(baseUrl, repeatedJobs[0].id, ["running"]);
  await waitForMarker(marker, 2);
  await authorizedFetch(`${baseUrl}/api/jobs/${encodeURIComponent(repeatedJobs[0].id)}/cancel`, { method: "POST" });

  const beforeInvalid = await markerLines(marker);
  const oversized = await authorizedFetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Idempotency-Key": "oversized-request" },
    body: Buffer.alloc(1024 * 1024 + 1),
  });
  const oversizedPayload = await oversized.json() as { error?: string };
  assert.equal(oversized.status, 413, oversizedPayload.error);

  const chunk = new Uint8Array(600 * 1024);
  const chunkedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const chunked = await authorizedFetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Idempotency-Key": "chunked-oversized-request" },
    body: chunkedBody,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const chunkedPayload = await chunked.json() as { error?: string };
  assert.equal(chunked.status, 413, chunkedPayload.error);

  const invalid = new FormData();
  invalid.append("referenceImages", new File(["not-an-image"], "fake.png", { type: "image/png" }));
  invalid.append("productName", "坏图测试");
  invalid.append("briefText", "不应进入工作流");
  invalid.append("expandBrief", "false");
  const invalidResponse = await authorizedFetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "X-Idempotency-Key": "invalid-image" },
    body: invalid,
  });
  const invalidPayload = await invalidResponse.json() as { error?: string };
  assert.equal(invalidResponse.status, 422, invalidPayload.error);
  assert.equal(await markerLines(marker), beforeInvalid);

  const timeoutResponse = await submitJob(baseUrl, "hard-timeout-job");
  assert.equal(timeoutResponse.status, 202);
  const timeoutJob = await timeoutResponse.json() as { id: string };
  await waitForJob(baseUrl, timeoutJob.id, ["running"]);
  const timedOut = await waitForJob(baseUrl, timeoutJob.id, ["failed", "partial"]);
  assert.match(timedOut.message || "", /最长运行时间/);

  const finalHealth = await fetch(`${baseUrl}/health`).then((response) => response.json()) as { state: string; activeJobs: number };
  assert.equal(finalHealth.state, "ready");
  assert.equal(finalHealth.activeJobs, 0);
});

test("default access mode reports off and allows direct LAN writes without a token", { timeout: 20_000 }, async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bge-local-web-open-access-"));
  const inputRoot = path.join(tempRoot, "input");
  const outputRoot = path.join(tempRoot, "output");
  const stateRoot = path.join(tempRoot, "state");
  await Promise.all([fs.mkdir(inputRoot), fs.mkdir(outputRoot), fs.mkdir(stateRoot)]);
  const port = await availablePort();
  const server = spawn(process.execPath, ["scripts/local-web-server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOCAL_WEB_HOST: "127.0.0.1",
      LOCAL_WEB_PORT: String(port),
      LOCAL_WEB_INPUT_ROOT: inputRoot,
      LOCAL_WEB_OUTPUT_ROOT: outputRoot,
      LOCAL_WEB_STATE_ROOT: stateRoot,
      LOCAL_WEB_ACCESS_MODE: "off",
      LOCAL_WEB_ACCESS_TOKEN: "",
      LOCAL_WEB_REQUIRE_READ_TOKEN: "",
      LOCAL_WEB_MIN_FREE_GB: "0.000001",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    await stopServer(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, server, () => output);
  const health = await fetch(`${baseUrl}/health`).then((response) => response.json()) as { accessMode: string };
  assert.equal(health.accessMode, "off");
  const lanDelete = await fetch(`${baseUrl}/api/tasks/not-found`, {
    method: "DELETE",
    headers: { "X-Forwarded-For": "192.168.1.25" },
  });
  assert.equal(lanDelete.status, 404, output);
});

test("admin mode protects every Node read endpoint with the internal token", { timeout: 20_000 }, async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bge-local-web-admin-read-token-"));
  const inputRoot = path.join(tempRoot, "input");
  const outputRoot = path.join(tempRoot, "output");
  const stateRoot = path.join(tempRoot, "state");
  await Promise.all([fs.mkdir(inputRoot), fs.mkdir(outputRoot), fs.mkdir(stateRoot)]);
  const port = await availablePort();
  const server = spawn(process.execPath, ["scripts/local-web-server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOCAL_WEB_HOST: "127.0.0.1",
      LOCAL_WEB_PORT: String(port),
      LOCAL_WEB_INPUT_ROOT: inputRoot,
      LOCAL_WEB_OUTPUT_ROOT: outputRoot,
      LOCAL_WEB_STATE_ROOT: stateRoot,
      LOCAL_WEB_ACCESS_MODE: "token",
      LOCAL_WEB_ACCESS_TOKEN: "test-secret",
      LOCAL_WEB_REQUIRE_READ_TOKEN: "true",
      LOCAL_WEB_MIN_FREE_GB: "0.000001",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    await stopServer(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, server, () => output, { Authorization: "Bearer test-secret" });
  for (const endpoint of ["/health", "/api/tasks", "/api/outputs", "/outputs/example/main/01.jpg"]) {
    const anonymous = await fetch(`${baseUrl}${endpoint}`);
    assert.equal(anonymous.status, 401, `${endpoint}\n${output}`);
  }
  const health = await authorizedFetch(`${baseUrl}/health`);
  assert.equal(health.status, 200, output);
  const tasks = await authorizedFetch(`${baseUrl}/api/tasks`);
  assert.equal(tasks.status, 200, output);
});

test("isolated API recovers task history and blocks new work when disk policy is degraded", { timeout: 20_000 }, async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bge-local-web-recovery-"));
  const inputRoot = path.join(tempRoot, "input");
  const outputRoot = path.join(tempRoot, "output");
  const stateRoot = path.join(tempRoot, "state");
  const taskRoot = path.join(stateRoot, "tasks");
  await Promise.all([fs.mkdir(inputRoot), fs.mkdir(outputRoot), fs.mkdir(taskRoot, { recursive: true })]);
  await fs.writeFile(path.join(taskRoot, "tasks.json"), "{broken", "utf8");
  await fs.writeFile(path.join(taskRoot, "tasks.json.bak"), JSON.stringify({
    version: 1,
    tasks: [{ id: "recovered-job", productName: "恢复记录", status: "done", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
  }), "utf8");
  const port = await availablePort();
  const server = spawn(process.execPath, ["scripts/local-web-server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOCAL_WEB_HOST: "127.0.0.1",
      LOCAL_WEB_PORT: String(port),
      LOCAL_WEB_INPUT_ROOT: inputRoot,
      LOCAL_WEB_OUTPUT_ROOT: outputRoot,
      LOCAL_WEB_STATE_ROOT: stateRoot,
      LOCAL_WEB_ACCESS_MODE: "token",
      LOCAL_WEB_ACCESS_TOKEN: "test-secret",
      LOCAL_WEB_REQUIRE_READ_TOKEN: "",
      LOCAL_WEB_MIN_FREE_GB: "999999999",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    await stopServer(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, server, () => output);
  const health = await fetch(`${baseUrl}/health`).then((response) => response.json()) as { state: string };
  assert.equal(health.state, "degraded");
  const tasks = await fetch(`${baseUrl}/api/tasks`).then((response) => response.json()) as { tasks: Array<{ id: string }> };
  assert.equal(tasks.tasks.some((task) => task.id === "recovered-job"), true);
  const recoveredPrimary = await fs.readFile(path.join(taskRoot, "tasks.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(recoveredPrimary));

  const response = await submitJob(baseUrl, "low-disk-job");
  const payload = await response.json() as { code?: string; error?: string };
  assert.equal(response.status, 507, payload.error);
  assert.equal(payload.code, "INSUFFICIENT_STORAGE");
});

test("malformed brief-expansion uploads return 400 without terminating the Node service", { timeout: 20_000 }, async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bge-local-web-invalid-brief-"));
  const inputRoot = path.join(tempRoot, "input");
  const outputRoot = path.join(tempRoot, "output");
  const stateRoot = path.join(tempRoot, "state");
  await Promise.all([fs.mkdir(inputRoot), fs.mkdir(outputRoot), fs.mkdir(stateRoot)]);
  const port = await availablePort();
  const server = spawn(process.execPath, ["scripts/local-web-server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOCAL_WEB_HOST: "127.0.0.1",
      LOCAL_WEB_PORT: String(port),
      LOCAL_WEB_INPUT_ROOT: inputRoot,
      LOCAL_WEB_OUTPUT_ROOT: outputRoot,
      LOCAL_WEB_STATE_ROOT: stateRoot,
      LOCAL_WEB_ACCESS_MODE: "token",
      LOCAL_WEB_ACCESS_TOKEN: "test-secret",
      LOCAL_WEB_MIN_FREE_GB: "0.000001",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    await stopServer(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, server, () => output, { Authorization: "Bearer test-secret" });

  const malformed = await authorizedFetch(`${baseUrl}/api/brief-expansions`, {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=missing-boundary" },
    body: "this is not a multipart body",
  });
  const payload = await malformed.json() as { code?: string; error?: string };
  assert.equal(malformed.status, 400, payload.error);
  assert.equal(payload.code, "INVALID_MULTIPART");
  assert.equal(server.exitCode, null, output);

  const health = await authorizedFetch(`${baseUrl}/health`);
  assert.equal(health.status, 200, output);
});

async function submitJob(
  baseUrl: string,
  idempotencyKey: string,
  generationProfileId = "",
  productName = "隔离测试商品",
  imageResolutionId = "",
  imageAspectRatioProfileId = "",
) {
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#5588aa" } }).png().toBuffer();
  const form = new FormData();
  form.append("referenceImages", new File([Uint8Array.from(png)], "product.png", { type: "image/png" }));
  form.append("productName", productName);
  form.append("briefText", "测试稳定提交，不调用真实模型");
  form.append("expandBrief", "false");
  if (generationProfileId) form.append("generationProfileId", generationProfileId);
  if (imageResolutionId) form.append("imageResolutionId", imageResolutionId);
  if (imageAspectRatioProfileId) form.append("imageAspectRatioProfileId", imageAspectRatioProfileId);
  return authorizedFetch(`${baseUrl}/api/jobs`, { method: "POST", headers: { "X-Idempotency-Key": idempotencyKey }, body: form });
}

async function timedSubmitJob(baseUrl: string, idempotencyKey: string) {
  const startedAt = performance.now();
  const response = await submitJob(baseUrl, idempotencyKey);
  return { response, elapsedMs: performance.now() - startedAt };
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function authorizedFetch(url: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization", "Bearer test-secret");
  return fetch(url, { ...options, headers });
}

async function waitForJob(baseUrl: string, jobId: string, statuses: string[]) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`).then((response) => response.json()) as { status: string; message?: string };
    if (statuses.includes(job.status)) return job;
    if (["failed", "cancelled", "interrupted"].includes(job.status)) throw new Error(`job stopped early: ${job.status} ${job.message || ""}`);
    await delay(100);
  }
  throw new Error(`timed out waiting for ${jobId}: ${statuses.join(",")}`);
}

async function waitForHealth(baseUrl: string, server: ChildProcess, output: () => string, headers?: HeadersInit) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}: ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { headers });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`server did not become healthy: ${output()}`);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function markerLines(marker: string) {
  const raw = await fs.readFile(marker, "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter(Boolean).length;
}

async function waitForMarker(marker: string, expected: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await markerLines(marker) >= expected) return;
    await delay(50);
  }
  throw new Error(`workflow marker did not reach ${expected}`);
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (server.exitCode === null) server.kill("SIGKILL");
      resolve();
    }, 5000);
    server.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
