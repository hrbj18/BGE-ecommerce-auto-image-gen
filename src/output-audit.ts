export interface GeneratedVisualAuditExpected {
  role: "main" | "detail";
  index: number;
  title: string;
}

export interface GeneratedVisualAuditItem extends GeneratedVisualAuditExpected {
  passed: boolean;
  identityMatch: boolean;
  sellingPointShown: boolean;
  noForbiddenObjects: boolean;
  sceneDistinct: boolean;
  artDirectionMatch: boolean;
  copyLanguageCorrect: boolean;
  reasons: string[];
}

export interface GeneratedVisualAuditReport {
  enabled: boolean;
  source: "openai-vision" | "unavailable";
  passed: boolean;
  items: GeneratedVisualAuditItem[];
  warnings: string[];
  generatedAt?: string;
  responseItemCount?: number;
  matchedItemCount?: number;
}

export function skippedGeneratedVisualAudit(reason: string): GeneratedVisualAuditReport {
  return {
    enabled: false,
    source: "unavailable",
    passed: true,
    items: [],
    warnings: [reason]
  };
}

export function normalizeGeneratedVisualAudit(
  value: unknown,
  expected: GeneratedVisualAuditExpected[]
): GeneratedVisualAuditReport {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawItems = collectRawItems(root);
  const byKey = new Map<string, Record<string, unknown>>();
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const role = normalizeRole(item.role ?? item.type ?? item.outputType ?? item.category);
    const index = normalizeIndex(item.index ?? item.number ?? item.position ?? item.id, role);
    if (!role || !Number.isInteger(index) || index < 1) continue;
    byKey.set(`${role}:${index}`, item);
  }

  const items = expected.map((target) => {
    const raw = byKey.get(`${target.role}:${target.index}`);
    if (!raw) {
      return {
        ...target,
        passed: false,
        identityMatch: false,
        sellingPointShown: false,
        noForbiddenObjects: false,
        sceneDistinct: false,
        artDirectionMatch: false,
        copyLanguageCorrect: false,
        reasons: ["The visual audit did not return this image."]
      } satisfies GeneratedVisualAuditItem;
    }
    const identityMatch = readBoolean(raw.identityMatch, false);
    const sellingPointShown = readBoolean(raw.sellingPointShown, false);
    const noForbiddenObjects = readBoolean(raw.noForbiddenObjects, false);
    const sceneDistinct = readBoolean(raw.sceneDistinct, false);
    const artDirectionMatch = readBoolean(raw.artDirectionMatch, false);
    const copyLanguageCorrect = readBoolean(raw.copyLanguageCorrect, false);
    const reasons = stringArray(raw.reasons ?? raw.reason);
    const passed = readBoolean(raw.passed, true)
      && identityMatch
      && sellingPointShown
      && noForbiddenObjects
      && sceneDistinct
      && artDirectionMatch
      && copyLanguageCorrect;
    return {
      ...target,
      passed,
      identityMatch,
      sellingPointShown,
      noForbiddenObjects,
      sceneDistinct,
      artDirectionMatch,
      copyLanguageCorrect,
      reasons: reasons.length ? reasons : passed ? [] : ["The visual audit found a quality issue."]
    } satisfies GeneratedVisualAuditItem;
  });

  const warnings = stringArray(root.warnings);
  const matchedItemCount = expected.filter((target) => byKey.has(`${target.role}:${target.index}`)).length;
  if (matchedItemCount < expected.length) {
    warnings.push(`Visual audit response matched ${matchedItemCount}/${expected.length} expected images; unmatched images require manual review and must not trigger automatic regeneration.`);
  }
  return {
    enabled: true,
    source: "openai-vision",
    passed: items.length === expected.length && items.every((item) => item.passed),
    items,
    warnings,
    generatedAt: new Date().toISOString(),
    responseItemCount: rawItems.length,
    matchedItemCount
  };
}

export function isActionableGeneratedVisualAuditFailure(item: GeneratedVisualAuditItem): boolean {
  return !item.passed && !item.reasons.includes("The visual audit did not return this image.");
}

function collectRawItems(root: Record<string, unknown>): unknown[] {
  for (const value of [root.items, root.outputs, root.results, root.images]) {
    if (Array.isArray(value)) return value;
  }
  const nested = root.audit && typeof root.audit === "object" ? root.audit as Record<string, unknown> : null;
  if (nested) {
    for (const value of [nested.items, nested.outputs, nested.results, nested.images]) {
      if (Array.isArray(value)) return value;
    }
  }
  const grouped: unknown[] = [];
  for (const [key, role] of [["main", "main"], ["mainImages", "main"], ["detail", "detail"], ["detailImages", "detail"]] as const) {
    const values = root[key];
    if (!Array.isArray(values)) continue;
    values.forEach((value, offset) => {
      if (value && typeof value === "object") grouped.push({ role, index: offset + 1, ...(value as Record<string, unknown>) });
    });
  }
  return grouped;
}

function normalizeRole(value: unknown): "main" | "detail" | "" {
  const text = String(value ?? "").trim().toLowerCase();
  if (/^(main|main[-_ ]?image|hero|主图)$/.test(text)) return "main";
  if (/^(detail|detail[-_ ]?image|详情|详情页)$/.test(text)) return "detail";
  return "";
}

function normalizeIndex(value: unknown, role: "main" | "detail" | ""): number {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim();
  const direct = Number(text);
  if (Number.isInteger(direct)) return direct;
  const match = text.match(role ? new RegExp(`${role}[^0-9]*(\\d+)`, "i") : /(?:main|detail)[^0-9]*(\d+)/i);
  return match ? Number(match[1]) : Number.NaN;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|pass|passed|ok)$/i.test(value.trim())) return true;
    if (/^(false|no|fail|failed|bad)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}
