const DEFAULT_TIMEOUT_MS = 10_000;

function text(value) {
  return String(value ?? "").trim();
}

function baseUrlFor(environment, provider) {
  const fallback = provider === "aiecho" ? "http://localhost:8080" : "https://api.openai.com/v1";
  const name = provider === "aiecho" ? "AIECHO_BASE_URL" : "OPENAI_BASE_URL";
  return text(environment[name] || fallback).replace(/\/+$/, "");
}

function hostFor(baseUrl) {
  try {
    return new URL(baseUrl).host || "已配置服务";
  } catch {
    return "已配置服务";
  }
}

function connectionReason(error) {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
  const code = text(cause && "code" in cause ? cause.code : "");
  if (error?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT") return "连接超时";
  if (/ENOTFOUND/i.test(code)) return "域名无法解析";
  if (/ECONNREFUSED/i.test(code)) return "连接被拒绝";
  return "网络连接失败";
}

/**
 * Verifies only that the configured image-provider host can be reached. A
 * non-2xx response still proves connectivity and is deliberately not treated
 * as a model or credential verdict. This endpoint never submits an image job.
 */
export async function checkImageProviderConnectivity({
  environment = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const provider = text(environment.IMAGE_PROVIDER || "aiecho").toLowerCase();
  const supportedProvider = provider === "openai" || provider === "aiecho" ? provider : "openai";
  const baseUrl = baseUrlFor(environment, supportedProvider);
  const host = hostFor(baseUrl);
  const endpoint = supportedProvider === "openai" ? `${baseUrl}/models` : baseUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  try {
    const headers = supportedProvider === "openai" && text(environment.OPENAI_API_KEY)
      ? { Authorization: `Bearer ${text(environment.OPENAI_API_KEY)}` }
      : undefined;
    const response = await fetchImpl(endpoint, { method: "GET", headers, signal: controller.signal });
    return { available: true, provider: supportedProvider, host, status: response.status };
  } catch (error) {
    return { available: false, provider: supportedProvider, host, reason: connectionReason(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function requireImageProviderConnectivity(options) {
  const result = await checkImageProviderConnectivity(options);
  if (result.available) return result;
  const error = new Error(`生图服务暂时无法连接（${result.host}，${result.reason}）。请检查当前网络、代理或服务商状态后重试；系统没有提交任何生图请求。`);
  error.code = "IMAGE_PROVIDER_UNAVAILABLE";
  error.statusCode = 503;
  throw error;
}
