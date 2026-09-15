import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const rootDir = process.cwd();
const resultsFile = path.resolve(process.argv[2] || path.join(rootDir, ".local-web", "platform-style-paid-results.json"));
const outputDir = path.resolve(process.argv[3] || path.join(rootDir, "已完成", "平台风格对比-海客鼠标-20260914"));
const results = JSON.parse(await fs.readFile(resultsFile, "utf8"));

if (!Array.isArray(results) || results.length !== 10 || results.some((item) => item.status !== "done")) {
  throw new Error("平台测试结果必须包含 10 个已完成任务。投图未完成时不会合成对比图。");
}

await fs.mkdir(outputDir, { recursive: true });

const canvasWidth = 1800;
const canvasHeight = 1960;
const outerX = 56;
const imageTopOffsets = [220, 1130];
const mainSize = 760;
const detailWidth = 428;
const imageHeight = 760;
const gap = 34;
const imageXs = [outerX, outerX + mainSize + gap, outerX + mainSize + gap + detailWidth + gap];
const files = [];

for (let pairIndex = 0; pairIndex < results.length / 2; pairIndex += 1) {
  const pair = results.slice(pairIndex * 2, pairIndex * 2 + 2);
  const composites = [
    { input: svgLabel(canvasWidth, 118, `海客鼠标 · 平台风格对比 ${pairIndex + 1}/5`, 44, "#16202a", "#f4f7f8"), top: 0, left: 0 },
  ];

  for (let row = 0; row < pair.length; row += 1) {
    const item = pair[row];
    const taskDir = path.join(rootDir, "已完成", item.outputFolder);
    const labelTop = imageTopOffsets[row] - 82;
    composites.push({
      input: svgLabel(canvasWidth - outerX * 2, 62, item.platform, 34, "#ffffff", row === 0 ? "#16796f" : "#334155"),
      top: labelTop,
      left: outerX,
    });

    const sourceFiles = [
      path.join(taskDir, "main", "01-商品首图.png"),
      path.join(taskDir, "detail", "01-核心主张.png"),
      path.join(taskDir, "detail", "02-用户顾虑.png"),
    ];
    const targetWidths = [mainSize, detailWidth, detailWidth];
    for (let index = 0; index < sourceFiles.length; index += 1) {
      const input = await sharp(sourceFiles[index])
        .resize(targetWidths[index], imageHeight, { fit: "contain", background: "#ffffff" })
        .jpeg({ quality: 91, chromaSubsampling: "4:4:4" })
        .toBuffer();
      composites.push({ input, top: imageTopOffsets[row], left: imageXs[index] });
    }
  }

  const safeNames = pair.map((item) => String(item.platform).replace(/[\\/:*?"<>|]/g, "-")).join("-vs-");
  const outputPath = path.join(outputDir, `${String(pairIndex + 1).padStart(2, "0")}-${safeNames}.jpg`);
  await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: "#eef2f3" } })
    .composite(composites)
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toFile(outputPath);
  files.push(outputPath);
  console.log(outputPath);
}

await fs.writeFile(path.join(outputDir, "对比任务.json"), JSON.stringify({
  productName: "海客鼠标",
  createdAt: new Date().toISOString(),
  sourceResults: results,
  comparisonFiles: files.map((file) => path.basename(file)),
}, null, 2), "utf8");

function svgLabel(width, height, text, fontSize, color, background) {
  const escaped = String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${background}"/>
    <text x="32" y="50%" dominant-baseline="middle" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="${fontSize}" font-weight="700" fill="${color}">${escaped}</text>
  </svg>`);
}
