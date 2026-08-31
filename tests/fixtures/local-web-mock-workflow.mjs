import fs from "node:fs/promises";

const marker = process.env.LOCAL_WEB_TEST_MARKER;
if (marker) await fs.appendFile(marker, `${process.env.TARGET_TASK_ID || "unknown"}\n`, "utf8");

if (process.env.LOCAL_WEB_TEST_WORKFLOW_MODE === "hang") {
  setInterval(() => {}, 1000);
} else {
  process.exit(0);
}
