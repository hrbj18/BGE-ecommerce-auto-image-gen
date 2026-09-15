import fs from "node:fs/promises";
import path from "node:path";

const marker = process.env.LOCAL_WEB_TEST_MARKER;
const previousMarker = marker ? await fs.readFile(marker, "utf8").catch(() => "") : "";
const previousRuns = previousMarker.split(/\r?\n/).filter(Boolean).length;
if (marker) {
  await fs.appendFile(marker, `${process.env.TARGET_TASK_ID || "unknown"}|${process.env.IMAGE_PROVIDER || "unknown"}\n`, "utf8");
}

if (process.env.LOCAL_WEB_TEST_WORKFLOW_MODE === "hang") {
  setInterval(() => {}, 1000);
} else if (process.env.LOCAL_WEB_TEST_WORKFLOW_MODE === "always-fail"
    || (process.env.LOCAL_WEB_TEST_WORKFLOW_MODE === "fail-then-complete" && previousRuns === 0)) {
  console.error("No available compatible accounts (HTTP 503 capacity)");
  process.exit(1);
} else if (process.env.LOCAL_WEB_TEST_WORKFLOW_MODE === "interrupt-once" && previousRuns === 0) {
  setTimeout(() => process.exit(1), 5_000);
} else {
  const outputRoot = process.env.DROP_OUTPUT_DIR;
  const taskDir = process.env.TARGET_TASK_DIR;
  if (outputRoot && taskDir) {
    const outputDir = path.join(outputRoot, path.basename(taskDir));
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "folder-status.json"), JSON.stringify({
      taskId: process.env.TARGET_TASK_ID,
      productName: process.env.TARGET_PRODUCT_NAME,
      status: "已完成",
      updatedAt: new Date().toISOString(),
    }), "utf8");
  }
  process.exit(0);
}
