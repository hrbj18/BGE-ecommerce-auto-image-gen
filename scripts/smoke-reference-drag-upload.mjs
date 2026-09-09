import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeUrl = process.env.BGE_REFERENCE_DRAG_SMOKE_URL || "http://127.0.0.1:8002/workbench/";
const debugPort = Number(process.env.BGE_REFERENCE_DRAG_DEBUG_PORT || 9337);
const chromeCandidates = [
  process.env.BGE_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

async function pathExists(target) {
  try {
    await import("node:fs/promises").then(({ access }) => access(target));
    return true;
  } catch {
    return false;
  }
}

async function waitFor(probe, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待${label}超时。`, { cause: lastError });
}

class CdpClient {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result ?? {});
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function runtimeValue(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || "浏览器脚本执行失败。");
  }
  return response.result?.value;
}

async function elementCenter(client, selector) {
  const rect = await runtimeValue(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  assert.ok(rect, `未找到拖拽目标：${selector}`);
  return rect;
}

async function dragFiles(client, selector, files) {
  const point = await elementCenter(client, selector);
  const data = { items: [], files, dragOperationsMask: 1 };
  await client.send("Input.dispatchDragEvent", { type: "dragEnter", ...point, data });
  await client.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data });
  const activeState = await waitFor(
    () => runtimeValue(client, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      return element?.classList.contains('is-file-dragging')
        ? element.querySelector('.reference-drop-overlay')?.textContent?.replace(/\\s+/g, ' ').trim()
        : '';
    })()`),
    `${selector} 拖拽高亮`,
  );
  await client.send("Input.dispatchDragEvent", { type: "drop", ...point, data });
  return activeState;
}

async function referenceState(client) {
  return runtimeValue(client, `(() => ({
    count: document.querySelectorAll('.reference-item').length || document.querySelectorAll('.reference-thumb-strip button').length,
    summary: document.querySelector('.reference-trigger-copy strong')?.textContent || '',
    toolbar: document.querySelector('.reference-modal-toolbar strong')?.textContent || '',
    toast: document.querySelector('.toast-banner')?.textContent || '',
    names: Array.from(document.querySelectorAll('.reference-item-body > strong')).map((element) => element.textContent),
    firstRole: document.querySelector('.reference-item select')?.value || '',
    url: location.href,
  }))()`);
}

async function setFileInput(client, selector, files) {
  const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  assert.ok(nodeId, `未找到文件选择器：${selector}`);
  await client.send("DOM.setFileInputFiles", { files, nodeId });
}

async function stopBrowser(browser) {
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  const stopped = once(browser, "exit");
  browser.kill();
  await Promise.race([
    stopped,
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

async function removeTemporaryDirectory(tempRoot) {
  if (!tempRoot.startsWith(`${os.tmpdir()}${path.sep}`)) return;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function main() {
  const chromePath = await waitFor(async () => {
    for (const candidate of chromeCandidates) {
      if (await pathExists(candidate)) return candidate;
    }
    return null;
  }, "Chrome 或 Edge 可执行文件", 1_000);

  const sourceOne = path.join(projectRoot, "frontend", "public", "previews", "umbrella-main-overview.jpg");
  const sourceTwo = path.join(projectRoot, "frontend", "public", "previews", "robot-main-overview.jpg");
  assert.ok(await pathExists(sourceOne), `测试图片不存在：${sourceOne}`);
  assert.ok(await pathExists(sourceTwo), `测试图片不存在：${sourceTwo}`);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bge-reference-drag-"));
  const extraFiles = [];
  for (let index = 1; index <= 5; index += 1) {
    const target = path.join(tempRoot, `drag-extra-${index}.jpg`);
    await copyFile(sourceOne, target);
    extraFiles.push(target);
  }

  const browser = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(tempRoot, "profile")}`,
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  let client;
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return response.ok;
    }, "浏览器调试端口");

    const targetResponse = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(smokeUrl)}`,
      { method: "PUT" },
    );
    assert.equal(targetResponse.ok, true, `无法打开测试页面：${targetResponse.status}`);
    const target = await targetResponse.json();
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("DOM.enable");

    await waitFor(
      () => runtimeValue(client, "Boolean(document.querySelector('.reference-upload-card'))"),
      "主页上传卡片",
    );

    const homeOverlay = await dragFiles(client, ".reference-upload-card", [sourceOne]);
    const afterHomeDrop = await waitFor(async () => {
      const state = await referenceState(client);
      return state.summary.includes("已选 1 / 5 张") ? state : null;
    }, "主页拖拽追加");
    assert.match(homeOverlay, /松开即可添加参考图/);
    assert.match(afterHomeDrop.url, /127\.0\.0\.1:8002/);

    await runtimeValue(client, "document.querySelector('.reference-manager-trigger').click(); true");
    await waitFor(() => runtimeValue(client, "Boolean(document.querySelector('.reference-modal'))"), "参考图管理弹层");

    await setFileInput(client, ".reference-add-button input[type=file]", [sourceTwo]);
    await waitFor(async () => {
      const state = await referenceState(client);
      return state.toolbar.includes("2 / 5") ? state : null;
    }, "点击文件选择回退");

    const managerOverlay = await dragFiles(client, ".reference-modal", [extraFiles[0]]);
    const afterManagerDrop = await waitFor(async () => {
      const state = await referenceState(client);
      return state.toolbar.includes("3 / 5") ? state : null;
    }, "管理弹层拖拽追加");
    assert.match(managerOverlay, /新图片将追加到现有列表/);
    assert.equal(afterManagerDrop.firstRole, "主参考图");

    await dragFiles(client, ".reference-modal", [sourceOne]);
    const afterDuplicate = await waitFor(async () => {
      const state = await referenceState(client);
      return state.toast.includes("重复图片") ? state : null;
    }, "重复图片反馈");
    assert.equal(afterDuplicate.count, 3);

    await dragFiles(client, ".reference-modal", extraFiles.slice(1, 4));
    const afterOverflow = await waitFor(async () => {
      const state = await referenceState(client);
      return state.toolbar.includes("5 / 5") && state.toast.includes("超出 5 张上限") ? state : null;
    }, "批量拖拽上限反馈");
    assert.equal(afterOverflow.count, 5);
    assert.deepEqual(afterOverflow.names.slice(0, 3), [
      path.basename(sourceOne),
      path.basename(sourceTwo),
      path.basename(extraFiles[0]),
    ]);

    await dragFiles(client, ".reference-modal", [extraFiles[4]]);
    const afterFull = await waitFor(async () => {
      const state = await referenceState(client);
      return state.toast.includes("最多上传 5 张参考图") ? state : null;
    }, "满额拦截");
    assert.equal(afterFull.count, 5);

    process.stdout.write(`${JSON.stringify({
      url: smokeUrl,
      homeDrop: "passed",
      managerDrop: "passed",
      clickFallback: "passed",
      duplicateGuard: "passed",
      overflowGuard: "passed",
      fullLimitGuard: "passed",
      finalCount: afterFull.count,
      finalNames: afterFull.names,
    }, null, 2)}\n`);
  } finally {
    client?.close();
    await stopBrowser(browser);
    await removeTemporaryDirectory(tempRoot);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
