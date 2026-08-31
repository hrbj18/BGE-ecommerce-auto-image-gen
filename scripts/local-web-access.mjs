import { timingSafeEqual } from "node:crypto";

export function requestClientAddress(req) {
  const socketAddress = normalizeAddress(req.socket?.remoteAddress || "");
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return isLoopbackAddress(socketAddress) && forwarded ? normalizeAddress(forwarded) : socketAddress || "unknown";
}

export function normalizeAccessMode(value) {
  return String(value || "").trim().toLowerCase() === "token" ? "token" : "off";
}

export function authorizeWriteRequest(req, accessToken, accessMode = "off") {
  if (normalizeAccessMode(accessMode) === "off") return { ok: true, mode: "open" };
  const configured = String(accessToken || "").trim();
  if (!configured) {
    if (isLoopbackAddress(requestClientAddress(req))) return { ok: true, mode: "loopback" };
    return { ok: false, statusCode: 401, code: "LAN_TOKEN_REQUIRED", message: "局域网写操作需要配置并输入内部访问令牌。" };
  }
  const authorization = String(req.headers?.authorization || "");
  const headerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || String(req.headers?.["x-internal-token"] || "").trim();
  if (!safeTokenEqual(configured, headerToken)) {
    return { ok: false, statusCode: 401, code: "UNAUTHORIZED", message: "内部访问令牌无效，请重新输入。" };
  }
  return { ok: true, mode: "token" };
}

export function corsOriginForRequest(req, allowedOrigins = "") {
  const origin = String(req.headers?.origin || "").trim();
  if (!origin) return "";
  const explicit = new Set(String(allowedOrigins || "").split(",").map((value) => value.trim()).filter(Boolean));
  if (explicit.has(origin)) return origin;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = String(req.headers?.["x-forwarded-host"] || "").trim();
    const host = forwardedHost || String(req.headers?.host || "").trim();
    if (host && originUrl.host === host) return origin;
    if (isLoopbackAddress(originUrl.hostname) && isLoopbackAddress(requestClientAddress(req))) return origin;
  } catch {
    return "";
  }
  return "";
}

export function isLoopbackAddress(value) {
  const address = normalizeAddress(value);
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function normalizeAddress(value) {
  return String(value || "").trim().replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "").toLowerCase();
}

function safeTokenEqual(expected, actual) {
  if (!actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
