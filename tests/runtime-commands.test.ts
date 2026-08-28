import test from "node:test";
import assert from "node:assert/strict";
import { createPnpmCommand } from "../scripts/runtime-commands.mjs";

test("runtime command reuses the pnpm entry point that launched the process", () => {
  const result = createPnpmCommand(["run", "folder"], {
    env: { npm_execpath: "C:\\tools\\pnpm\\pnpm.mjs" },
    platform: "win32",
    nodeExecutable: "C:\\tools\\node.exe",
  });
  assert.deepEqual(result, {
    command: "C:\\tools\\node.exe",
    args: ["C:\\tools\\pnpm\\pnpm.mjs", "run", "folder"],
  });
});

test("runtime command falls back to the portable Windows pnpm launcher", () => {
  assert.deepEqual(createPnpmCommand(["run", "web"], { env: {}, platform: "win32" }), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "pnpm.cmd", "run", "web"],
  });
});

test("runtime command uses pnpm from PATH on Unix-like systems", () => {
  assert.deepEqual(createPnpmCommand(["test"], { env: {}, platform: "linux" }), {
    command: "pnpm",
    args: ["test"],
  });
});

