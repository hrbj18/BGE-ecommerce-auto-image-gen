import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileExists, inferMimeType } from "./fs-utils.ts";

export interface PublishedImages {
  urls: string[];
  close(): Promise<void>;
}

export async function publishLocalImages(options: {
  imagePaths: string[];
  workspaceDir: string;
  provider?: "cloudflared" | "bore" | "litterbox";
}): Promise<PublishedImages> {
  const provider = options.provider ?? "cloudflared";
  if (provider === "litterbox") return uploadToLitterbox(options.imagePaths);
  const tunnelBinaryPath = provider === "bore" ? await findBore(options.workspaceDir) : await findCloudflared(options.workspaceDir);
  if (!tunnelBinaryPath) return uploadToLitterbox(options.imagePaths);
  const token = randomBytes(24).toString("hex");
  const imageMap = new Map<string, string>();
  for (const [index, imagePath] of options.imagePaths.entries()) {
    imageMap.set(`${index + 1}-${encodeURIComponent(path.basename(imagePath))}`, imagePath);
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const prefix = `/assets/${token}/`;
      if (!url.pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const key = url.pathname.slice(prefix.length);
      const imagePath = imageMap.get(key);
      if (!imagePath) {
        response.writeHead(404).end();
        return;
      }
      const data = await fs.readFile(imagePath);
      response.writeHead(200, {
        "Content-Type": await inferMimeType(imagePath),
        "Content-Length": data.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(data);
    } catch {
      response.writeHead(500).end();
    }
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("临时图片服务启动失败。");
  }

  try {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      let tunnel: ChildProcessWithoutNullStreams | undefined;
      try {
        const startedTunnel = spawnTunnel(provider, tunnelBinaryPath, address.port);
        startedTunnel.stdin.end();
        tunnel = startedTunnel;
        const publicBaseUrl = await waitForTunnelUrl(startedTunnel, provider);
        const urls = [...imageMap.keys()].map((key) => `${publicBaseUrl}/assets/${token}/${key}`);
        await verifyPublicUrl(urls[0]);
        return {
          urls,
          async close() {
            await stopProcess(tunnel);
            await closeServer(server);
          }
        };
      } catch (error) {
        lastError = error;
        await stopProcess(tunnel);
        if (attempt < 6) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } catch (error) {
    await closeServer(server);
    return uploadToLitterbox(options.imagePaths, error);
  }
}

async function findCloudflared(workspaceDir: string): Promise<string | null> {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    path.join(workspaceDir, ".tools", "cloudflared"),
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared"
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function findBore(workspaceDir: string): Promise<string | null> {
  const candidates = [
    process.env.BORE_PATH,
    path.join(workspaceDir, ".tools", "bore"),
    "/opt/homebrew/bin/bore",
    "/usr/local/bin/bore"
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

function missingTunnelError(provider: "cloudflared" | "bore"): Error {
  if (provider === "bore") {
    return new Error("aiEcho 需要公网参考图 URL，但未找到 bore。请把 bore 二进制放到 .tools/bore，或在同名 JSON/MD 中填写 referenceImageUrls。");
  }
  return new Error("aiEcho 需要公网参考图 URL，但未找到 cloudflared。请安装 cloudflared，或在同名 JSON/MD 中填写 referenceImageUrls。");
}

async function uploadToLitterbox(imagePaths: string[], tunnelError?: unknown): Promise<PublishedImages> {
  const urls: string[] = [];
  for (const imagePath of imagePaths) {
    const url = await uploadOneToLitterbox(imagePath);
    await verifyPublicUrl(url);
    urls.push(url);
  }
  if (!urls.length) {
    throw tunnelError instanceof Error ? tunnelError : new Error("没有可发布的本地参考图。");
  }
  return {
    urls,
    async close() {
      // Litterbox links expire automatically; there is no local process to close.
    }
  };
}

async function uploadOneToLitterbox(imagePath: string): Promise<string> {
  const form = new FormData();
  form.set("reqtype", "fileupload");
  form.set("time", "1h");
  form.set("fileToUpload", await openAsFile(imagePath));
  const response = await fetchWithTimeout("https://litterbox.catbox.moe/resources/internals/api.php", {
    method: "POST",
    body: form
  }, 90_000);
  const body = (await response.text()).trim();
  if (!response.ok || !/^https:\/\/litter\.catbox\.moe\/\S+$/i.test(body)) {
    throw new Error(`Litterbox 上传失败：HTTP ${response.status} ${body.slice(0, 300)}`);
  }
  return body;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function openAsFile(filePath: string): Promise<File> {
  const data = await fs.readFile(filePath);
  return new File([data], path.basename(filePath), { type: await inferMimeType(filePath) });
}

function spawnTunnel(provider: "cloudflared" | "bore", binaryPath: string, port: number): ChildProcessWithoutNullStreams {
  if (provider === "bore") {
    return spawn(binaryPath, ["local", String(port), "--to", "bore.pub"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
  }
  return spawn(binaryPath, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitForTunnelUrl(process: ChildProcessWithoutNullStreams, provider: "cloudflared" | "bore"): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`${provider} 隧道启动超时：${output.slice(-800)}`)), 45_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      const match = provider === "bore"
        ? output.match(/(?:listening at|server listening at|https?:\/\/bore\.pub:)(?:\s*)?(https?:\/\/bore\.pub:\d+|\d+)/i)
        : output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        clearTimeout(timer);
        resolve(provider === "bore" ? normalizeBoreUrl(match[1] ?? match[0]) : match[0]);
      }
    };
    process.stdout.on("data", inspect);
    process.stderr.on("data", inspect);
    process.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${provider} 隧道提前退出：${code}\n${output.slice(-800)}`));
    });
  });
}

function normalizeBoreUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^http:\/\//i, "http://");
  return `http://bore.pub:${trimmed}`;
}

async function verifyPublicUrl(url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await probePublicUrl(url);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`临时图片公网地址不可访问：${url}；${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function probePublicUrl(url: string): Promise<void> {
  const head = await fetchWithTimeout(url, { method: "HEAD" }, 8_000);
  await head.body?.cancel().catch(() => undefined);
  if (head.ok) return;

  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { Range: "bytes=0-0" }
  }, 8_000);
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status}`);
  }
}

async function stopProcess(process: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!process || process.killed) return;
  process.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!process.killed) process.kill("SIGKILL");
      resolve();
    }, 1200);
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
