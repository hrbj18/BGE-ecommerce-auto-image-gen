import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const bundledNodeModules = [
  process.env.CODEX_NODE_MODULES
].filter(Boolean) as string[];

export async function importOptional<T = unknown>(moduleName: string): Promise<T | null> {
  try {
    return (await import(moduleName)) as T;
  } catch {
    for (const nodeModulesPath of bundledNodeModules) {
      try {
        const resolved = require.resolve(moduleName, {
          paths: [nodeModulesPath, path.dirname(nodeModulesPath)]
        });
        return (await import(resolved)) as T;
      } catch {
        // Try next path.
      }
    }
  }
  return null;
}
