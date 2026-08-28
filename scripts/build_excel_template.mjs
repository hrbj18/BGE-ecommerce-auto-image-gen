import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";

const workspaceDir = path.resolve(import.meta.dirname, "..");
const outputPath = path.join(workspaceDir, "templates", "本地自动化作图任务模板.xlsx");

const taskRows = [
  {
    SKU: "HOME001",
    品牌ID: "BRAND_A",
    商品名称: "示例家居商品",
    类目: "家居日用",
    本地素材文件夹: "input/HOME001",
    主商品图文件名: "product-main.png",
    卖点: "舒适耐用；容易清洁；简约百搭",
    规格参数: "材质：示例材质；尺寸：请填写；颜色：请填写",
    参考关键词: "家居 好物",
    参考商品链接: "",
    禁用元素: "不要促销爆炸贴；不要平台水印",
    特殊要求: "原生模式会直接生成带中文文字的 2K 成品图",
    主图数量: 5,
    生成详情页: "是",
    图片比例: "1:1",
    状态: "示例",
    输出文件夹: "output/HOME001",
    生成报告: "",
    错误信息: ""
  },
  {
    SKU: "FASHION001",
    品牌ID: "BRAND_B",
    商品名称: "示例服饰商品",
    类目: "服饰配件",
    本地素材文件夹: "input/FASHION001",
    主商品图文件名: "product-main.png",
    卖点: "版型利落；触感舒适；通勤百搭",
    规格参数: "面料：请填写；尺码：请填写；颜色：请填写",
    参考关键词: "通勤 穿搭",
    参考商品链接: "",
    禁用元素: "不要虚假材质；不要明星肖像",
    特殊要求: "不出现可识别人脸；原生模式会直接生成带中文文字的 2K 成品图",
    主图数量: 5,
    生成详情页: "是",
    图片比例: "1:1",
    状态: "示例",
    输出文件夹: "output/FASHION001",
    生成报告: "",
    错误信息: ""
  },
  {
    SKU: "BEAUTY001",
    品牌ID: "BRAND_A",
    商品名称: "示例美妆商品",
    类目: "美妆个护",
    本地素材文件夹: "input/BEAUTY001",
    主商品图文件名: "product-main.png",
    卖点: "质地轻盈；使用方便；包装精致",
    规格参数: "净含量：请填写；保质期：请填写；产地：请填写",
    参考关键词: "美妆 护理",
    参考商品链接: "",
    禁用元素: "不要医疗功效暗示；不要前后效果夸大",
    特殊要求: "原生模式会直接生成带中文文字的 2K 成品图",
    主图数量: 5,
    生成详情页: "是",
    图片比例: "1:1",
    状态: "示例",
    输出文件夹: "output/BEAUTY001",
    生成报告: "",
    错误信息: ""
  }
];

const brandRows = [
  {
    品牌ID: "BRAND_A",
    品牌名称: "示例品牌 A",
    Logo路径: "brands/BRAND_A/logo.png",
    主色: "#14213d",
    辅色: "#fca311",
    背景色: "#f7f4ef",
    标题字体: "PingFang SC",
    正文字体: "PingFang SC",
    品牌定位: "克制、可靠、具有生活质感",
    视觉关键词: "高级；温暖；干净；自然光",
    品牌口号: "把好设计带进日常",
    风格参考图目录: "brands/BRAND_A/references",
    统一禁用规则: "不要竞品商标；不要水印；不要廉价促销风"
  },
  {
    品牌ID: "BRAND_B",
    品牌名称: "示例品牌 B",
    Logo路径: "brands/BRAND_B/logo.png",
    主色: "#2f3e46",
    辅色: "#84a98c",
    背景色: "#f5f7f4",
    标题字体: "PingFang SC",
    正文字体: "PingFang SC",
    品牌定位: "现代、轻盈、面向都市年轻用户",
    视觉关键词: "现代；清爽；留白；编辑感",
    品牌口号: "轻一点，自在一点",
    风格参考图目录: "brands/BRAND_B/references",
    统一禁用规则: "不要高饱和撞色；不要复杂花字；不要水印"
  }
];

const guideRows = [
  ["字段/步骤", "必填", "说明"],
  ["使用流程", "", "关闭 Excel → 填写品牌配置与作图任务 → 将状态改为“待生成” → 让 Codex 在项目根目录运行 npm run excel"],
  ["SKU", "是", "任务唯一编号，同一工作簿内不可重复。"],
  ["品牌ID", "是", "必须存在于“品牌配置”工作表。"],
  ["本地素材文件夹", "是", "相对项目根目录，例如 input/SKU001。"],
  ["主商品图文件名", "是", "必须位于素材文件夹中，建议 PNG/JPG/WebP。"],
  ["卖点/规格参数", "建议", "使用中文分号分隔，详情页会自动排版。"],
  ["参考商品链接", "", "当前交付版不使用外部商品链接，可留空；系统使用本地商品图与参考案例学习库。"],
  ["状态", "是", "只有“待生成”会执行；系统回写处理中、已完成、部分失败或失败。"],
  ["IMAGE_COMPOSITION_MODE", "", "native：GPT 直接生成 2K 中文成品图；template：AI 底图 + 本地模板叠字。"],
  ["Logo路径", "模板模式必填", "template 模式必须提供 Logo；native 模式可留空，建议仍填写品牌名称、定位和视觉关键词。"],
  ["品牌颜色", "是", "使用 #RRGGBB 格式，例如 #14213d。"],
  ["外部参考搜索", "", "当前交付版默认关闭，请保持 .env 中 SKIP_REFERENCE_SEARCH=true。"],
  ["API Key", "", "只保存在本地 .env，不要填写到 Excel。"]
];

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(taskRows), "作图任务");
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(brandRows), "品牌配置");
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(guideRows), "字段说明");

workbook.Sheets["作图任务"]["!cols"] = [
  { wch: 14 }, { wch: 14 }, { wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 24 },
  { wch: 22 }, { wch: 36 }, { wch: 40 }, { wch: 22 }, { wch: 52 }, { wch: 32 },
  { wch: 28 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 24 },
  { wch: 42 }, { wch: 42 }
];
workbook.Sheets["品牌配置"]["!cols"] = [
  { wch: 14 }, { wch: 18 }, { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
  { wch: 18 }, { wch: 18 }, { wch: 32 }, { wch: 32 }, { wch: 26 }, { wch: 30 }, { wch: 36 }
];
workbook.Sheets["字段说明"]["!cols"] = [{ wch: 22 }, { wch: 10 }, { wch: 80 }];

await fs.mkdir(path.dirname(outputPath), { recursive: true });
XLSX.writeFile(workbook, outputPath);
console.log(outputPath);
