/**
 * equipment.js —— 构件 → 设备分类（「专业›设备分类」这一档的第二层用它；管综 / 建筑结构再回退到 Revit 类别）
 *
 * 为什么单独一层：机电模型里绝大多数构件是「管综」（管道、风管、桥架、支吊架、
 * 阀门风口），机房设备与末端设备只占很小一部分，但恰恰是要反复找的那部分
 * （配电柜、水箱、空调机柜、新风机组…）。按专业分只能分到「暖通/电气」这一级，
 * 设备仍然混在几万根管子里，所以这里再切一刀：按**设备类型**归类。
 *
 * 判定顺序（越靠前越权威）：
 *   ① **建筑 / 结构专业** → 「建筑结构」。这一条**最先判**，且一票否决：
 *      「电梯井道轻质隔墙」「混凝土-矩形梁_电梯大堂」名字里带「电梯」，但它们就是墙和梁，
 *      不能因为一个词就被拉去「电梯设备」。建筑结构构件只留在建筑结构里。
 *   ② **类别本身是管线**（风管 / 管道 / 电缆桥架 / 线槽 / 支吊架 / 管道附件…）→ 「管综」。
 *      同样优先于设备词：「广播线槽」里的「广播」说的是系统，它本身还是线槽；
 *      「管道附件 | 压力传感器」是装管上的仪表，也不是独立设备。
 *   ③ **名称里带「智能 / 智慧」等字样** → 「智能化设备」（见下节）。
 *      这一条**压过具体设备词**：`智能照明_筒灯001` 归智能化，不归照明灯具 ——
 *      用户口径是「凡名称带智能，统一归智能化设备」。
 *   ④ 名称 / 类别 / 族 / 类型 里的设备词（各院叫法差异大，词表按「从细到粗」排）
 *   ⑤ IFC 实体（IFC4 的 IfcPump / IfcChiller / IfcTank …，比中文词稳）
 *   ⑥ 管综词（风管 / 管道 / 桥架 / 阀门 / 支吊架…）→ 归「管综」
 *   ⑦ 管综类 IFC 实体（IfcFlowSegment / IfcDuctSegment / IfcCableCarrier…）
 *   ⑧ 类别是「机械设备 / 专用设备 / 设备」但认不出型号 → 「其他设备」
 *   ⑨ 其余 → 「其他设备」（已排除管线和建筑结构，剩下的就是认不出型号的东西，
 *      说它是「管综」反而是瞎猜）
 *
 * 三条硬优先级（都会「吃掉」名称里的词，各对应一次真实翻车）：
 *   建筑结构 > 管线本体 > 智能化 > 具体设备词
 *   · 建筑结构：`基本墙 电梯井道轻质隔墙_150` 带「电梯」也还是墙；
 *   · 管线本体：`智能化_电缆桥架` / `智能电动阀` 是线不是机，仍归「管综」；
 *   · 智能化：`智能照明_筒灯001` 归智能化，不再拆成照明灯具。
 *
 * 刻意不读「系统分类 / 系统名称」：
 *   ① 那说的是这条管线属于哪个系统（「配电」「冷冻水」），一根冷冻水管也在冷冻水系统里，
 *      按系统判会把整片管道都当设备；
 *   ② 弱电专业的系统名常常就叫「智能化」—— 一旦读系统名，整栋楼的弱电构件
 *      （桥架、线槽、面板、配线架）会全部涌进「智能化设备」，这个桶就废了。
 *   所以「智能化」只认**构件自身**的名字（名称 / 类别 / 族 / 类型），不认系统口径。
 */

import { cleanText } from './system-key.js';
import { disciplineCode, isBuildingCat } from './discipline.js';

/** 非设备桶：管道、风管、桥架、阀部件、支吊架 */
export const NON_EQUIP = '管综';
/** 机电里认不出具体型号的设备（类别写着机械设备/专用设备/设备） */
export const OTHER_EQUIP = '其他设备';
/** 建筑 / 结构构件 —— 只留在这一桶，绝不并入任何设备类型 */
export const NON_MEP = '建筑结构';
/**
 * 智能化设备：名称里带「智能 / 智慧」等字样的设备。
 * 手工模型（无 BIM 信息、只有「系统名_设备名+编号」的名字）与 BIM 模型共用同一条规则，
 * 差别只在「能不能读到类别/族/类型」—— 手工模型就只有名字能扫。
 */
export const SMART_KIND = '智能化设备';

/**
 * 智能化判定词（中文，子串命中）。
 * 「智控 / 智联」是工程里常见的简写（智能控制箱、智联面板），一并收；
 * 不收单字「智」——「智」会命中「智利」「智造」这类无关词。
 */
const SMART_WORDS = ['智能', '智慧', '智控', '智联'];

/** 智能化判定词（英文，整词命中，避免 smartphone 之类误伤） */
const SMART_WORDS_EN = ['smart', 'intelligent', 'intelligence'];

/**
 * 设备类型表。**顺序即优先级**：越具体的排越前（"风机盘管"必须先于"风机"命中）。
 * words 只收两个字以上的词，避免「泵」「柜」这类单字把"泵房""柜体"误伤成设备。
 * ifc 用 IFC4 实体名去掉 Ifc 前缀的小写形式。
 */
export const EQUIP_KINDS = [
  {
    name: '冷水机组',
    words: ['冷水机组', '冷机', '离心式冷水', '螺杆式冷水', '模块化机组', '多联机', 'vrv', 'vrf', '热泵机组'],
    ifc: ['chiller'],
  },
  {
    name: '空调机柜',
    words: ['空调机柜', '空调机组', '组合式空调', '空调箱', '空气处理机', 'ahu', 'ahau', '恒温恒湿', '精密空调', '机房空调', '风冷机组', '屋顶机'],
    ifc: ['unitaryequipment', 'airtoairheatexchanger'],
  },
  {
    name: '新风机组',
    words: ['新风机组', '新风换气', '新风处理', '新风机', '热回收机组', '热回收新风'],
    ifc: [],
  },
  {
    name: '风机盘管',
    words: ['风机盘管', '盘管机组', 'fcu'],
    ifc: ['airterminalbox'],
  },
  {
    name: '冷却塔',
    words: ['冷却塔'],
    ifc: ['coolingtower'],
  },
  {
    name: '锅炉',
    words: ['锅炉', '蒸汽发生器', '热水机组', '电锅炉', '燃气锅炉'],
    ifc: ['boiler'],
  },
  {
    name: '换热器',
    words: ['换热器', '热交换器', '板式换热', '板换', '换热机组', '分集水器', '分水器', '集水器'],
    ifc: ['heatexchanger', 'coil'],
  },
  {
    name: '风机',
    words: ['风机', '排风机', '送风机', '轴流风', '离心风', '屋顶风机', '风机箱', '风幕', '空气幕', '除湿机', '加湿器'],
    ifc: ['fan'],
  },
  {
    name: '水泵',
    words: ['水泵', '泵组', '潜水泵', '潜污泵', '污水泵', '排污泵', '污泵', '提升泵', '排泥泵',
      '消防泵', '循环泵', '增压泵', '补水泵', '稳压泵', '深井泵', '泵房设备'],
    ifc: ['pump'],
  },
  {
    name: '水箱',
    words: ['水箱', '水池', '贮水池', '储水池', '膨胀水箱', '气压罐', '膨胀罐', '水罐', '消毒水箱'],
    ifc: ['tank'],
  },
  {
    name: '水处理设备',
    words: ['水处理', '软化水', '软水器', '加药', '消毒器', '紫外线', '隔油', '化粪', '一体化设备', '净水',
      '水加热器', '热水器', '开水器', '除污器', '过滤罐', '定压补水', '补水装置', '定压装置'],
    ifc: ['filter'],
  },
  {
    name: '配电柜',
    words: ['配电柜', '配电箱', '开关柜', '控制柜', '控制箱', '动力柜', '照明箱', '电表箱', '箱变', '箱式变', '变压器', '发电机', 'ups', 'eps', '电容柜', '进线柜', '出线柜', '低压柜', '高压柜', '母线槽'],
    ifc: ['electricdistributionboard', 'electricdistributionpoint', 'transformer', 'electricgenerator', 'outlet'],
  },
  {
    name: '弱电机柜',
    words: ['机柜', '弱电箱', '服务器机柜', '网络柜', '交换机', '配线架', '机架'],
    ifc: ['communicationsappliance', 'audiovisualappliance'],
  },
  {
    name: '照明灯具',
    words: ['灯具', '筒灯', '灯盘', '灯带', '投光灯', '射灯', '泛光灯', '应急灯', '灯槽', 'light'],
    ifc: ['lightfixture'],
  },
  {
    name: '电梯设备',
    words: ['电梯', '扶梯', '升降机', '自动人行道'],
    ifc: ['transportelement', 'transportelevator'],
  },
];

/** 管综词：管道、风管、桥架、阀部件、支吊架。命中这些说明是"线"而不是"机" */
const PIPE_WORDS = [
  '风管', '管道', '水管', '立管', '干管', '支管', '桥架', '线槽', '线管', '导管', '电缆管',
  '支吊架', '支架', '吊架', '吊杆', '管架', '管卡', '卡箍', '木托', '垫木', '横担', '竖杆', '托架', '底座', '底板',
  '管件', '弯头', '三通', '四通', '变径', '法兰', '软接', '套管', '配件',
  '阀门', '电动阀', '调节阀', '蝶阀', '闸阀', '止回阀', '减压阀', '安全阀', '阀组', '阀部件',
  '风口', '散流器', '百叶', '静压箱', '喷头', '消火栓', '保温',
];

/**
 * 类别本身就是「线」的那些（Revit / 天正 / 鸿业 的类别名）。
 * 只要类别落在这里，不管名称里带了什么系统词（广播、消防、电梯…），一律归管综 ——
 * 否则「广播线槽」会因为「广播」被判成设备，「电梯井道隔墙」靠设备词也躲不过。
 */
const PIPE_CATS = [
  '风管', '风管附件', '风道', '管道', '管道附件', '水管', '线管', '导管',
  '电缆桥架', '电缆桥架配件', '桥架', '线槽', '母线槽', '支吊架', '管道支吊架',
  '套管', '软管', '保温层', '风口',
];

/** 管综类 IFC 实体（线段、管件、桥架、阀部件、末端风口） */
const PIPE_IFC = [
  'flowsegment', 'flowfitting', 'pipeSegment', 'pipesegment', 'pipefitting', 'ductsegment',
  'ductfitting', 'cablesegment', 'cablecarriersegment', 'cablecarrierfitting', 'cablefitting',
  'cableductsegment', 'cable', 'flowcontroller', 'valve', 'airterminal', 'airstandardcase',
  'distributionflowelement',
].map((s) => s.toLowerCase());

/** 泛设备类别：写着这些说明是设备，但没给型号 */
const GENERIC_EQUIP_CATS = ['机械设备', '专用设备', '系统设备', '设备', '设备构件', '常规模型'];

/**
 * 建筑构件类别表放在 `discipline.js`（`buildingCatCode` / `isBuildingCat`）——
 * 专业层也要用它做一票否决（防火板墙不进消防），口径只维护一份。
 * 这里仍要再判一次：即使专业层被判成机电，类别是墙 / 门的也不算设备。
 */

/** 取 IFC 实体名（小写，不带 Ifc 前缀） */
function ifcEntities(props) {
  const out = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (!/ifc/i.test(k)) continue;
    const s = String(v ?? '');
    const found = s.match(/Ifc[A-Za-z]+/g);
    if (found) for (const n of found) out.push(n.replace(/^Ifc/, '').toLowerCase());
    else if (s) out.push(s.toLowerCase());
  }
  return out;
}

const includesAny = (haystack, words) => words.some((w) => haystack.includes(w.toLowerCase()));

/**
 * 名称里是否带「智能 / 智慧」等字样，返回命中的那个词（没命中给空串）。
 * text 需已转小写。英文按整词匹配：`smart` 命中 "Smart Lighting"，
 * 不命中 "smartphone"。
 */
export function smartHit(text) {
  const s = String(text || '').toLowerCase();
  for (const w of SMART_WORDS) if (s.includes(w)) return w;
  for (const w of SMART_WORDS_EN) {
    if (new RegExp(`(?:^|[^a-z])${w}(?![a-z])`).test(s)) return w;
  }
  return '';
}

/** 名称 → 具体设备类型（按 EQUIP_KINDS 顺序，先命中先算）；没有给 null */
function firstEquipKind(text) {
  for (const k of EQUIP_KINDS) {
    if (k.words.length && includesAny(text, k.words)) return k;
  }
  return null;
}

/**
 * 构件 → 设备类型 + 判定依据（树上的悬浮提示、体检报告要用）。
 *
 * @param {object} props 构件的 BIM 属性（extras，手工模型是空对象）
 * @param {string} [name] 构件名（手工模型唯一的线索）
 * @returns {{kind:string, from:string, matched:string, note:string}}
 *   from：arch 建筑结构否决 / pipe-cat 类别是管线 / smart 智能化 / word 设备词 /
 *         ifc IFC 实体 / pipe-word 管综词 / pipe-ifc 管综类 IFC / generic-cat 泛设备类别 /
 *         fallback 兜底
 */
export function resolveEquipment(props, name) {
  const p = props || {};
  const cat = cleanText(p['Category Name']) || cleanText(p['类别']);
  // 只扫构件自身的名字：**不含 系统分类 / 系统名称 / 系统缩写**
  const text = [
    cleanText(name),
    cleanText(p['名称']),
    cleanText(p['Name']),
    cat,
    cleanText(p['族']),
    cleanText(p['Family Name']),
    cleanText(p['Type Name']),
    cleanText(p['类型']),
  ].filter(Boolean).join(' ').toLowerCase();
  const ret = (kind, from, matched = '', note = '') => ({ kind, from, matched, note });

  // ① 建筑 / 结构专业：一票否决，最先判。
  //    「电梯井道轻质隔墙」里有「电梯」但它就是墙；「混凝土-矩形梁_电梯大堂」也一样。
  //    建筑结构构件只留在「建筑结构」，不允许被任何设备词拉走。
  const code = disciplineCode(p, { name });
  if (code === 'ARCH' || code === 'STR') return ret(NON_MEP, 'arch', '', '建筑 / 结构专业，不并入设备');

  // ①b 建筑构件类别（墙 / 门 / 窗 / 楼板 / 楼梯 / 幕墙…）：即使带了消防词也还是建筑构件。
  //     `智能防火门`「防火卷帘」会被消防优先判成 FIRE，躲过上面的专业否决，
  //     再被「智能」抓走就错了 —— 门再智能也是门。
  if (isBuildingCat(cat)) return ret(NON_MEP, 'arch', cat, `类别「${cat}」是建筑构件`);

  // ② 类别本身就是管线（风管 / 管道 / 桥架 / 支吊架 / 管道附件…）→ 管综。
  //    同样优先于设备词：「广播线槽」里的「广播」是系统名，它本身还是线槽；
  //    「管道附件 | 压力传感器」是装管上的仪表，不单列设备类型。
  if (cat && PIPE_CATS.includes(cat)) return ret(NON_EQUIP, 'pipe-cat', cat, `类别「${cat}」是管线`);

  // ③ 智能化：名称 / 类别 / 族 / 类型里带「智能 / 智慧 / 智控 / 智联」→ 智能化设备。
  //    压过具体设备词（智能照明_筒灯001 不拆成照明灯具），但**管线本体不退让**：
  //    「智能化_电缆桥架」「智能电动阀」「智慧_风口」还是线，归管综。
  //    注意：手工模型没有类别 / 族 / 类型，这条就是它唯一的归类依据。
  const smart = smartHit(text);
  if (smart) {
    const equip = firstEquipKind(text);
    if (!equip && includesAny(text, PIPE_WORDS)) {
      return ret(NON_EQUIP, 'pipe-word', smart, `名称含「${smart}」但本体是管线`);
    }
    return ret(SMART_KIND, 'smart', smart, `名称含「${smart}」`);
  }

  // ④ 中文设备词（最具体，先命中先算）
  const word = firstEquipKind(text);
  if (word) return ret(word.name, 'word', word.name, '');

  // ⑤ IFC 实体
  const ifcs = ifcEntities(p);
  if (ifcs.length) {
    for (const k of EQUIP_KINDS) {
      if (k.ifc?.length) {
        const hit = ifcs.find((e) => k.ifc.includes(e));
        if (hit) return ret(k.name, 'ifc', hit, '');
      }
    }
  }

  // ⑥ 管综词
  if (includesAny(text, PIPE_WORDS)) return ret(NON_EQUIP, 'pipe-word', '', '名称是管综构件');

  // ⑦ 管综类 IFC
  if (ifcs.length) {
    const hit = ifcs.find((e) => PIPE_IFC.includes(e));
    if (hit) return ret(NON_EQUIP, 'pipe-ifc', hit, '');
  }

  // ⑧ 泛设备类别：是设备但认不出型号
  if (cat && GENERIC_EQUIP_CATS.includes(cat)) return ret(OTHER_EQUIP, 'generic-cat', cat, '认不出具体型号');

  // ⑨ 其余：管线、建筑结构都已被前面的规则摘掉，剩下的是认不出型号的构件。
  //    这里归「其他设备」而不是「管综」—— 说一条摄像机是管道是瞎猜，归其他设备才诚实。
  return ret(OTHER_EQUIP, 'fallback', '', '没有可用的类型依据');
}

/**
 * 构件 → 设备类型（只要结果）。
 *
 * @param {object} props 构件的 BIM 属性（extras）
 * @param {string} [name] 构件名（手工模型没有 props，只有名字）
 * @returns {string} EQUIP_KINDS 里的某个 name，或 智能化设备 / 管综 / 其他设备 / 建筑结构
 */
export function equipmentKind(props, name) {
  return resolveEquipment(props, name).kind;
}

/** 是否属于「智能化设备」（名称带智能 / 智慧等字样，且不是管线本体） */
export function isSmartEquip(props, name) {
  return equipmentKind(props, name) === SMART_KIND;
}

/** 是否为「真设备」（能落到具体类型） */
export function isEquipment(props, name) {
  const kind = equipmentKind(props, name);
  return !CATCH_ALL.has(kind);
}

/** 兜底桶：排序时永远排最后的那些 */
export const CATCH_ALL = new Set([NON_EQUIP, OTHER_EQUIP, NON_MEP]);

/**
 * 设备类型在树里的排列顺序（业务顺序，不是拼音序）：
 * 冷热源 → 水 → 电 → 弱电 / 智能化 → 照明 → 电梯 → 兜底桶。
 * 「智能化设备」插在「弱电机柜」之后、「照明灯具」之前 —— 它和弱电同属信息设施，
 * 又常与灯具混在同一批末端里，放这儿最容易被找到。
 */
export const KIND_ORDER = (() => {
  const seq = EQUIP_KINDS.map((k) => k.name);
  const at = seq.indexOf('弱电机柜');
  seq.splice(at >= 0 ? at + 1 : seq.length, 0, SMART_KIND);
  const m = new Map();
  seq.forEach((name, i) => m.set(name, i));
  m.set(OTHER_EQUIP, 900);
  m.set(NON_EQUIP, 901);
  m.set(NON_MEP, 902);
  return m;
})();

export function kindRank(label) {
  return KIND_ORDER.has(label) ? KIND_ORDER.get(label) : 500;
}

/**
 * 这个标签是「设备类型」还是「Revit 类别」？
 *
 * 树上的第三层对设备分支给设备类型（配电柜 / 水泵…），对管综、建筑结构分支
 * 给类别（风管 / 管道 / 墙…）—— 两者都只是一个字符串，靠这张表区分：
 * 类别名（风管、管道、电缆桥架、墙、门）不在设备类型表里，反之亦然。
 */
export function isKindLabel(label) {
  return KIND_ORDER.has(label);
}
