import type { SellingPointCoverage, SellingPointCoverageStatus } from "./types.ts";

export type StoryboardRole = "main" | "detail";

export interface StoryboardPlanInput {
  productName: string;
  sellingPoints: string[];
  explicitSellingPoints?: string[];
  derivedSellingPoints?: string[];
  isAiRobot?: boolean;
  productKind?: string;
  isEnglishMarketplace?: boolean;
  generateDetail?: boolean;
}

export interface StoryboardFrame {
  role: StoryboardRole;
  index: number;
  focus: string;
  productState: string;
  scene: string;
  layout: string;
  proof: string;
  avoidRepeat: string;
  visualTreatment?: string;
}

export interface StoryboardPlan {
  frames: StoryboardFrame[];
  audit: {
    passed: boolean;
    issues: string[];
  };
  coverage: SellingPointCoverage[];
}

const DEFAULT_POINTS = [
  "外观和品类一眼看懂",
  "核心功能有可见证据",
  "真实使用场景有代入感",
  "材质结构细节值得信任",
  "购买理由在结尾被总结"
];

function cleanPoint(value: string): string {
  return value
    .replace(/^(?:[-*•]\s*|\d+[.)、）]\s*)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pointKey(value: string): string {
  return cleanPoint(value)
    .replace(/[+＋|｜/]/g, "与")
    .replace(/[，。；：、,.!?！？\s]/g, "")
    .toLowerCase();
}

function uniquePoints(points: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of points.map(cleanPoint).filter(Boolean)) {
    const key = pointKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function pickPoint(points: string[], pattern: RegExp, fallback: string): string {
  return points.find((point) => pattern.test(point)) || fallback;
}

function pickRobotPoint(points: string[], pattern: RegExp, fallback: string): string {
  return pickPoint(points, pattern, fallback);
}

function buildRobotFrames(points: string[], productName: string, includeDetail: boolean): StoryboardFrame[] {
  const desktopPoint = pickRobotPoint(points, /潮玩|摆件|桌面|颜值|造型|外观|desktop|collectible|display|design/i, `${productName}的桌面潮玩外观`);
  const languagePoint = pickRobotPoint(points, /多语言|方言|双语|中文|英文|英语|日语|粤语|闽南语|语言学习|multilingual|bilingual|dialect|language/i, "多语言与方言互动");
  const storyPoint = pickRobotPoint(points, /讲故事|故事|成语接龙|成语|儿歌|story|idiom|nursery song/i, "讲故事与成语接龙互动");
  const voicePoint = pickRobotPoint(points, /趣味语音|语音|对话|问答|唤醒|多模型|模型|voice|conversation|question|wake/i, "趣味语音交互");
  const learningPoint = pickRobotPoint(points, /学习答疑|学习|答疑|早教|百科|课本|learning|study|tutor|homework|education/i, "学习答疑与早教陪伴");
  const jointPoint = pickRobotPoint(points, /多关节|关节|可动|动作|姿势|joint|movable|pose|motion|articulated/i, "多关节可动");
  const playPoint = pickRobotPoint(points, /玩法丰富|玩法|游戏|跳舞|play|game|dance/i, "玩法丰富");
  const childPoint = pickRobotPoint(points, /孩子|玩伴|陪伴|亲子|child|companion|family/i, "孩子贴心玩伴");
  const onlinePoint = pickRobotPoint(points, /联网|WiFi|智能聊天|云端|网络|connected|online|cloud|chat/i, "联网智能聊天");
  const batteryPoint = pickRobotPoint(points, /长续航|续航|电池|电量|battery|power|lasting|runtime/i, "长续航陪伴");
  const screenPoint = pickRobotPoint(points, /LED|表情|屏幕|科技|screen|expression|display/i, "LED表情屏互动");

  const main: StoryboardFrame[] = [
    {
      role: "main",
      index: 1,
      focus: desktopPoint,
      productState: "轻微3/4站姿或坐姿，LED使用亲和表情，四肢完整",
      scene: "书桌、展示架、台灯和少量书本组成潮玩陈列环境，桌面尺度是大场景证据",
      layout: "大主体单图，机器人占55%-70%，桌面环境提供尺度，标题置于留白区",
      proof: "用桌面摆放、外观配色和产品尺度证明潮玩摆件价值",
      avoidRepeat: "不使用原始参考图的呆站正面；后续图片不得继续使用同一桌面静物角度"
    },
    {
      role: "main",
      index: 2,
      focus: languagePoint,
      productState: "机器人缩小为正在授课的小老师，抬手指向黑板，LED为回应表情",
      scene: "教室黑板、中文/English/方言语言卡、对话气泡和孩子提问手部成为大视觉元素；语言示例只作道具，不暗示未经确认的支持数量",
      layout: "场景主视觉+机器人辅助主体的课堂构图，黑板占画面最大区域，机器人约25%-40%",
      proof: "用黑板、语言卡和不同对话关系具体证明多语言与方言互动，不能只放机器人和几行文字",
      avoidRepeat: "不能使用桌面英雄图；场景主视觉必须是语言学习环境"
    },
    {
      role: "main",
      index: 3,
      focus: storyPoint,
      productState: "坐在绘本旁或侧身指向成语卡，LED为好奇/讲故事表情",
      scene: "打开的绘本、成语接龙卡、孩子翻页动作和暖光阅读角成为大场景，机器人作为讲故事伙伴出现",
      layout: "绘本与卡牌前景+机器人侧后景的阅读构图，使用道具形成故事路径",
      proof: "用绘本、成语卡和互动动作具体证明讲故事与成语接龙，不把卖点退化为泛泛的早教文案",
      avoidRepeat: "不使用课堂黑板和语言卡；更换为阅读桌面与卡牌关系"
    },
    {
      role: "main",
      index: 4,
      focus: jointPoint,
      productState: "双臂上举、弯腿或转身形成明显动态姿势，LED表情与动作同步变化",
      scene: "简洁科技展示台，加入动作轨迹、姿势小卡和手臂/腿部关节局部放大",
      layout: "动态主体单图+两处局部放大圈，机器人占60%左右，姿势变化先于装饰",
      proof: "用抬手、弯腿、转身和关节连接处证明多关节可动，不能只写‘灵活’",
      avoidRepeat: "不能使用正面呆站或同一动作换背景；局部放大必须对应同一台产品"
    },
    {
      role: "main",
      index: 5,
      focus: batteryPoint,
      productState: "不要求完整机器人出场，可用小型机器人轮廓或LED屏插图作为识别锚点",
      scene: "大型电池能量图、从早到晚的时间线、日间学习和夜间故事两个小场景组成大视觉主体",
      layout: "信息图主视觉+小型产品插图，电池和时间线占画面最大区域，留出短文案空间",
      proof: "用全天陪伴时间线和能量视觉表达长续航，不写具体小时数、电池容量或百分比",
      avoidRepeat: "本张禁止回到完整机器人站立棚拍，不能用机器人旁边加‘长续航’四个字代替证据"
    }
  ];

  if (!includeDetail) return main;

  const detail: StoryboardFrame[] = [
    {
      role: "detail",
      index: 1,
      focus: voicePoint,
      productState: "前倾倾听或抬手回应，LED切换为倾听/回应状态",
      scene: "麦克风、声波、提问卡和孩子说话的侧脸/手部构成语音互动场景，机器人是回应证据",
      layout: "声波和提问卡形成大关系图，机器人位于前景约35%-50%，不同于主图的静态摆件",
      proof: "用倾听动作、声波和回应表情证明趣味语音交互",
      avoidRepeat: "不重复语言课堂黑板，也不只把语音文案放在机器人旁边"
    },
    {
      role: "detail",
      index: 2,
      focus: onlinePoint,
      productState: "机器人作为小型联网终端，屏幕显示连接/聊天状态",
      scene: "云端节点、WiFi连接线、家庭设备和聊天关系图成为大视觉元素，机器人只作为连接终端出现",
      layout: "网络关系图占主区域，机器人放在节点一端，采用信息图式构图",
      proof: "用连接关系和聊天气泡证明联网智能聊天，不虚构网络速度或技术参数",
      avoidRepeat: "不重复人物陪伴或学习桌场景，不能只在机器人旁边放WiFi图标"
    },
    {
      role: "detail",
      index: 3,
      focus: learningPoint,
      productState: "侧身指向问题卡或课本，腿部略弯呈讲解状态，LED为提示表情",
      scene: "课本、问题卡、黑板和孩子提问动作占据画面主要区域，机器人像桌面答疑助手一样回应",
      layout: "课本问题卡前景+机器人回应中景+黑板背景的三层构图",
      proof: "用问题、指向动作和回应表情证明学习答疑，不只写‘学习更方便’",
      avoidRepeat: "不使用联网关系图或语言课堂黑板的同一版式"
    },
    {
      role: "detail",
      index: 4,
      focus: languagePoint,
      productState: "孩子在语言卡和绘本旁提问，机器人朝向孩子回应，LED切换倾听或回应表情",
      scene: "家庭亲子阅读角、绘本、中文/English/方言语言卡、孩子提问手部和机器人形成语言陪伴关系",
      layout: "亲子互动场景构图，语言卡和绘本占主要视觉区域，机器人保持清晰可辨并与孩子建立视线关系",
      proof: "用孩子提问、语言卡和机器人回应动作同时证明多语言互动与贴心陪伴，不能只放机器人和几行文字",
      avoidRepeat: "不使用主图教室黑板的构图，换成家庭阅读空间和语言卡互动"
    },
    {
      role: "detail",
      index: 5,
      focus: playPoint,
      productState: "舞蹈、挥手、讲故事、思考等多个不同动作和LED表情",
      scene: "游戏板、动作轨迹、故事卡和互动区域成为大视觉元素，多个机器人姿势作为玩法证据",
      layout: "三宫格或四宫格，每格动作、表情、道具和视角都不同",
      proof: "用多个实际玩法状态证明玩法丰富，禁止只复制一个机器人换背景",
      avoidRepeat: "每格不得使用同一站姿、同一表情或同一镜头距离"
    },
    {
      role: "detail",
      index: 6,
      focus: screenPoint,
      productState: "近景展示蓝色LED表情、银色耳机装饰和黄黑圆润外观",
      scene: "中性科技细节展示台，屏幕微笑、倾听、眨眼三种表情做局部小窗",
      layout: "一张产品局部主视觉+三处表情/耳机放大窗，细线对应真实位置",
      proof: "用屏幕表情和可见外观细节证明互动生命感，不虚构内部元件",
      avoidRepeat: "本张只做局部信任图，不重复动作游戏或人物互动"
    },
    {
      role: "detail",
      index: 7,
      focus: jointPoint,
      productState: "正面、侧面、背面/顶部和局部关节四种视角，姿态互不相同",
      scene: "统一浅色背景，多角度结构板成为大视觉元素，保留同一机器人颜色、比例和识别细节",
      layout: "一主三辅多角度结构板，局部放大圈只指向关节、耳机、屏幕和脚底",
      proof: "用多角度和不同姿态证明同一主体的结构与可动关系",
      avoidRepeat: "禁止四格都正面站立，禁止添加未提供的按钮、接口或参数"
    },
    {
      role: "detail",
      index: 8,
      focus: childPoint,
      productState: "生活化坐姿或邀请互动手势，LED为柔和笑脸，孩子在旁边主动靠近",
      scene: "家庭客厅、学习桌或办公桌的远景收尾，桌面摆件、孩子阅读和日常陪伴元素自然共存",
      layout: "舒展远景+右下产品锚点，保留生活纵深和文案留白",
      proof: "把潮玩摆件、孩子陪伴和日常桌搭价值收束到购买决策",
      avoidRepeat: "不回到纯白棚拍，不复用主图桌面静物角度，不使用空泛品牌口号"
    }
  ];
  return [...main, ...detail];
}

function buildGenericFrames(points: string[], productName: string, includeDetail: boolean): StoryboardFrame[] {
  const resolved = uniquePoints(points).length ? uniquePoints(points) : DEFAULT_POINTS;
  const focus = (index: number, fallback: string) => resolved[index] || fallback;
  const main: StoryboardFrame[] = [
    { role: "main", index: 1, focus: focus(0, `${productName}外观识别`), productState: "最能识别商品的稳定状态", scene: "干净低干扰环境", layout: "大主体英雄单图+留白标题", proof: "证明品类、主体和第一购买理由", avoidRepeat: "不重复参考图原始构图" },
    { role: "main", index: 2, focus: focus(1, "核心功能"), productState: "与功能动作对应的使用状态", scene: "真实使用环境", layout: "左右分栏或前后景层次", proof: "通过动作或前后状态证明功能", avoidRepeat: "不复制英雄单图" },
    { role: "main", index: 3, focus: focus(2, "日常场景"), productState: "被使用或与人互动的状态", scene: "目标人群真实生活场景", layout: "人物/手部/道具与商品形成三角构图", proof: "证明为什么在这个场景中值得使用", avoidRepeat: "更换视角、人物关系和空间" },
    { role: "main", index: 4, focus: focus(3, "结构细节"), productState: "局部细节或多角度状态", scene: "中性细节展示台", layout: "一主两辅、局部放大或多角度板", proof: "证明材质、结构、接口、纹理等可见事实", avoidRepeat: "不再做完整正面静物" },
    { role: "main", index: 5, focus: focus(4, "购买决策"), productState: "最适合收尾的稳定或使用状态", scene: "礼赠、收纳或日常收尾场景", layout: "生活化收尾+短文案留白", proof: "总结最后一个购买理由", avoidRepeat: "不重复第1屏的背景和镜头" }
  ];
  if (!includeDetail) return main;
  const detail: StoryboardFrame[] = [
    { role: "detail", index: 1, focus: focus(0, "核心价值"), productState: "英雄状态", scene: "首屏环境", layout: "全幅英雄图", proof: "回答这是什么、适合谁、为什么值得买", avoidRepeat: "不把产品名当唯一卖点" },
    { role: "detail", index: 2, focus: "用户顾虑", productState: "解决顾虑的使用状态", scene: "目标用户场景", layout: "场景代入+证据并置", proof: "回应一个真实购买顾虑", avoidRepeat: "不复制首屏" },
    { role: "detail", index: 3, focus: focus(1, "功能证据"), productState: "动作或前后对比状态", scene: "功能使用近景", layout: "近景主图+一处证据标注", proof: "让功能可以被看见", avoidRepeat: "不只换文案换背景" },
    { role: "detail", index: 4, focus: focus(2, "真实使用"), productState: "与人或道具互动", scene: "家庭、办公或户外场景", layout: "人物/手部提供尺度", proof: "证明日常使用价值", avoidRepeat: "换空间和互动方式" },
    { role: "detail", index: 5, focus: focus(3, "细节信任"), productState: "局部、拆解或结构状态", scene: "中性细节环境", layout: "细节板/局部放大", proof: "证明材质结构或做工", avoidRepeat: "不再做生活远景" },
    { role: "detail", index: 6, focus: "多角度和形态", productState: "正面、侧面、背面或展开/收起", scene: "统一背景多角度展示", layout: "多宫格或一主多辅", proof: "让消费者看懂形态和关键细节", avoidRepeat: "每格视角必须不同" },
    { role: "detail", index: 7, focus: focus(4, "决策理由"), productState: "适合送礼或日常使用的状态", scene: "礼赠、收纳或家庭场景", layout: "生活化决策构图", proof: "完成最后的购买理由", avoidRepeat: "不新增无依据参数" },
    { role: "detail", index: 8, focus: "系列收尾", productState: "干净稳定收尾状态", scene: "低干扰生活环境", layout: "舒展留白收尾", proof: "回收核心卖点并保持套图一致", avoidRepeat: "不复刻首屏" }
  ];
  return [...main, ...detail];
}

function buildSupplementFrames(points: string[], productName: string, includeDetail: boolean): StoryboardFrame[] {
  const resolved = uniquePoints(points);
  const pick = (pattern: RegExp, fallback: string) => resolved.find((point) => pattern.test(point)) || fallback;
  const formula = pick(/配方|成分|复配|ingredient|formula|blend/i, "Clearly presented ingredient formula");
  const format = pick(/胶囊|软胶囊|剂型|capsule|softgel/i, "Convenient capsule format");
  const routine = pick(/日常|便携|随身|routine|portable|daily/i, "Easy everyday supplement routine");
  const packagePoint = pick(/包装|瓶身|标签|package|bottle|label/i, `${productName} package clarity`);
  const trust = pick(/品质|透明|信任|清晰|quality|clarity|trust/i, "Clear product details for confident selection");
  const main: StoryboardFrame[] = [
    { role: "main", index: 1, focus: packagePoint, productState: "upright bottle and complete outer package, label facing camera", scene: "clean marketplace studio with restrained ingredient accents and ample negative space", layout: "large package hero with a small dosage-form accent, headline in clear negative space", proof: "show the real package silhouette, cap, label hierarchy and product format without inventing claims", avoidRepeat: "do not reuse this front-facing studio hero in later screens", visualTreatment: "bright neutral daylight, accurate label colors, crisp premium product photography" },
    { role: "main", index: 2, focus: formula, productState: "real bottle used as an identity anchor beside confirmed ingredient cues", scene: "restrained ingredient relationship display using only ingredients stated by the user or visible on the package", layout: "ingredient cues and thin relationship lines lead back to the bottle; no medical body diagram", proof: "make the paired-formula relationship visible without implying treatment or clinical efficacy", avoidRepeat: "different from the package hero: ingredients and their relationship are the largest visual idea", visualTreatment: "clean editorial infographic, natural ingredient texture, controlled color palette" },
    { role: "main", index: 3, focus: format, productState: "single real capsule or softgel in macro foreground with package softly behind", scene: "sanitary close-up surface with a hand presenting the dosage form for scale", layout: "macro dosage-form hero plus small package anchor", proof: "show shape, surface and convenient format; do not invent dosage instructions", avoidRepeat: "no full package lineup and no ingredient diagram", visualTreatment: "high-detail macro photography, soft side light, clean material rendering" },
    { role: "main", index: 4, focus: routine, productState: "closed bottle being picked up or placed beside a daily organizer", scene: "adult morning desk, kitchen counter or travel-prep routine with water and neutral personal items", layout: "human action provides scale while the bottle remains readable", proof: "show how the product fits into an everyday routine without promising health outcomes", avoidRepeat: "use genuine action and a lived-in space rather than another still-life pack shot", visualTreatment: "natural lifestyle daylight, restrained marketplace styling, realistic hand interaction" },
    { role: "main", index: 5, focus: trust, productState: "front, side and cap details from the same product", scene: "minimal decision-closing display with package detail callouts", layout: "one main package plus two distinct detail crops", proof: "show visible packaging and construction details that help the shopper inspect the product", avoidRepeat: "do not repeat the macro capsule or daily-routine composition", visualTreatment: "precise commercial lighting, consistent white balance, clean technical callouts" }
  ];
  if (!includeDetail) return main;
  const detail: StoryboardFrame[] = [
    { role: "detail", index: 1, focus: packagePoint, productState: "complete package and bottle", scene: "clean first-screen product environment", layout: "full-width hero with concise value hierarchy", proof: "answer what the product is, its format and who may find the routine convenient", avoidRepeat: "not a copy of main image 1; use a taller composition and stronger information hierarchy" },
    { role: "detail", index: 2, focus: formula, productState: "package beside confirmed ingredient source cues", scene: "ingredient origin and pairing story", layout: "vertical ingredient path leading to the real package", proof: "connect each confirmed ingredient cue to the formula without medical imagery", avoidRepeat: "avoid the horizontal relationship layout used in main image 2" },
    { role: "detail", index: 3, focus: formula, productState: "bottle, ingredient cues and a restrained formula diagram", scene: "paired-formula explanation panel", layout: "two-part formula explanation with package identity anchor", proof: "explain the relationship visually, using no unsupported quantities or efficacy claims", avoidRepeat: "do not reuse ingredient-origin photography as the whole composition" },
    { role: "detail", index: 4, focus: format, productState: "capsule or softgel shown in multiple real angles", scene: "macro dosage-form inspection", layout: "one large macro plus two small angle details", proof: "show the visible format and surface clearly", avoidRepeat: "different crop scale and arrangement from main image 3" },
    { role: "detail", index: 5, focus: routine, productState: "closed bottle in an adult daily routine", scene: "morning desk, kitchen or travel preparation with water and organizer", layout: "action-led vertical lifestyle scene", proof: "show convenience through a real action, not a generic wellness slogan", avoidRepeat: "change space and hand action from main image 4" },
    { role: "detail", index: 6, focus: trust, productState: "front, side, back and cap views of the same package", scene: "neutral multi-angle inspection board", layout: "disciplined multi-panel grid with readable package identity", proof: "let shoppers inspect the visible package structure without recreating unreadable label text", avoidRepeat: "no lifestyle props or ingredient illustration" },
    { role: "detail", index: 7, focus: routine, productState: "closed bottle stored upright in a small travel or home organizer", scene: "portable storage and everyday organization", layout: "storage context plus one close package view", proof: "show portability and organization without inventing size or count", avoidRepeat: "not another drinking or capsule-presentation action" },
    { role: "detail", index: 8, focus: trust, productState: "clean stable package closing view", scene: "quiet shelf or counter with restrained ingredient accents", layout: "spacious closing frame with concise copy area", proof: "summarize the package, formula presentation and routine convenience", avoidRepeat: "do not recreate the opening hero; use a wider environmental closing shot" }
  ];
  return [...main, ...detail];
}

function frameKey(frame: StoryboardFrame): string {
  return `${frame.role}-${frame.index}`;
}

function frameText(frame: StoryboardFrame): string {
  return [frame.focus, frame.productState, frame.scene, frame.layout, frame.proof].join(" ");
}

function pointMatchesFrame(point: string, frame: StoryboardFrame): boolean {
  const normalizedPoint = pointKey(point);
  const normalizedFrame = pointKey(frameText(frame));
  return Boolean(normalizedPoint) && normalizedFrame.includes(normalizedPoint);
}

function pointRisk(point: string): string | undefined {
  if (/血脉|基因|唤醒/.test(point)) return "表述含义不明确，需确认具体功能后再作为消费者卖点。";
  if (/100%|绝对|永久|无毒|零风险|治疗|防癌|认证|检测|医用/.test(point)) {
    return "可能涉及绝对化、医疗或认证类承诺，只能在有依据时使用。";
  }
  return undefined;
}

function preferredFrameScore(point: string, frame: StoryboardFrame): number {
  const text = `${point} ${frame.role} ${frame.index}`;
  let score = frame.role === "detail" ? 1 : 0;
  if (/英语|英文|双语|多语言|语言学习|multilingual|bilingual|dialect|language/i.test(point) && ((frame.role === "main" && frame.index === 2) || (frame.role === "detail" && frame.index === 4))) score += 12;
  if (/对话|聊天|语音|问答|方言|voice|conversation|chat|question/i.test(point) && ((frame.role === "main" && frame.index === 2) || (frame.role === "detail" && frame.index === 3))) score += 10;
  if (/学习|早教|故事|儿歌|百科|亲子|learning|study|story|education|family/i.test(point) && ((frame.role === "main" && frame.index === 3) || (frame.role === "detail" && frame.index === 4))) score += 10;
  if (/关节|可动|动作|姿势|表情|LED|joint|movable|pose|motion|expression/i.test(point) && ((frame.role === "main" && frame.index === 4) || (frame.role === "detail" && frame.index === 5))) score += 10;
  if (/礼物|送礼|桌面|摆件|颜值|潮玩|gift|desktop|collectible|display/i.test(point) && ((frame.role === "main" && frame.index === 5) || (frame.role === "detail" && frame.index === 7))) score += 10;
  if (/产品|外观|造型|颜色|结构|product|design|color|structure/i.test(point) && frame.index === 1) score += 7;
  return score + (text.length % 3) * 0.01;
}

function assignExplicitPoints(frames: StoryboardFrame[], explicitPoints: string[]): void {
  const explicitFrameKeys = new Set<string>();
  for (const frame of frames) {
    if (explicitPoints.some((point) => pointMatchesFrame(point, frame))) explicitFrameKeys.add(frameKey(frame));
  }
  const candidateFrames = [...frames]
    .filter((frame) => !explicitFrameKeys.has(frameKey(frame)))
    .sort((a, b) => preferredFrameScore("", b) - preferredFrameScore("", a));
  const assigned = new Set<string>();
  for (const point of explicitPoints) {
    if (frames.some((frame) => pointMatchesFrame(point, frame))) continue;
    const candidate = [...candidateFrames]
      .filter((frame) => !assigned.has(frameKey(frame)))
      .sort((a, b) => preferredFrameScore(point, b) - preferredFrameScore(point, a))[0];
    if (!candidate) continue;
    candidate.focus = point;
    candidate.proof = `${candidate.proof}；必须用画面具体证明“${point}”`;
    assigned.add(frameKey(candidate));
  }
}

function buildCoverage(frames: StoryboardFrame[], explicitPoints: string[], derivedPoints: string[]): SellingPointCoverage[] {
  const explicitKeys = new Set(explicitPoints.map(pointKey));
  return uniquePoints([...explicitPoints, ...derivedPoints]).map((point) => {
    const matchingFrames = frames.filter((frame) => pointMatchesFrame(point, frame));
    const frameKeys = matchingFrames.map(frameKey);
    const risk = pointRisk(point);
    const hasFocusMatch = matchingFrames.some((frame) => pointKey(frame.focus).includes(pointKey(point)));
    let status: SellingPointCoverageStatus = matchingFrames.length
      ? hasFocusMatch ? "covered" : "weak"
      : "uncovered";
    if (risk) status = "needs_confirmation";
    return {
      point,
      source: explicitKeys.has(pointKey(point)) ? "explicit" : "derived",
      status,
      frameKeys,
      ...(risk ? { risk } : {}),
      evidence: frameKeys.length
        ? `已分配到 ${frameKeys.join("、")}，要求画面提供与该卖点对应的可见证据。`
        : "尚未分配到具体图片，需要补充分镜或调整卖点。"
    };
  });
}

export function buildStoryboardPlan(input: StoryboardPlanInput): StoryboardPlan {
  const explicitPoints = uniquePoints(input.explicitSellingPoints ?? []);
  const derivedPoints = uniquePoints(input.derivedSellingPoints ?? input.sellingPoints);
  const points = uniquePoints([...explicitPoints, ...derivedPoints]);
  const frames = input.isAiRobot
    ? buildRobotFrames(points, input.productName, input.generateDetail !== false)
    : input.productKind === "dietary-supplement"
      ? buildSupplementFrames(points, input.productName, input.generateDetail !== false)
    : buildGenericFrames(points, input.productName, input.generateDetail !== false);
  assignExplicitPoints(frames, explicitPoints);
  const coverage = buildCoverage(frames, explicitPoints, derivedPoints);
  const issues: string[] = [];
  const focusKeys = new Set<string>();
  const layoutKeys = new Set<string>();
  for (const frame of frames) {
    if (!frame.focus || !frame.scene || !frame.layout || !frame.proof) {
      issues.push(`${frame.role}-${frame.index} 缺少完整分镜字段`);
    }
    const focusKey = pointKey(frame.focus);
    if (focusKeys.has(focusKey) && frame.role === "main") {
      issues.push(`主图卖点重复：${frame.focus}`);
    }
    focusKeys.add(focusKey);
    const layoutKey = pointKey(frame.layout);
    if (layoutKeys.has(layoutKey)) {
      issues.push(`构图重复：${frame.layout}`);
    }
    layoutKeys.add(layoutKey);
  }
  for (const item of coverage.filter((coverageItem) => coverageItem.source === "explicit")) {
    if (item.status === "uncovered") issues.push(`用户卖点未覆盖：${item.point}`);
    if (item.status === "needs_confirmation") issues.push(`用户卖点需确认：${item.point}`);
  }
  return { frames, audit: { passed: issues.length === 0, issues }, coverage };
}

export function storyboardFramePrompt(frame: StoryboardFrame): string {
  return [
    `本屏分镜执行单（${frame.role === "main" ? "主图" : "详情页"}${frame.index}）：`,
    `本屏必须证明的卖点：${frame.focus}`,
    `产品状态：${frame.productState}`,
    `场景与辅助元素：${frame.scene}`,
    `构图类型：${frame.layout}`,
    `视觉质感与光线：${frame.visualTreatment || "匹配当前平台风格，保持商品材质、颜色和光线真实一致"}`,
    `可见证明方式：${frame.proof}`,
    `与相邻图片的去重要求：${frame.avoidRepeat}`,
    "本屏分镜执行单的优先级高于前文通用场景模板；如有冲突，以本执行单为准。",
    "卖点、产品状态、场景、人物动作、构图和可见证据必须互相服务；不要只替换背景或文案。"
  ].join("\n");
}

export function buildReferenceCaseLayoutRule(input: StoryboardPlanInput): string {
  const plan = buildStoryboardPlan(input);
  const mode = input.isEnglishMarketplace ? "平台文字按语言规则统一为 English" : "平台文字按语言规则统一为用户选择的语言";
  const explicitCoverage = plan.coverage.filter((item) => item.source === "explicit");
  const uncovered = explicitCoverage.filter((item) => item.status === "uncovered").map((item) => item.point);
  const needsConfirmation = explicitCoverage.filter((item) => item.status === "needs_confirmation").map((item) => item.point);
  return [
    "优秀案例抽象学习：只学习信息组织和视觉证明方式，不复制案例中的商品、品牌、参数、人物或文案。",
    "每张图都必须把一个具体卖点绑定到一个产品状态、一个场景、一个构图和一种证明方式；先证明卖点，再追求氛围。",
    "套图应覆盖：英雄首图、真实使用、人物/手部互动、局部细节、多角度或多宫格、礼赠/收尾；相邻图片至少改变两项：产品状态、镜头距离、视角、场景空间、辅助元素、版式。",
    `${mode}。商品本体始终是第一视觉主体，辅助元素不得喧宾夺主。`,
    explicitCoverage.length
      ? `用户明确卖点优先序：${explicitCoverage.map((item) => `${item.point} -> ${item.frameKeys.join("/") || "待分配"}`).join("；")}`
      : "本次没有单独提取到用户明确卖点，才允许使用图片分析和品类默认卖点补充。",
    uncovered.length ? `覆盖预检失败：${uncovered.join("、")}，必须在提交前补充分镜。` : "覆盖预检：用户明确卖点均已绑定到具体分镜。",
    needsConfirmation.length ? `需人工确认的高风险表述：${needsConfirmation.join("、")}。不得把它们扩写成未经证明的事实。` : "卖点风险预检：未发现需要人工确认的绝对化或含义不明表述。",
    `本次预分镜共 ${plan.frames.length} 屏，生成器必须优先执行每屏分镜执行单，而不是套用通用模板。`,
    plan.audit.issues.length ? `分镜预检提示：${plan.audit.issues.join("；")}` : "分镜预检：卖点、构图和证明字段完整。"
  ].join("\n");
}
