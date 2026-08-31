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
      LOCAL_WEB_PORT: String(port),
      LOCAL_WEB_INPUT_ROOT: inputRoot,
      LOCAL_WEB_OUTPUT_ROOT: outputRoot,
      LOCAL_WEB_STATE_ROOT: stateRoot,
      LOCAL_WEB_ACCESS_MODE: "token",
      LOCAL_WEB_ACCESS_TOKEN: "test-secret",
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
  const health = await healthResponse.json() as { state: string; accessMode: string };
  assert.equal(health.state, "ready");
  assert.equal(health.accessMode, "token");

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
      LOCAL_WEB_PORT: String(port),
      LOCAL_WEB_INPUT_ROOT: inputRoot,
      LOCAL_WEB_OUTPUT_ROOT: outputRoot,
      LOCAL_WEB_STATE_ROOT: stateRoot,
      LOCAL_WEB_ACCESS_MODE: "off",
      LOCAL_WEB_ACCESS_TOKEN: "",
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
      LOCAL_WEB_PORT: String(port),
      LOCAL_WEB_INPUT_ROOT: inputRoot,
      LOCAL_WEB_OUTPUT_ROOT: outputRoot,
      LOCAL_WEB_STATE_ROOT: stateRoot,
      LOCAL_WEB_ACCESS_MODE: "token",
      LOCAL_WEB_ACCESS_TOKEN: "test-secret",
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

async function submitJob(baseUrl: string, idempotencyKey: string) {
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#5588aa" } }).png().toBuffer();
  const form = new FormData();
  form.append("referenceImages", new File([Uint8Array.from(png)], "product.png", { type: "image/png" }));
  form.append("productName", "隔离测试商品");
  form.append("briefText", "测试稳定提交，不调用真实模型");
  form.append("expandBrief", "false");
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

async function waitForHealth(baseUrl: string, server: ChildProcess, output: () => string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}: ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
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
