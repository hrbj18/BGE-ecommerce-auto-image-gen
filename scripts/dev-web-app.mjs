import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "admin", "scripts", "start-user-portal.ps1");
const windowsRoot = String(process.env.SystemRoot || "C:\\Windows");
const powershell = path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

if (process.platform !== "win32") {
  throw new Error("The authenticated desktop launcher currently requires Windows.");
}

const child = spawn(powershell, [
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", launcher,
  "-EntryUri", "http://127.0.0.1:8003/portal/",
], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});

process.exitCode = exitCode;
