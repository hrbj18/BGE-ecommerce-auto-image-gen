import { spawnSync } from "node:child_process";

export function createOnceAsyncFinalizer(handler) {
  let promise = null;
  return (...args) => {
    if (!promise) promise = Promise.resolve().then(() => handler(...args));
    return promise;
  };
}

export async function terminateProcessTree(child, options = {}) {
  if (!child?.pid) return;
  const platform = options.platform ?? process.platform;
  const graceMs = Math.max(100, Number(options.graceMs || 1500));
  if (child.exitCode !== null || child.signalCode) return;

  if (platform === "win32") {
    const run = options.spawnSync ?? spawnSync;
    run("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await waitForExit(child, graceMs);
    return;
  }

  child.kill("SIGTERM");
  const exited = await waitForExit(child, graceMs);
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

export function windowsTaskkillArgs(pid) {
  return ["/pid", String(pid), "/t", "/f"];
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
