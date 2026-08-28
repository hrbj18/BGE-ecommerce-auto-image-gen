import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectories = ["待作图", "已完成", "data", "output", "templates"];
const defaultDemandTemplate = `# 商品作图需求

产品名称：
目标平台：淘宝/天猫
输出语言：简体中文
人群：
类目：
生成详情页：是

卖点：
请自行分析

要求：

禁用元素：
竞品商标；平台水印；夸张促销爆炸贴；随机英文；错误中文

规格参数：
无
`;

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function bootstrapWorkspace(root = defaultRoot) {
  const absoluteRoot = resolve(root);
  const created = [];
  const preserved = [];

  for (const directory of workspaceDirectories) {
    const target = resolve(absoluteRoot, directory);
    if (await exists(target)) preserved.push(directory);
    else {
      await mkdir(target, { recursive: true });
      created.push(directory);
    }
  }

  const envExample = resolve(absoluteRoot, ".env.example");
  const envFile = resolve(absoluteRoot, ".env");
  if (!(await exists(envExample))) throw new Error("Missing .env.example; cannot create a safe local configuration.");
  if (await exists(envFile)) preserved.push(".env");
  else {
    await copyFile(envExample, envFile);
    created.push(".env");
  }

  const demandTemplate = resolve(absoluteRoot, "待作图", "需求模板.md");
  if (await exists(demandTemplate)) preserved.push("待作图/需求模板.md");
  else {
    await writeFile(demandTemplate, defaultDemandTemplate, "utf8");
    created.push("待作图/需求模板.md");
  }

  return { root: absoluteRoot, created, preserved };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await bootstrapWorkspace();
    console.log(`Workspace ready: ${result.root}`);
    console.log(`Created: ${result.created.length ? result.created.join(", ") : "none"}`);
    console.log(`Preserved: ${result.preserved.join(", ")}`);
    console.log("No API request or paid image generation was performed.");
  } catch (error) {
    console.error(`Workspace bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
