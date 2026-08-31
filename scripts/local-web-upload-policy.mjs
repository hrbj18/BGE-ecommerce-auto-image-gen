import sharp from "sharp";

const MIB = 1024 * 1024;
const allowedFormats = new Set(["jpeg", "png", "webp", "gif"]);

export class LocalWebHttpError extends Error {
  constructor(statusCode, code, message, detail = {}) {
    super(message);
    this.name = "LocalWebHttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail;
  }
}

export function readUploadLimits(env = process.env) {
  return {
    maxRequestBytes: readPositive(env.LOCAL_WEB_MAX_REQUEST_MB, 64) * MIB,
    maxFileBytes: readPositive(env.LOCAL_WEB_MAX_FILE_MB, 20) * MIB,
    maxTemplateBytes: readPositive(env.LOCAL_WEB_MAX_TEMPLATE_MB, 1) * MIB,
    maxBriefChars: readPositive(env.LOCAL_WEB_MAX_BRIEF_CHARS, 20_000),
    maxFiles: Math.floor(readPositive(env.LOCAL_WEB_MAX_REFERENCE_IMAGES, 5)),
    maxPixels: Math.floor(readPositive(env.LOCAL_WEB_MAX_IMAGE_PIXELS, 50_000_000)),
    maxDimension: Math.floor(readPositive(env.LOCAL_WEB_MAX_IMAGE_DIMENSION, 16_384)),
  };
}

export async function parseMultipartForm(req, limits, requestUrl = `http://localhost${req.url || "/"}`) {
  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > limits.maxRequestBytes) {
    throw tooLarge(`上传请求不能超过 ${formatMib(limits.maxRequestBytes)} MiB。`, { declaredLength });
  }

  let received = 0;
  let exceeded = false;
  const chunks = [];
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    received += data.length;
    if (received > limits.maxRequestBytes) {
      exceeded = true;
      continue;
    }
    chunks.push(data);
  }
  if (exceeded) throw tooLarge(`上传请求不能超过 ${formatMib(limits.maxRequestBytes)} MiB。`, { received });

  const request = new Request(requestUrl, {
    method: req.method,
    headers: req.headers,
    body: Buffer.concat(chunks),
    duplex: "half",
  });
  try {
    return await request.formData();
  } catch (error) {
    const known = findLocalWebHttpError(error);
    if (known) throw known;
    throw new LocalWebHttpError(400, "INVALID_MULTIPART", "上传表单无法解析，请检查文件后重试。", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function validateBriefInputs({ template, templateText = "", briefText = "", briefFocus = "" }, limits) {
  if (template && Number(template.size || 0) > limits.maxTemplateBytes) {
    throw tooLarge(`需求模板不能超过 ${formatMib(limits.maxTemplateBytes)} MiB。`, { filename: template.name });
  }
  for (const [label, value] of [["需求模板", templateText], ["卖点", briefText], ["作图重点", briefFocus]]) {
    if (String(value || "").length > limits.maxBriefChars) {
      throw tooLarge(`${label}不能超过 ${limits.maxBriefChars} 个字符。`, { label });
    }
  }
}

export async function validateReferenceImages(files, limits) {
  const references = Array.from(files || []);
  if (!references.length) throw new LocalWebHttpError(400, "REFERENCE_REQUIRED", "请至少上传一张参考图。");
  if (references.length > limits.maxFiles) {
    throw tooLarge(`参考图最多上传 ${limits.maxFiles} 张，当前为 ${references.length} 张。`, { count: references.length });
  }

  const validated = [];
  for (const [index, file] of references.entries()) {
    const name = String(file?.name || `参考图${index + 1}`);
    const size = Number(file?.size || 0);
    if (size <= 0) throw new LocalWebHttpError(422, "EMPTY_IMAGE", `参考图“${name}”是空文件。`, { filename: name });
    if (size > limits.maxFileBytes) {
      throw tooLarge(`参考图“${name}”不能超过 ${formatMib(limits.maxFileBytes)} MiB。`, { filename: name, size });
    }
    const data = Buffer.from(await file.arrayBuffer());
    let metadata;
    try {
      metadata = await sharp(data, { limitInputPixels: limits.maxPixels, animated: false }).metadata();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/pixel limit|limitInputPixels/i.test(message)) {
        throw tooLarge(`参考图“${name}”像素总量超过 ${limits.maxPixels.toLocaleString("zh-CN")}。`, { filename: name });
      }
      throw new LocalWebHttpError(422, "INVALID_IMAGE", `参考图“${name}”无法识别或已经损坏。`, { filename: name });
    }
    const format = String(metadata.format || "").toLowerCase();
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if (!allowedFormats.has(format) || !width || !height) {
      throw new LocalWebHttpError(415, "UNSUPPORTED_IMAGE", `参考图“${name}”不是支持的 JPG、PNG、WebP 或 GIF 图片。`, { filename: name, format });
    }
    if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) {
      throw tooLarge(
        `参考图“${name}”尺寸 ${width}×${height} 超过限制（单边 ${limits.maxDimension}，总像素 ${limits.maxPixels.toLocaleString("zh-CN")}）。`,
        { filename: name, width, height },
      );
    }
    validated.push({ file, data, format, width, height, extension: extensionForFormat(format) });
  }
  return validated;
}

export function findLocalWebHttpError(error) {
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof LocalWebHttpError || Number(current.statusCode) >= 400) return current;
    current = current.cause;
  }
  return null;
}

function tooLarge(message, detail = {}) {
  return new LocalWebHttpError(413, "PAYLOAD_TOO_LARGE", message, detail);
}

function readPositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatMib(bytes) {
  return Math.round(bytes / MIB);
}

function extensionForFormat(format) {
  if (format === "jpeg") return ".jpg";
  return `.${format}`;
}
