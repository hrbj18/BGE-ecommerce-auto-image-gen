const categoryPatterns = [
  {
    pattern: /破壁机|搅拌机|料理机|豆浆机|果汁机|榨汁机|blender|mixer|smoothie/i,
    zh: "厨房小家电 / 破壁机",
    en: "Kitchen Blenders",
  },
  {
    pattern: /机器人|robot|AI陪伴|智能对话|LED表情|豆包|豆宝|deepseek/i,
    zh: "AI陪伴机器人 / 儿童智能玩具 / 桌面潮玩",
    en: "AI Companion Robots / Smart Toys",
  },
  {
    pattern: /电动车|自行车|车篮|篮筐|前篮|后篮|骑行|bike basket|bicycle basket/i,
    zh: "骑行配件 / 电动车车篮",
    en: "Bike & E-Bike Storage Accessories",
  },
  {
    pattern: /鞋|shoe|sneaker|footwear/i,
    zh: "鞋类",
    en: "Footwear",
  },
  {
    pattern: /垃圾袋|trash bag|抽绳|艾草|除臭|防臭/i,
    zh: "家用垃圾袋",
    en: "Trash Bags",
  },
  {
    pattern: /雨伞|伞|umbrella/i,
    zh: "伞具",
    en: "Umbrellas",
  },
  {
    pattern: /牛至油|oregano\s*oil|膳食补充剂|营养补充剂|保健品|软胶囊|胶囊|capsules?|softgels?|dietary\s*supplement|supplement/i,
    zh: "膳食补充剂 / 营养补充品",
    en: "Dietary Supplements",
  },
  {
    pattern: /水壶|水杯|保温杯|water\s*bottle|drinking\s*bottle|drinkware|cup/i,
    zh: "杯壶水具",
    en: "Drinkware",
  },
  {
    pattern: /椅|凳|chair|stool/i,
    zh: "家居椅凳",
    en: "Home Seating",
  },
];

export function inferCategoryFromSource(source = "", outputLanguage = "") {
  const text = String(source || "");
  const match = categoryPatterns.find(({ pattern }) => pattern.test(text));
  if (!match) return "";
  return outputLanguage === "English" ? match.en : match.zh;
}
