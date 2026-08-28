import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapWorkspace } from "../scripts/bootstrap-workspace.mjs";

test("bootstrap creates a safe first-run workspace without replacing local config", async () => {
  const root = await mkdtemp(join(tmpdir(), "bge-bootstrap-"));
  try {
    await writeFile(join(root, ".env.example"), "OPENAI_API_KEY=\n", "utf8");
    const first = await bootstrapWorkspace(root);
    assert.ok(first.created.includes(".env"));
    assert.ok(first.created.includes("待作图/需求模板.md"));
    assert.equal(await readFile(join(root, ".env"), "utf8"), "OPENAI_API_KEY=\n");

    await writeFile(join(root, ".env"), "LOCAL_ONLY=preserve-me\n", "utf8");
    const second = await bootstrapWorkspace(root);
    assert.ok(second.preserved.includes(".env"));
    assert.equal(await readFile(join(root, ".env"), "utf8"), "LOCAL_ONLY=preserve-me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
