/**
 * discipline.js —— 机电「专业」归并（规范层级的第一层）
 *
 * 为什么要有这一层：模型里的两套轴是**正交**的 ——
 *   A. 构件分类轴：类别（Category）→ 族（Family）→ 类型（Type）→ 构件，来自 Revit/IFC 的
 *      IfcTypeObject 体系；
 *   B. 系统轴：专业（Discipline）→ 系统（IfcDistributionSystem）→ 构件，来自 IFC 的
 *      IfcRelAssignsToGroup / IfcDistributionSystem.PredefinedType。
 * 一个构件同时"是某种风管"并且"属于某个排烟系统"。要合成一棵树，必须先立一个总层
 * 把它们串起来 —— 这个总层就是「专业」。
 *
 * 依据（口径来源）：
 *   - GB/T 51269-2017《建筑信息模型分类和编码标准》：按专业—系统—构件类型分层编码
 *   - GB/T 51301-2018《建筑信息模型设计交付标准》：模型按专业与系统组织、系统应可追溯
 *   - IFC4（ISO 16739-1）：IfcDistributionSystem.PredefinedType 的专业划分
 *     （AIRCONDITIONING / VENTILATION / DOMESTICCOLDWATER / SANITARY / FIREPROTECTION /
 *       ELECTRICAL / COMMUNICATIONS …）
 *   - 各专业施工质量验收规范的划分：GB 50242（给排水及采暖）、GB 50243（通风与空调）、
 *     GB 50303（建筑电气）、GB 50974（消防给水及消火栓）、GB 51251（防烟排烟）、
 *     GB 50116（火灾自动报警）、GB 51309（消防应急照明）、GB 55037（建筑防火通用规范）
 *
 * 判定优先级（从强到弱，先命中先返回）：
 *   ① 模型自带 `专业` / `专业名称` 字段
 *   ② **消防优先**：任一系统字段或类别含消防/排烟/喷淋/火警等词 → 消防
 *      （排烟风管属暖通设备、喷淋属给排水管材，但按 GB 55037 与消防各专项验收规范
 *        必须单列成独立系统，不能拆散到暖通/给排水里）
 *   ③ **系统中文语义**（系统分类 / 系统类型 / 系统名称）按命中词数打分取最高分
 *      —— 这一级刻意排在缩写**之前**：`系统类型 = NW-空调凝结水、坡道雨水` 是模型
 *      自己写的权威口径，而 `NW` 只是某个院自定的代号（别处可能真指 network）。
 *      特例：同一系统里既有空调类词又有排水类词（雨水/污水/废水/排水/中水）→ 按排水。
 *   ④ 系统缩写 → 专业（内置表 ABBR_DISCIPLINE，只收含义稳定的，作兜底）
 *   ⑤ 兜底：系统名里的泛词 → 构件类别的强词 → 类别 / 族 的泛词
 *      （没有系统字段的建筑结构模型走这里）
 *   ⑥ 都没有 → (未分类)，不瞎猜
 */

import { cleanText, systemKey } from './system-key.js';

/** 专业定义：name 是树里显示的名字，order 只影响排序 */
export const DISCIPLINES = {
  HVAC: { name: '暖通空调', order: 10 },
  PLUMB: { name: '给排水', order: 20 },
  FIRE: { name: '消防', order: 30 },
  ELEC: { name: '电气', order: 40 },
  ELV: { name: '智能化', order: 50 },
  GAS: { name: '燃气', order: 55 },
  ARCH: { name: '建筑', order: 80 },
  STR: { name: '结构', order: 81 },
  OTHER: { name: '其他', order: 90 },
  NONE: { name: '(未分类)', order: 99 },
};

export const disciplineName = (code) => DISCIPLINES[code]?.name || DISCIPLINES.NONE.name;

/**
 * 系统缩写 → 专业。
 *
 * 原则：**只放含义稳定的缩写**。缩写是各设计院自定的代号，同一个 `NW`
 * 有的指网络、有的指凝结水，硬编码等于替用户拍板，错了还错得理直气壮。
 * 所以这张表只作「模型没给中文语义时」的兜底（见 disciplineCode ④），
 * 并且已经从早先的 77 条收紧——删掉了 `NW` `W` `FS` `TR` `HW` `HWS` `HWR`
 * `QT` `SSP` `FFS` `WSF` 这些有歧义的（`NW` 就是把「空调凝结水、坡道雨水」
 * 误判成智能化的直接原因）。
 * 要按某个项目的口径固化，在项目里改这张表即可。
 */
export const ABBR_DISCIPLINE = {
  // 暖通空调（冷冻水 / 冷却水 / 冷凝水，按惯例随暖通）
  CHW: 'HVAC', CHWS: 'HVAC', CHWR: 'HVAC',
  CW: 'HVAC', CWS: 'HVAC', CWR: 'HVAC', CWP: 'HVAC', CWPU: 'HVAC',
  CN: 'HVAC', CND: 'HVAC',
  AHU: 'HVAC', PAU: 'HVAC', MAU: 'HVAC', FCU: 'HVAC', VRV: 'HVAC', VRF: 'HVAC',
  SF: 'HVAC', PF: 'HVAC', EAF: 'HVAC', SAF: 'HVAC', KEF: 'HVAC', HVAC: 'HVAC', KT: 'HVAC',
  // 给排水
  J: 'PLUMB', JS: 'PLUMB', JL: 'PLUMB', JSL: 'PLUMB',
  WS: 'PLUMB', PW: 'PLUMB', WW: 'PLUMB', YW: 'PLUMB',
  ZW: 'PLUMB', RW: 'PLUMB', PL: 'PLUMB',
  // 消防（排烟 PY、防烟 FY、喷淋 SP、消火栓 XH、火灾报警 FAS）
  XH: 'FIRE', XHS: 'FIRE', SP: 'FIRE', ZP: 'FIRE',
  PY: 'FIRE', FY: 'FIRE', FAS: 'FIRE', YJ: 'FIRE',
  // 电气
  AL: 'ELEC', EL: 'ELEC', DL: 'ELEC', LD: 'ELEC', PD: 'ELEC',
  WL: 'ELEC', GEN: 'ELEC', UPS: 'ELEC', MEB: 'ELEC', LEB: 'ELEC',
  BUS: 'ELEC', CBL: 'ELEC',
  // 智能化 / 弱电（不含 NW —— 见上面的说明）
  ELV: 'ELV', IT: 'ELV', BA: 'ELV', CCTV: 'ELV', CATV: 'ELV',
  TEL: 'ELV', IBMS: 'ELV', PDS: 'ELV',
  // 燃气
  GAS: 'GAS', NG: 'GAS', RQ: 'GAS', MQ: 'GAS',
};

/**
 * 强关键词：描述「这个系统是干什么的」，只在系统口径的字段里找。
 * 命中多个专业时**按命中个数打分**取最高分 —— 一个系统名里可能同时出现
 * 「空调」和「雨水」（如 NW = 空调凝结水 + 坡道雨水），单条命中不足以定性。
 */
const STRONG = [
  ['HVAC', ['暖通', '采暖', '供暖', '空调', '通风', '新风', '送风', '回风', '排风',
    '冷冻水', '冷却水', '冷凝水', '凝结水', '冷媒', '多联机', '地暖', '风系统']],
  ['PLUMB', ['给排水', '给水', '排水', '污水', '废水', '中水', '生活水', '生活热水',
    '热水', '饮用水', '雨水', '卫生器具', '地漏', '水表', '压力排水']],
  ['ELEC', ['电气', '强电', '配电', '变电', '照明', '动力', '桥架', '电缆', '母线',
    '开关柜', '配电箱', '插座', '接地', '防雷', '发电', '低压', '高压']],
  ['ELV', ['智能化', '弱电', '网络', '综合布线', '监控', '门禁', '广播', '安防',
    '信息', '电视', '电话', '楼控', '停车']],
  ['GAS', ['燃气', '天然气', '煤气']],
];

/** 弱关键词：构件层面的词，只在系统和缩写都没给出答案时才用 */
const WEAK = [
  ['HVAC', ['风机', '风管', '风道', '风阀', '风口', '冷机', '盘管', '冷却塔']],
  ['PLUMB', ['管道', '水管', '水阀', '水泵', '水箱', '阀门', '洁具']],
  ['ELEC', ['灯具', '灯', '开关', '线管']],
  ['ELV', ['摄像头', '信息点', '弱电箱']],
  ['ARCH', ['建筑', '墙', '门', '窗', '楼板', '楼梯', '栏杆', '扶手', '扶栏', '幕墙',
    '屋顶', '家具', '装修', '吊顶', '坡道', '散水', '台阶', '雨棚', '顶棚',
    'wall', 'door', 'window', 'floor', 'slab', 'stair']],
  ['STR', ['结构', '梁', '基础', '钢筋', '钢构', '支撑', '桁架',
    '混凝土', '预埋', '桩', '预制板', '现浇板', '叠合板', '框架柱', '构造柱',
    'beam', 'column', 'foundation', 'truss']],
];

/**
 * 设备强词：只看**构件口径**（类别 / 族 / 类型）。
 * 为什么单独一张表：Revit 里「机械设备」是个跨专业的泛类别 —— 板式换热器、
 * 水泵、空调机组、冷水机组、水箱都挂在它下面，光看类别定不了专业，
 * 必须看族/类型里的设备名。也只有多字词能进来（单字「板」会把
 * 「板式换热器」误判成结构板）。
 */
const EQUIP = [
  ['HVAC', ['换热器', '热交换器', '板换', '冷水机组', '空调机组', '新风机组', '风机盘管',
    '锅炉', '冷却塔', '热泵', '分集水器', '除湿机', '风机', '空调箱', '空调机']],
  ['PLUMB', ['水泵', '水箱', '水处理', '软水', '加药', '气压罐', '隔油', '潜水泵',
    '污水泵', '水加热器', '水表']],
  ['ELEC', ['变压器', '发电机', '配电柜', '开关柜', '箱变', 'ups', 'eps']],
  ['ELV', ['机柜', '弱电箱', '摄像头', '交换机', '控制器']],
];

/** 消防强词。刻意不收裸「报警」—— 入侵报警、防盗报警属安防（智能化） */
const FIRE_STRONG = ['消防', '喷淋', '消火栓', '消火', '排烟', '防烟', '防火',
  '火警', '火灾', '灭火', '应急照明', '疏散', 'fire', 'sprinkler', 'smoke'];

/** 排水类词：一个系统里同时出现「空调类 + 排水类」时按排水处理（见 disciplineCode ③） */
const DRAIN = ['雨水', '污水', '废水', '排水', '中水', '地漏'];

/** 打分相同时的倾向顺序（制备冷热水的系统优先于零散命中的专业） */
const ORDER = ['HVAC', 'PLUMB', 'ELEC', 'ELV', 'GAS', 'ARCH', 'STR'];

const has = (text, words) => {
  const s = cleanText(text).toLowerCase();
  return !!s && words.some((w) => s.includes(w));
};

function scoreStrong(text, table = STRONG) {
  const s = cleanText(text).toLowerCase();
  const score = new Map();
  if (!s) return score;
  for (const [code, words] of table) {
    for (const w of words) {
      if (s.includes(w)) score.set(code, (score.get(code) || 0) + 1);
    }
  }
  return score;
}

function bestOf(score) {
  let best = '';
  let max = 0;
  for (const [code, n] of score) {
    if (n > max || (n === max && ORDER.indexOf(code) < ORDER.indexOf(best))) {
      best = code;
      max = n;
    }
  }
  return best;
}

function scoreWeak(text) {
  const s = cleanText(text).toLowerCase();
  if (!s) return '';
  for (const [code, words] of WEAK) {
    for (const w of words) if (s.includes(w)) return code;
  }
  return '';
}

/**
 * 消防词 → 「原本挂在哪个专业」。
 * 只在 fireFirst=false（不把消防单列）时用：排烟风管回暖通、喷淋回给排水、
 * 火灾报警回电气 —— 也就是按设备/管材的**实体专业**归并，而不是按系统职能。
 */
const FIRE_HOST = [
  ['HVAC', ['排烟', '防烟', '补风', '送排风', '排风']],
  ['PLUMB', ['喷淋', '消火栓', '消防水', '水喷雾', '消防泵', '消防给水']],
  ['ELEC', ['火警', '火灾报警', '应急照明', '疏散', '消防电源', '联动', '报警']],
];
function fireHostOf(text) {
  const s = cleanText(text).toLowerCase();
  if (!s) return '';
  for (const [code, words] of FIRE_HOST) {
    for (const w of words) if (s.includes(w)) return code;
  }
  return '';
}

/** 可配置策略：消防是否优先于其它专业（默认开，符合 GB 55037 的单列要求） */
export const POLICY = { fireFirst: true };

/**
 * 构件 → 专业代码
 * @param {object} props 构件的 BIM 属性（extras）
 * @param {{fireFirst?: boolean}} [opts]
 */
export function disciplineCode(props, opts = {}) {
  const p = props || {};
  const fireFirst = opts.fireFirst ?? POLICY.fireFirst;

  const sysCat = cleanText(p['系统分类']);
  const sysType = cleanText(p['系统类型']);
  const sysName = cleanText(p['系统名称']);
  const cat = cleanText(p['Category Name']) || cleanText(p['类别']);
  const fam = cleanText(p['族']) || cleanText(p['Family Name']);
  const abbr = systemKey(p);

  const typeName = cleanText(p['Type Name']);
  const sysText = [sysCat, sysType, sysName].join(' '); // 系统口径
  const compText = [cat, fam].join(' ');                // 构件口径
  const equipText = [cat, fam, typeName].join(' ');     // 设备识别口径（多带类型名）
  const allText = `${sysText} ${compText}`;

  // ① 模型自带专业字段
  const explicit = cleanText(p['专业']) || cleanText(p['专业名称']);
  if (explicit) {
    if (has(explicit, FIRE_STRONG)) return fireFirst ? 'FIRE' : (fireHostOf(explicit) || 'FIRE');
    const b = bestOf(scoreStrong(explicit));
    if (b) return b;
    const w = scoreWeak(explicit);
    if (w) return w;
  }

  // ② 消防优先：系统字段和构件字段都看（消防是职能口径，跨专业存在）
  if (has(allText, FIRE_STRONG)) {
    return fireFirst ? 'FIRE' : (fireHostOf(sysText || compText) || 'FIRE');
  }

  // ③ 系统中文语义 —— **比缩写可靠**：模型自己写的「系统分类 / 系统类型」是权威口径，
  //    缩写只是各院自定的代号（同一个 NW，有的指网络，有的指凝结水）。
  const sc = scoreStrong(sysText);
  // 混合水系统：同时含空调类词和排水类词 → 按排水（它是把水排走的系统，
  // 而不是制备冷热水的系统）。例：NW = 空调凝结水 + 坡道雨水。
  if (has(sysText, DRAIN) && (sc.get('HVAC') || 0) > 0) return 'PLUMB';
  const best = bestOf(sc);
  if (best) return best;

  // ④ 系统缩写（模型没给中文语义时才兜底）
  if (abbr && abbr !== '(未分类)' && ABBR_DISCIPLINE[abbr]) {
    return ABBR_DISCIPLINE[abbr];
  }

  // ⑤ 兜底：系统名里的泛词 → 构件类别上的强词（如「电缆桥架」）→ 构件泛词
  const weakSys = scoreWeak(sysText);
  if (weakSys) return weakSys;
  const strongComp = bestOf(scoreStrong(compText));
  if (strongComp) return strongComp;
  // 设备名（板式换热器 → 暖通、水泵 → 给排水…）：机械设备这种泛类别靠它定专业
  const equip = bestOf(scoreStrong(equipText, EQUIP));
  if (equip) return equip;
  const weakComp = scoreWeak(compText);
  if (weakComp) return weakComp;

  return 'NONE';
}

/** 构件 → 专业名（树里显示的文字） */
export function disciplineOf(props, opts) {
  return disciplineName(disciplineCode(props, opts));
}
