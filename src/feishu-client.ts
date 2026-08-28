import fs from "node:fs/promises";
import { openAsBlob } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.ts";
import type { FeishuAttachment, FeishuClient, FeishuUploadedFile, RawFeishuRecord } from "./types.ts";
import { FIELDS } from "./field-map.ts";
import { downloadToFile, extensionFromMimeType } from "./fs-utils.ts";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class OpenApiFeishuClient implements FeishuClient {
  private readonly config: AppConfig;
  private tokenCache: TokenCache | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async listPendingTasks(limit: number): Promise<RawFeishuRecord[]> {
    const response = await this.request<{
      data?: {
        items?: unknown[];
      };
    }>(
      `/bitable/v1/apps/${this.config.feishu.baseAppToken}/tables/${this.config.feishu.tableId}/records/search?page_size=${limit}`,
      {
        method: "POST",
        json: {
          filter: {
            conjunction: "and",
            conditions: [
              {
                field_name: FIELDS.status,
                operator: "is",
                value: ["待生成"]
              }
            ]
          }
        }
      }
    );
    return (response.data?.items ?? []).map(normalizeRecord);
  }

  async findTaskBySku(sku: string): Promise<RawFeishuRecord | null> {
    const response = await this.request<{
      data?: {
        items?: unknown[];
      };
    }>(
      `/bitable/v1/apps/${this.config.feishu.baseAppToken}/tables/${this.config.feishu.tableId}/records/search?page_size=1`,
      {
        method: "POST",
        json: {
          filter: {
            conjunction: "and",
            conditions: [
              {
                field_name: FIELDS.sku,
                operator: "is",
                value: [sku]
              }
            ]
          }
        }
      }
    );
    const first = response.data?.items?.[0];
    return first ? normalizeRecord(first) : null;
  }

  async updateRecord(recordId: string, fields: Record<string, unknown>): Promise<void> {
    await this.request(
      `/bitable/v1/apps/${this.config.feishu.baseAppToken}/tables/${this.config.feishu.tableId}/records/${recordId}`,
      {
        method: "PUT",
        json: { fields }
      }
    );
  }

  async downloadAttachment(
    attachment: FeishuAttachment,
    destinationPath: string,
    context: { recordId: string; fieldName: string }
  ): Promise<void> {
    if (attachment.tmpUrl) {
      await downloadToFile(attachment.tmpUrl, destinationPath);
      return;
    }
    if (attachment.url) {
      await downloadToFile(attachment.url, destinationPath);
      return;
    }
    if (!attachment.fileToken) {
      throw new Error(`Attachment has no file token or URL: ${attachment.name ?? "unnamed"}`);
    }

    const token = await this.getTenantAccessToken();
    const url = new URL(`${FEISHU_API_BASE}/drive/v1/medias/${encodeURIComponent(attachment.fileToken)}/download`);
    url.searchParams.set("extra", JSON.stringify({
      bitablePerm: {
        tableId: this.config.feishu.tableId,
        recordId: context.recordId,
        fieldName: context.fieldName
      }
    }));
    await downloadToFile(url.toString(), destinationPath, {
      Authorization: `Bearer ${token}`
    });
  }

  async uploadBitableFile(filePath: string): Promise<FeishuUploadedFile> {
    const token = await this.getTenantAccessToken();
    const stat = await fs.stat(filePath);
    const form = new FormData();
    form.set("file_name", path.basename(filePath));
    form.set("parent_type", "bitable_file");
    form.set("parent_node", this.config.feishu.baseAppToken);
    form.set("size", String(stat.size));
    form.set("file", await openAsBlob(filePath), path.basename(filePath));

    const response = await fetch(`${FEISHU_API_BASE}/drive/v1/medias/upload_all`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });
    const data = await parseFeishuResponse<{
      data?: {
        file_token?: string;
        fileToken?: string;
        token?: string;
        url?: string;
      };
    }>(response);
    const fileToken = data.data?.file_token ?? data.data?.fileToken ?? data.data?.token;
    if (!fileToken) {
      throw new Error(`Feishu upload did not return file token for ${filePath}`);
    }
    return {
      fileToken,
      name: path.basename(filePath),
      url: data.data?.url
    };
  }

  async uploadMessageImage(filePath: string): Promise<string> {
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    form.set("image_type", "message");
    form.set("image", await openAsBlob(filePath), path.basename(filePath));

    const response = await fetch(`${FEISHU_API_BASE}/im/v1/images`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });
    const data = await parseFeishuResponse<{
      data?: {
        image_key?: string;
        imageKey?: string;
      };
    }>(response);
    const imageKey = data.data?.image_key ?? data.data?.imageKey;
    if (!imageKey) {
      throw new Error(`Feishu image upload did not return image_key for ${filePath}`);
    }
    return imageKey;
  }

  async sendImageMessage(chatId: string, imageKey: string): Promise<void> {
    await this.request(`/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      json: {
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey })
      }
    });
  }

  async sendTextMessage(chatId: string, text: string): Promise<void> {
    await this.request(`/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      json: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text })
      }
    });
  }

  private async request<T = unknown>(
    endpoint: string,
    options: { method: string; json?: unknown }
  ): Promise<T> {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`${FEISHU_API_BASE}${endpoint}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: options.json === undefined ? undefined : JSON.stringify(options.json)
    });
    return parseFeishuResponse<T>(response);
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - now > 60_000) {
      return this.tokenCache.token;
    }

    const response = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        app_id: this.config.feishu.appId,
        app_secret: this.config.feishu.appSecret
      })
    });
    const data = await parseFeishuResponse<{
      tenant_access_token?: string;
      expire?: number;
    }>(response);
    if (!data.tenant_access_token) {
      throw new Error("Feishu tenant_access_token response is missing token.");
    }
    this.tokenCache = {
      token: data.tenant_access_token,
      expiresAt: now + (data.expire ?? 7200) * 1000
    };
    return data.tenant_access_token;
  }
}

async function parseFeishuResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Feishu response is not JSON: HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  const code = Number(data.code ?? 0);
  if (!response.ok || code !== 0) {
    const message = String(data.msg ?? data.message ?? text);
    throw new Error(`Feishu API error HTTP ${response.status} code ${code}: ${message}`);
  }
  return data as T;
}

function normalizeRecord(item: unknown): RawFeishuRecord {
  const raw = item as Record<string, unknown>;
  const fields = (raw.fields && typeof raw.fields === "object" ? raw.fields : {}) as Record<string, unknown>;
  const recordId = String(raw.record_id ?? raw.recordId ?? "");
  if (!recordId) {
    throw new Error("Feishu record is missing record_id.");
  }
  return {
    recordId,
    fields,
    recordUrl: typeof raw.record_url === "string" ? raw.record_url : typeof raw.recordUrl === "string" ? raw.recordUrl : undefined
  };
}

export function destinationPathForAttachment(baseDir: string, index: number, attachment: FeishuAttachment): string {
  const name = attachment.name || `product-${index + 1}${extensionFromMimeType(attachment.type || "")}`;
  return path.join(baseDir, `${String(index + 1).padStart(2, "0")}-${sanitizeFileName(name)}`);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|#%{}^~[\]`;]/g, "-");
}
