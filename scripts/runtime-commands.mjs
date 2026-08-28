/**
 * Build a pnpm invocation without assuming a Codex-bundled runtime path.
 * When launched by pnpm, npm_execpath points at the exact pnpm entry file.
 * Direct `node` launches fall back to the pnpm executable on PATH.
 */
export function createPnpmCommand(args, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const npmExecPath = String(env.npm_execpath || "").trim();

  if (npmExecPath && /pnpm(?:\.c?js|\.mjs)?$/i.test(npmExecPath.replace(/\\/g, "/"))) {
    return { command: nodeExecutable, args: [npmExecPath, ...args] };
  }
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", ...args] };
  }
  return { command: "pnpm", args: [...args] };
}

