import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createPnpmCommand } from "./runtime-commands.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
const frontendUrl = process.env.FRONTEND_URL || "http://127.0.0.1:5173";
const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:8787/health";
const backendOnly = process.env.START_BACKEND_ONLY === "1";
const frontendOnly = process.env.START_FRONTEND_ONLY === "1";
let shuttingDown = false;
const logRoot = path.join(root, ".local-web", "logs");
const lockPath = path.join(root, ".local-web", "web-app.lock");
const sessionLogPath = path.join(logRoot, "web-session.log");
let lockHandle = null;
const logStreams = new Set();

const processes = [];

await fs.mkdir(logRoot, { recursive: true });
const sessionStream = createWriteStream(sessionLogPath, { flags: "a", encoding: "utf8" });
logStreams.add(sessionStream);
writeLog(`\n=== web session ${new Date().toISOString()} ===`);

try {
  await acquireStartupLock();
} catch (error) {
  writeLog(`startup lock unavailable: ${error instanceof Error ? error.message : String(error)}`);
  const existingReady = await waitForHttp(backendUrl, 12_000).then(async () => {
    await waitForHttp(frontendUrl, 12_000);
    return true;
  }).catch(() => false);
  if (existingReady) {
    openUrl(frontendUrl);
    await closeLogs();
    process.exit(0);
  }
  console.error("Another local web app launcher is active, but its services are not healthy.");
  console.error(`See ${sessionLogPath}`);
  await closeLogs();
  process.exit(1);
}

if (!frontendOnly && !(await isHttpOk(backendUrl))) {
  processes.push(spawnManaged("backend", process.execPath, ["scripts/local-web-server.mjs"], env));
  await waitForHttp(backendUrl, 45_000);
}
if (!backendOnly && !(await isHttpOk(frontendUrl))) {
  const pnpm = createPnpmCommand(["--dir", "frontend", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]);
  processes.push(spawnManaged("frontend", pnpm.command, pnpm.args, env));
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of processes) killProcessTree(child);
  void releaseStartupLock();
  void closeLogs();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

console.log(`Local web app starting: ${path.join(root, "frontend")}`);
for (const url of getLanFrontendUrls()) console.log(`Local network frontend: ${url}`);

openWhenReady().catch((error) => {
  writeLog(`startup readiness failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  console.error(`Failed to open browser: ${error instanceof Error ? error.message : String(error)}`);
  shutdown();
  setTimeout(() => process.exit(1), 50);
});

async function openWhenReady() {
  if (process.env.NO_BROWSER_OPEN === "1") {
    if (!processes.length) await finishLauncher(0);
    return;
  }
  await waitForHttp(backendUrl, 45_000);
  await waitForHttp(frontendUrl, 45_000);
  openUrl(frontendUrl);
  console.log(`Opened local frontend: ${frontendUrl}`);
  if (!processes.length) await finishLauncher(0);
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // Server is still warming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function isHttpOk(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

function spawnManaged(name, command, args, childEnv) {
  writeLog(`starting ${name}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stream = createWriteStream(path.join(logRoot, `${name}.log`), { flags: "a", encoding: "utf8" });
  logStreams.add(stream);
  const forward = (chunk, level) => {
    const text = chunk.toString();
    stream.write(text);
    sessionStream.write(`[${name}/${level}] ${text}`);
    if (level === "stderr") process.stderr.write(text);
    else process.stdout.write(text);
  };
  child.stdout?.on("data", (chunk) => forward(chunk, "stdout"));
  child.stderr?.on("data", (chunk) => forward(chunk, "stderr"));
  child.on("error", (error) => {
    writeLog(`${name} spawn error: ${error.stack || error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      writeLog(`${name} stopped unexpectedly: code=${code ?? "none"}, signal=${signal || "none"}`);
      const exitCode = code ?? 1;
      console.error(`[local-web-app] ${name} stopped unexpectedly: code=${exitCode}, signal=${signal || "none"}`);
      shutdown();
      setTimeout(() => process.exit(exitCode), 50);
    }
  });
  child.on("close", () => {
    stream.end();
    logStreams.delete(stream);
  });
  return { name, child };
}

async function finishLauncher(exitCode) {
  await releaseStartupLock();
  await closeLogs();
  process.exit(exitCode);
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill();
  }
}

function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  sessionStream?.write(line);
}

async function acquireStartupLock() {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    lockHandle = await fs.open(lockPath, "wx");
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stat = await fs.stat(lockPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < 90_000) throw new Error(`startup lock exists: ${lockPath}`);
    await fs.rm(lockPath, { force: true });
    lockHandle = await fs.open(lockPath, "wx");
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  }
}

async function releaseStartupLock() {
  try { await lockHandle?.close(); } catch {}
  lockHandle = null;
  await fs.rm(lockPath, { force: true }).catch(() => {});
}

async function closeLogs() {
  for (const stream of logStreams) {
    await new Promise((resolve) => stream.end(resolve));
  }
  logStreams.clear();
}

function openUrl(url) {
  const child = process.platform === "win32"
    ? spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
    : process.platform === "darwin"
      ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function getLanFrontendUrls() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      urls.push(`http://${entry.address}:5173/`);
    }
  }
  return [...new Set(urls)];
}
