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
 *   ③ 系统缩写 → 专业（内置表，见 ABBR_DISCIPLINE）
 *   ④ 系统分类 / 系统类型 / 系统名称 的中文关键词
 *   ⑤ 类别（Category Name）/ 族 的中文关键词（无系统字段的建筑结构模型走这里）
 *   ⑥ 都没有 → (未分类)
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
 * 只放**含义稳定**的缩写；CR / CS / F 这类不同设计院口径不一的刻意不放，
 * 留给关键词与数据自身说法，避免替用户拍板（同 system-names.js 的处理原则）。
 */
export const ABBR_DISCIPLINE = {
  // 暖通空调（含水系统：冷冻水/冷却水/冷凝水，按惯例归暖通而非给排水）
  CHW: 'HVAC', CHWS: 'HVAC', CHWR: 'HVAC',
  CW: 'HVAC', CWS: 'HVAC', CWR: 'HVAC', CWP: 'HVAC', CWPU: 'HVAC',
  CN: 'HVAC', CND: 'HVAC',
  AHU: 'HVAC', PAU: 'HVAC', MAU: 'HVAC', FCU: 'HVAC', VRV: 'HVAC', VRF: 'HVAC',
  SF: 'HVAC', PF: 'HVAC', EAF: 'HVAC', SAF: 'HVAC', KEF: 'HVAC',
  HVAC: 'HVAC', KT: 'HVAC', HWS: 'HVAC', HWR: 'HVAC', HW: 'HVAC',
  // 给排水
  J: 'PLUMB', JS: 'PLUMB', JL: 'PLUMB', JSL: 'PLUMB',
  WS: 'PLUMB', PW: 'PLUMB', WW: 'PLUMB', YW: 'PLUMB', W: 'PLUMB',
  ZW: 'PLUMB', RW: 'PLUMB', PL: 'PLUMB', WSF: 'PLUMB', FS: 'PLUMB',
  // 消防（排烟 PY、防烟 FY、喷淋 SP、消火栓 XH、火灾报警 FAS）
  XH: 'FIRE', XHS: 'FIRE', SP: 'FIRE', SSP: 'FIRE', ZP: 'FIRE',
  PY: 'FIRE', FY: 'FIRE', FAS: 'FIRE', FFS: 'FIRE', QT: 'FIRE', YJ: 'FIRE',
  // 电气
  AL: 'ELEC', EL: 'ELEC', DL: 'ELEC', LD: 'ELEC', PD: 'ELEC',
  WL: 'ELEC', TR: 'ELEC', GEN: 'ELEC', UPS: 'ELEC', MEB: 'ELEC', LEB: 'ELEC',
  BUS: 'ELEC', CBL: 'ELEC',
  // 智能化 / 弱电
  ELV: 'ELV', IT: 'ELV', BA: 'ELV', CCTV: 'ELV', CATV: 'ELV',
  TEL: 'ELV', NW: 'ELV', IBMS: 'ELV', PDS: 'ELV',
  // 燃气
  GAS: 'GAS', NG: 'GAS', RQ: 'GAS', MQ: 'GAS',
};

/** 关键词 → 专业。按数组顺序匹配，消防排在最前（消防优先） */
const KEYWORDS = [
  ['FIRE', ['消防', '喷淋', '消火栓', '消火', '排烟', '防烟', '防火', '火警', '火灾',
    '报警', '灭火', '疏散', '应急照明', 'fire', 'sprinkler', 'smoke']],
  ['HVAC', ['暖通', '采暖', '供暖', '空调', '通风', '新风', '送风', '回风', '排风',
    '冷冻水', '冷却水', '冷凝水', '风机', '风管', '风道', '冷媒', '多联机', '地暖',
    'hvac', 'duct', 'air']],
  ['PLUMB', ['给排水', '给水', '排水', '污水', '废水', '雨水', '中水', '生活水',
    '热水', '饮用水', '管道', '水管', '卫生器具', '地漏', '水泵', '水表',
    'plumb', 'water', 'drain', 'pipe']],
  ['ELEC', ['电气', '强电', '配电', '变电', '照明', '动力', '桥架', '电缆', '母线',
    '开关柜', '配电箱', '插座', '接地', '防雷', '发电',
    'electric', 'cable', 'power', 'light']],
  ['ELV', ['智能化', '弱电', '网络', '综合布线', '监控', '门禁', '广播', '安防',
    '信息', '电视', '电话', '楼控',
    'elv', 'network', 'cctv']],
  ['GAS', ['燃气', '天然气', '煤气', 'gas']],
  ['ARCH', ['建筑', '墙', '门', '窗', '楼板', '楼梯', '栏杆', '扶手', '扶栏', '幕墙',
    '屋顶', '家具', '装修', '吊顶', '坡道', '散水', '台阶', '雨棚', '顶棚',
    'wall', 'door', 'window', 'floor', 'slab', 'stair']],
  ['STR', ['结构', '梁', '柱', '基础', '钢筋', '钢构', '支撑', '桁架', '板',
    '混凝土', '预埋', '桩',
    'beam', 'column', 'foundation', 'truss']],
];

function keywordDiscipline(text) {
  const s = cleanText(text).toLowerCase();
  if (!s) return '';
  for (const [code, words] of KEYWORDS) {
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

  // ① 模型自带专业字段
  const explicit = cleanText(p['专业']) || cleanText(p['专业名称']);
  if (explicit) {
    const hit = keywordDiscipline(explicit);
    if (hit) return hit;
  }

  // 消防词归一：fireFirst 时一律归消防，否则回到它所属的实体专业
  const allText = [sysCat, sysType, sysName, cat, fam].join(' ');
  const kd = (text) => {
    const code = keywordDiscipline(text);
    if (code === 'FIRE' && !fireFirst) return fireHostOf(text || allText) || 'FIRE';
    return code;
  };

  // ② 消防优先：系统口径先看（构件口径放到 ⑤ 之后兜底）
  if (fireFirst) {
    for (const v of [sysCat, sysType, sysName]) {
      if (keywordDiscipline(v) === 'FIRE') return 'FIRE';
    }
  }

  // ③ 系统缩写
  if (abbr && abbr !== '(未分类)' && ABBR_DISCIPLINE[abbr]) {
    const code = ABBR_DISCIPLINE[abbr];
    if (code !== 'FIRE' || fireFirst) return code;
    return fireHostOf(allText) || 'FIRE';
  }

  // ④ 系统中文名
  for (const v of [sysCat, sysType, sysName]) {
    const hit = kd(v);
    if (hit) return hit;
  }

  // ⑤ 构件分类
  for (const v of [cat, fam]) {
    const hit = kd(v);
    if (hit) return hit;
  }

  // ⑥ 消防兜底：类别里带消防词（如「消防水泵」类别在给排水专业下）
  if (fireFirst) {
    for (const v of [cat, fam, sysCat, sysType, sysName]) {
      if (cleanText(v).includes('消防')) return 'FIRE';
    }
  }

  return 'NONE';
}

/** 构件 → 专业名（树里显示的文字） */
export function disciplineOf(props, opts) {
  return disciplineName(disciplineCode(props, opts));
}
