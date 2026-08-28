import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FolderTaskSource, productNameFromFile } from "../src/folder-task-source.ts";

test("productNameFromFile groups numbered and angle suffixes", () => {
  assert.equal(productNameFromFile("儿童黄色拖鞋.jpg"), "儿童黄色拖鞋");
  assert.equal(productNameFromFile("儿童黄色拖鞋__2.png"), "儿童黄色拖鞋");
  assert.equal(productNameFromFile("儿童黄色拖鞋_侧面.webp"), "儿童黄色拖鞋");
});

test("folder source groups images, reads public URLs, and skips completed products", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "folder-source-"));
  const inputDir = path.join(tmp, "待作图");
  const outputDir = path.join(tmp, "已完成");
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, "儿童黄色拖鞋.jpg"), Buffer.alloc(100));
  await fs.writeFile(path.join(inputDir, "儿童黄色拖鞋__2.png"), Buffer.alloc(120));
  await fs.writeFile(
    path.join(inputDir, "儿童黄色拖鞋.json"),
    JSON.stringify({ referenceImageUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"] })
  );
  await fs.writeFile(
    path.join(inputDir, "儿童黄色拖鞋.md"),
    [
      "# 商品信息",
      "产品名称：儿童黄色家居拖鞋",
      "目标平台：淘宝/天猫",
      "人群：3-8岁儿童，购买者是家长",
      "类目：儿童家居鞋",
      "特殊要求：",
      "保持鞋型和黄色一致。",
      "可以露出儿童正脸。",
      "参考关键词：",
      "儿童拖鞋 夏季 家居鞋",
      "参考商品链接：",
      "https://detail.tmall.com/item.htm?id=1048606964808",
      "禁用元素：",
      "竞品商标；平台水印",
      "规格参数：",
      "请按孩子实际脚长选择合适尺码",
      "生成详情页：否"
    ].join("\n")
  );
  const source = new FolderTaskSource({ inputDir, outputDir, workspaceDir: tmp });
  const tasks = await source.listPendingTasks(10);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].productName, "儿童黄色家居拖鞋");
  assert.equal(tasks[0].targetAudience, "3-8岁儿童，购买者是家长");
  assert.equal(tasks[0].targetPlatform, "淘宝/天猫");
  assert.equal(tasks[0].category, "儿童家居鞋");
  assert.equal(tasks[0].generateDetail, false);
  assert.equal(tasks[0].notes, "保持鞋型和黄色一致。；可以露出儿童正脸。");
  assert.equal(tasks[0].referenceKeywords, "儿童拖鞋 夏季 家居鞋");
  assert.deepEqual(tasks[0].referenceProductUrls, ["https://detail.tmall.com/item.htm?id=1048606964808"]);
  assert.equal(tasks[0].bannedElements, "竞品商标；平台水印");
  assert.equal(tasks[0].specs, "请按孩子实际脚长选择合适尺码");
  assert.equal(tasks[0].localProductImages.length, 2);
  assert.equal(tasks[0].referenceImageUrls.length, 2);
  await source.updateTask(tasks[0], { status: "部分失败", outputDir: tasks[0].outputDir });
  assert.equal((await source.listPendingTasks(10)).length, 1);
  await source.updateTask(tasks[0], { status: "已完成", outputDir: tasks[0].outputDir });
  assert.equal((await source.listPendingTasks(10)).length, 0);
  const forceSource = new FolderTaskSource({ inputDir, outputDir, workspaceDir: tmp, forceRegenerate: true });
  assert.equal((await forceSource.listPendingTasks(10)).length, 1);
});

test("folder source reads product subdirectories with local briefs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "folder-source-dir-"));
  const inputDir = path.join(tmp, "待作图");
  const outputDir = path.join(tmp, "已完成");
  const productDir = path.join(inputDir, "红色胸罩");
  await fs.mkdir(productDir, { recursive: true });
  await fs.writeFile(path.join(productDir, "红色胸罩.png"), Buffer.alloc(100));
  await fs.writeFile(
    path.join(productDir, "需求模板.md"),
    [
      "# 商品作图需求",
      "产品名称：成人红色胸罩",
      "目标平台：淘宝/天猫",
      "人群：38-40岁女性，购买者是女性",
      "类目：胸罩",
      "生成详情页：是",
      "卖点：性感，纯棉材料，穿起来很轻松，需要有模特",
      "禁用元素：竞品商标；平台水印",
      "规格参数：无"
    ].join("\n")
  );

  const source = new FolderTaskSource({ inputDir, outputDir, workspaceDir: tmp });
  const tasks = await source.listPendingTasks(10);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].productName, "成人红色胸罩");
  assert.equal(tasks[0].category, "胸罩");
  assert.equal(tasks[0].targetAudience, "38-40岁女性，购买者是女性");
  assert.equal(tasks[0].sellingPoints, "性感，纯棉材料，穿起来很轻松，需要有模特");
  assert.equal(tasks[0].generateDetail, true);
  assert.equal(tasks[0].materialDir, productDir);
  assert.equal(tasks[0].localProductImages[0], path.join(productDir, "红色胸罩.png"));
});

test("folder source targets one task directory even when product names match", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "folder-source-task-id-"));
  const inputDir = path.join(tmp, "待作图");
  const outputDir = path.join(tmp, "已完成");
  const firstDir = path.join(inputDir, "20260718-101010-a1b2c3_豆包AI机器人");
  const secondDir = path.join(inputDir, "智能豆包ai机器人");
  await fs.mkdir(firstDir, { recursive: true });
  await fs.mkdir(secondDir, { recursive: true });
  await fs.writeFile(path.join(firstDir, "机器人.png"), Buffer.alloc(100));
  await fs.writeFile(path.join(secondDir, "机器人.png"), Buffer.alloc(120));
  await fs.writeFile(
    path.join(firstDir, "需求模板.md"),
    ["产品名称：豆包AI机器人", "目标平台：Amazon", "输出语言：English"].join("\n")
  );
  await fs.writeFile(
    path.join(firstDir, "任务信息.json"),
    JSON.stringify({
      taskId: "20260718-101010-a1b2c3",
      productName: "豆包AI机器人",
      inputFolderName: "20260718-101010-a1b2c3_豆包AI机器人",
      outputFolderName: "20260718-101010-a1b2c3_豆包AI机器人",
      submittedAt: "2026-07-18T02:10:10.000Z",
      submittedAtLocal: "2026-07-18 10:10:10",
      generationRuleProfile: "amazon-overseas",
      generationRuleName: "国外亚马逊平台",
      generationRuleFile: "国外亚马逊平台.md",
      generationRuleVersion: "v1",
      generationRuleReason: "命中关键词：Amazon",
      generationRuleMatchedKeywords: ["Amazon"],
      generationRuleText: "# 国外亚马逊平台\n\n规则版本：v1"
    })
  );
  await fs.writeFile(
    path.join(secondDir, "需求模板.md"),
    ["产品名称：豆包AI机器人", "目标平台：淘宝/天猫"].join("\n")
  );

  const previousTargetDir = process.env.TARGET_TASK_DIR;
  const previousTargetName = process.env.TARGET_PRODUCT_NAME;
  process.env.TARGET_TASK_DIR = firstDir;
  process.env.TARGET_PRODUCT_NAME = "豆包AI机器人";
  try {
    const source = new FolderTaskSource({ inputDir, outputDir, workspaceDir: tmp });
    const tasks = await source.listPendingTasks(10);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].materialDir, firstDir);
    assert.equal(tasks[0].productName, "豆包AI机器人");
    assert.equal(tasks[0].sku, "20260718-101010-a1b2c3_豆包AI机器人");
    assert.equal(tasks[0].outputDir, path.join(outputDir, "20260718-101010-a1b2c3_豆包AI机器人"));
    assert.equal(tasks[0].taskId, "20260718-101010-a1b2c3");
    assert.equal(tasks[0].submittedAtLocal, "2026-07-18 10:10:10");
    assert.equal(tasks[0].generationRuleProfile, "amazon-overseas");
    assert.equal(tasks[0].generationRuleName, "国外亚马逊平台");
    assert.deepEqual(tasks[0].generationRuleMatchedKeywords, ["Amazon"]);
    await source.updateTask(tasks[0], { status: "已完成", outputDir: tasks[0].outputDir });
    const status = JSON.parse(await fs.readFile(path.join(tasks[0].outputDir || "", "folder-status.json"), "utf8"));
    assert.equal(status.generationRuleProfile, "amazon-overseas");
    assert.equal(status.generationRuleName, "国外亚马逊平台");
  } finally {
    if (previousTargetDir === undefined) delete process.env.TARGET_TASK_DIR;
    else process.env.TARGET_TASK_DIR = previousTargetDir;
    if (previousTargetName === undefined) delete process.env.TARGET_PRODUCT_NAME;
    else process.env.TARGET_PRODUCT_NAME = previousTargetName;
  }
});
