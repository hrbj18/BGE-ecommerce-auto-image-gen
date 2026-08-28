import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function gitPaths(args) {
  const output = execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.toString("utf8").split("\0").filter(Boolean);
}

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    stdio: "ignore",
  });
} catch {
  console.error("Release audit requires an initialized Git repository.");
  process.exit(1);
}

const files = [...new Set(gitPaths(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))].sort();
const errors = [];
const allowedReference = "已完成/参考案例分析/zcool-case-library.json";
const forbiddenExact = new Set([".env", "frontend/.npmrc", ".test-targeted.log"]);
const forbiddenPrefixes = [
  "node_modules/",
  "frontend/node_modules/",
  "frontend/dist/",
  ".local-web/",
  "logs/",
  "data/",
  "output/",
  "artifacts/",
  "AI电商生图提示词/",
  "优秀案例/",
  "交付资料/",
  "开发文档/",
  "skill/",
];
const textExtensions = new Set([
  "", ".bat", ".cmd", ".css", ".html", ".js", ".json", ".jsx",
  ".md", ".mjs", ".mts", ".ps1", ".py", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const secretPatterns = [
  { label: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { label: "non-empty OPENAI_API_KEY", pattern: /^\s*OPENAI_API_KEY\s*=\s*[^\s#]+/mu },
  { label: "non-empty AIECHO_ACTIVATION_CODE", pattern: /^\s*AIECHO_ACTIVATION_CODE\s*=\s*[^\s#]+/mu },
  { label: "non-empty Feishu app secret", pattern: /^\s*FEISHU_APP_SECRET\s*=\s*[^\s#]+/mu },
];

for (const file of files) {
  const normalized = file.replace(/\\/gu, "/");
  if (forbiddenExact.has(normalized) || forbiddenPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    errors.push(`Forbidden release path: ${normalized}`);
  }
  if (normalized.includes("/__pycache__/") || normalized.endsWith(".pyc")) {
    errors.push(`Python cache must not be released: ${normalized}`);
  }
  if (normalized.startsWith("待作图/") && normalized !== "待作图/需求模板.md") {
    errors.push(`User input must not be released: ${normalized}`);
  }
  if (normalized.startsWith("已完成/") && normalized !== allowedReference) {
    errors.push(`Historical output must not be released: ${normalized}`);
  }

  const absolute = resolve(root, normalized);
  const size = statSync(absolute).size;
  if (size > 50 * 1024 * 1024) errors.push(`File exceeds 50 MiB: ${normalized}`);
  if (size <= 5 * 1024 * 1024 && textExtensions.has(extname(normalized).toLowerCase())) {
    const content = readFileSync(absolute, "utf8");
    for (const { label, pattern } of secretPatterns) {
      if (pattern.test(content)) errors.push(`${label} found in ${normalized}`);
    }
  }
}

if (!files.includes(allowedReference)) errors.push(`Required reference library is missing: ${allowedReference}`);
if (!files.includes("待作图/需求模板.md")) errors.push("Sanitized input template is missing: 待作图/需求模板.md");
const workspaceConfig = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
if (!/^packages:\s*$[\s\S]*?^\s+-\s+frontend\s*$/mu.test(workspaceConfig)) {
  errors.push("pnpm workspace must include frontend for clean-clone installs.");
}
for (const dependency of ["esbuild", "sharp"]) {
  const allowPattern = new RegExp(`^\\s{2}${dependency}:\\s+true\\s*$`, "mu");
  if (!allowPattern.test(workspaceConfig)) {
    errors.push(`pnpm allowBuilds must explicitly trust ${dependency}.`);
  }
}

if (errors.length > 0) {
  console.error(`Release audit failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const totalBytes = files.reduce((sum, file) => sum + statSync(resolve(root, file)).size, 0);
console.log(`Release audit passed: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB.`);
