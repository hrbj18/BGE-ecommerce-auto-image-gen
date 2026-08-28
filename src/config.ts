import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.ts";

const DEFAULT_ENV_FILE = ".env";

export function loadDotEnv(filePath = DEFAULT_ENV_FILE): void {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    return;
  }

  const contents = fs.readFileSync(absolutePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readOptionalEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  loadDotEnv();

  const workspaceDir = path.resolve(readOptionalEnv("WORKSPACE_DIR", "."));
  const imageProvider = readOptionalEnv("IMAGE_PROVIDER", "aiecho").toLowerCase();
  if (imageProvider !== "openai" && imageProvider !== "aiecho") {
    throw new Error("IMAGE_PROVIDER must be openai or aiecho.");
  }
  const imageCompositionMode = readImageCompositionMode();
  const openAiApiKey = readOptionalEnv("OPENAI_API_KEY", "");
  const aiEchoActivationCode = readOptionalEnv("AIECHO_ACTIVATION_CODE", "");
  if (imageProvider === "openai" && !openAiApiKey) {
    throw new Error("Missing required environment variable: OPENAI_API_KEY");
  }
  if (imageProvider === "aiecho" && !aiEchoActivationCode && !localImageTestMode()) {
    throw new Error("Missing required environment variable: AIECHO_ACTIVATION_CODE");
  }

  return {
    feishu: {
      appId: readOptionalEnv("FEISHU_APP_ID", ""),
      appSecret: readOptionalEnv("FEISHU_APP_SECRET", ""),
      baseAppToken: readOptionalEnv("FEISHU_BASE_APP_TOKEN", ""),
      tableId: readOptionalEnv("FEISHU_TABLE_ID", ""),
      chatId: readOptionalEnv("FEISHU_CHAT_ID", "")
    },
    openai: {
      apiKey: openAiApiKey,
      baseUrl: readOptionalEnv("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
      imageModel: imageProvider === "aiecho" ? "gpt-2.0" : readOptionalEnv("OPENAI_IMAGE_MODEL", "gpt-image-2"),
      textModel: readOptionalEnv("OPENAI_TEXT_MODEL", "gpt-5-mini"),
      imageProvider,
      imageCompositionMode,
      aiEchoBaseUrl: readOptionalEnv("AIECHO_BASE_URL", "http://localhost:8080").replace(/\/+$/, ""),
      aiEchoActivationCode,
      aiEchoResolution: readAiEchoResolution(),
      imageTunnelProvider: readImageTunnelProvider()
    },
    worker: {
      pollIntervalMinutes: readPositiveIntegerEnv("POLL_INTERVAL_MINUTES", 5),
      maxReferences: readPositiveIntegerEnv("MAX_REFERENCES", 5),
      concurrency: readPositiveIntegerEnv("CONCURRENCY", 1),
      taskWorkbookPath: path.resolve(workspaceDir, readOptionalEnv("TASK_WORKBOOK", "templates/本地自动化作图任务模板.xlsx")),
      skipReferenceSearch: readOptionalEnv("SKIP_REFERENCE_SEARCH", "true").toLowerCase() === "true",
      forceRegenerate: readOptionalEnv("FORCE_REGENERATE", "false").toLowerCase() === "true",
      dropInputDir: path.resolve(workspaceDir, readOptionalEnv("DROP_INPUT_DIR", "待作图")),
      dropOutputDir: path.resolve(workspaceDir, readOptionalEnv("DROP_OUTPUT_DIR", "已完成"))
    },
    paths: {
      workspaceDir,
      dataDir: path.resolve(workspaceDir, readOptionalEnv("DATA_DIR", "data")),
      outputDir: path.resolve(workspaceDir, readOptionalEnv("OUTPUT_DIR", "output"))
    }
  };
}

function readAiEchoResolution(): "1k" | "2k" | "4k" {
  const value = readOptionalEnv("AIECHO_RESOLUTION", "2k").toLowerCase();
  if (value === "1k" || value === "2k" || value === "4k") return value;
  throw new Error("AIECHO_RESOLUTION must be 1k, 2k, or 4k.");
}

function readImageCompositionMode(): "template" | "native" {
  const value = readOptionalEnv("IMAGE_COMPOSITION_MODE", "template").toLowerCase();
  if (value === "template" || value === "native") return value;
  throw new Error("IMAGE_COMPOSITION_MODE must be template or native.");
}

function readImageTunnelProvider(): "cloudflared" | "bore" | "litterbox" {
  const value = readOptionalEnv("IMAGE_TUNNEL_PROVIDER", "cloudflared").toLowerCase();
  if (value === "cloudflared" || value === "bore" || value === "litterbox") return value;
  throw new Error("IMAGE_TUNNEL_PROVIDER must be cloudflared, bore, or litterbox.");
}

function localImageTestMode(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LOCAL_IMAGE_TEST_MODE?.trim() ?? "");
}
