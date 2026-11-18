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
 *   ③ **BIM 语义层里的消防**：IFC 实体（IfcFireSuppressionTerminal）或 OmniClass 编码
 *      指到消防 → 消防（消防优先不能漏）
 *   ④ **系统中文语义**（系统分类 / 系统类型 / 系统名称）按命中词数打分取最高分
 *      —— 这一级刻意排在缩写**之前**：`系统类型 = NW-空调凝结水、坡道雨水` 是模型
 *      自己写的权威口径，而 `NW` 只是某个院自定的代号（别处可能真指 network）。
 *      特例：同一系统里既有空调类词又有排水类词（雨水/污水/废水/排水/中水）→ 按排水。
 *   ⑤ **BIM 语义层**：IFC 实体（IFC4 的 IfcHvacDomain / IfcPlumbingFireProtectionDomain /
 *      IfcElectricalDomain）与 OmniClass Table 23 编码 —— 系统没给答案时，按「这是什么设备」定。
 *      放在系统语义之后是有意的：冷冻水泵属暖通，不能因为它是 IfcPump 就划到给排水。
 *   ⑥ 系统缩写 → 专业（内置表 ABBR_DISCIPLINE，只收含义稳定的，作兜底）
 *   ⑦ 兜底：系统名里的泛词 → 构件类别的强词 → 类别 / 族 的泛词
 *      （没有系统字段的建筑结构模型走这里）
 *   ⑧ **手工命名规则**：`系统名_设备名+编号`（如 "智能照明_筒灯001"）
 *      用户手工补进场景的非 BIM 模型没有 extras，只有名字。系统名视作「系统语义」
 *      参与 ④ 的打分，设备名参与 ⑦ 的设备词表；格式不合规 / 系统名认不出 → 不进判定。
 *   ⑨ 都没有 → 其他分类，不瞎猜
 */

import { cleanText, systemKey, UNKNOWN_LABEL } from './system-key.js';
import { MANUAL_REASONS, parseManualName } from './manual-name.js';

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
  // 兜底桶：属性缺失 / 命名规则没匹配上的构件都在这儿（旧称「未分类」）
  NONE: { name: UNKNOWN_LABEL, order: 99 },
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
  ['HVAC', ['风机', '风管', '风道', '风阀', '风口', '冷机', '盘管', '冷却塔',
    '消声器', '静压箱', '散流器', '百叶', '软接头', '风管附件', '风管部件']],
  ['PLUMB', ['管道', '水管', '水阀', '水泵', '水箱', '阀门', '洁具', '管件',
    '套管', '管道附件', '清扫口', '检查口', '存水弯', '雨水斗', '通气帽']],
  ['ELEC', ['灯具', '灯', '开关', '线管', '接线盒', '电缆头', '灯带', '控制箱', '电表箱']],
  ['ELV', ['摄像头', '信息点', '弱电箱', '摄像机', '读卡器']],
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
    '锅炉', '冷却塔', '热泵', '分集水器', '除湿机', '风机', '空调箱', '空调机',
    '空气幕', '加湿器', '恒温恒湿', '空气处理机', '新风换气']],
  ['PLUMB', ['水泵', '水箱', '水处理', '软水', '加药', '气压罐', '隔油', '潜水泵',
    '污水泵', '排污泵', '水加热器', '水表', '热水器', '开水器', '消毒器',
    '变频供水', '隔油池', '化粪池', '集水坑', '膨胀罐']],
  ['ELEC', ['变压器', '发电机', '配电柜', '开关柜', '箱变', 'ups', 'eps',
    '柴油发电机', '电表箱', '控制箱']],
  ['ELV', ['机柜', '弱电箱', '摄像头', '交换机', '控制器']],
];

/** 消防强词。刻意不收裸「报警」—— 入侵报警、防盗报警属安防（智能化） */
const FIRE_STRONG = ['消防', '喷淋', '消火栓', '消火', '排烟', '防烟', '防火',
  '火警', '火灾', '灭火', '应急照明', '疏散', 'fire', 'sprinkler', 'smoke'];

/* ------------------------------------------------------------------ *
 * BIM 语义层：IFC 实体 + OmniClass 编码
 *
 * 依据（这两套是 BIM 交换与分类的国际标准，比中文关键词可靠）：
 *   - IFC4（ISO 16739-1）建筑设备域按**专业 schema** 划分：
 *     IfcHvacDomain / IfcPlumbingFireProtectionDomain / IfcElectricalDomain /
 *     IfcBuildingControlsDomain。IFC4 参考视图里给了一张「实体 → 专业」对照表，
 *     本表照抄（Heating/Cooling、Ventilation/AC、Plumbing、Electrical、Controls 五栏）。
 *   - OmniClass Table 23（Products）一级类目编码段：
 *     23-25 结构与空间分隔、23-29 设施与人身防护、23-30 洞口/通道/防护、
 *     23-31 给排水、23-33 暖通空调、23-35 电气与照明、23-37 信息与通信。
 * 这两样只要模型带了，就比猜中文词准得多。
 * ------------------------------------------------------------------ */

/** IFC 实体 → 专业（键统一小写，去掉 Ifc 前缀亦可） */
const IFC_DISCIPLINE = {
  // 暖通：冷热源与能量转换
  boiler: 'HVAC', burner: 'HVAC', coil: 'HVAC', chiller: 'HVAC', condenser: 'HVAC',
  coolingtower: 'HVAC', evaporativecooler: 'HVAC', evaporator: 'HVAC',
  heatexchanger: 'HVAC', spaceheater: 'HVAC', tubebundle: 'HVAC',
  // 暖通：通风空调输配与末端
  fan: 'HVAC',
  airterminal: 'HVAC', airterminalbox: 'HVAC', ductsegment: 'HVAC', ductfitting: 'HVAC',
  ductsilencer: 'HVAC', damper: 'HVAC', humidifier: 'HVAC',
  airtoairheatrecovery: 'HVAC', unitaryequipment: 'HVAC', cooledbeam: 'HVAC',
  vibrationisolator: 'HVAC', engine: 'HVAC',
  // 给排水
  pump: 'PLUMB', valve: 'PLUMB', tank: 'PLUMB', pipesegment: 'PLUMB', pipefitting: 'PLUMB',
  sanitaryterminal: 'PLUMB', stackterminal: 'PLUMB', wasteterminal: 'PLUMB',
  interceptor: 'PLUMB', liquidterminal: 'PLUMB', filter: 'PLUMB',
  // 消防
  firesuppressionterminal: 'FIRE',
  // 电气
  cablesegment: 'ELEC', cablefitting: 'ELEC', cablecarriersegment: 'ELEC',
  cablecarrierfitting: 'ELEC', electricappliance: 'ELEC', electricdistributionboard: 'ELEC',
  distributionboard: 'ELEC', electricgenerator: 'ELEC', electricmotor: 'ELEC',
  electrictimecontrol: 'ELEC', motorconnection: 'ELEC', protectivedevice: 'ELEC',
  protectivedevicetrippingunit: 'ELEC', transformer: 'ELEC', junctionbox: 'ELEC',
  lightfixture: 'ELEC', lamp: 'ELEC', switchingdevice: 'ELEC', outlet: 'ELEC',
  solardevice: 'ELEC', electricflowstoragedevice: 'ELEC',
  // 智能化 / 弱电 / 楼控
  communicationsappliance: 'ELV', audiovisualappliance: 'ELV', sensor: 'ELV',
  actuator: 'ELV', alarm: 'ELV', controller: 'ELV', flowinstrument: 'ELV',
  flowmeter: 'ELV', unitarycontrolelement: 'ELV',
  // 建筑 / 结构
  wall: 'ARCH', door: 'ARCH', window: 'ARCH', slab: 'ARCH', stair: 'ARCH',
  railing: 'ARCH', roof: 'ARCH', covering: 'ARCH', curtainwall: 'ARCH',
  column: 'STR', beam: 'STR', member: 'STR', footing: 'STR', pile: 'STR',
  plate: 'STR', reinforcingbar: 'STR', reinforcingmesh: 'STR', tendon: 'STR',
};

/** OmniClass Table 23 一级类目编码 → 专业（取前两段：23.33 → HVAC） */
const OMNICLASS_PREFIX = {
  '23.11': 'OTHER', '23.13': 'STR', '23.15': 'ARCH', '23.17': 'ARCH',
  '23.19': 'OTHER', '23.21': 'ARCH', '23.23': 'ELEC', '23.25': 'STR',
  '23.27': 'OTHER', '23.29': 'FIRE', '23.30': 'ARCH', '23.31': 'PLUMB',
  '23.33': 'HVAC', '23.35': 'ELEC', '23.37': 'ELV', '23.39': 'OTHER',
};

/** OmniClass 英文标题关键词（编码缺失时的兜底；也用于 23.29 的消防/安防拆分） */
const OMNI_TITLE = [
  ['FIRE', ['fire', 'sprinkler', 'smoke', 'extinguish']],
  ['ELV', ['cctv', 'intrusion', 'security', 'access control', 'communication',
    'audio', 'data', 'telephone', 'network']],
  ['HVAC', ['hvac', 'duct', 'air', 'fan', 'boiler', 'chiller', 'heating', 'cooling',
    'ventilat', 'humidif']],
  ['PLUMB', ['plumb', 'pipe', 'sanitary', 'valve', 'pump', 'tank', 'drain', 'faucet',
    'toilet', 'sink', 'shower', 'urinal', 'water']],
  ['ELEC', ['electric', 'light', 'cable', 'transform', 'panel', 'switch', 'generator',
    'conduit', 'wire']],
  ['STR', ['column', 'beam', 'structur', 'foundation', 'footing', 'pile', 'steel',
    'concrete', 'slab']],
  ['ARCH', ['door', 'window', 'wall', 'partition', 'ceiling', 'floor', 'stair',
    'railing', 'roof', 'curtain wall', 'furnitur']],
];

const valueOfKeys = (props, re) => {
  for (const [k, v] of Object.entries(props)) {
    if (!re.test(k)) continue;
    const t = cleanText(v);
    if (t) return t;
  }
  return '';
};

/** 从 IFC 实体名得到专业；props 里可能叫「导出类型到 IFC」「IFC 类型」「ifcType」… */
export function ifcDiscipline(props) {
  const p = props || {};
  const raw = valueOfKeys(p, /ifc/i);
  if (!raw) return '';
  // 可能是 "IfcPump" / "IFC4 IfcPump" / "IfcFlowMovingDevice/IfcPump"
  const found = raw.match(/Ifc[A-Za-z]+/g);
  if (!found) return '';
  for (const name of found) {
    const key = name.replace(/^Ifc/, '').toLowerCase();
    if (IFC_DISCIPLINE[key]) return IFC_DISCIPLINE[key];
  }
  return '';
}

/** 从 OmniClass 编号/标题得到专业 */
export function omniclassDiscipline(props) {
  const p = props || {};
  const code = valueOfKeys(p, /omniclass.*(编号|number|code)/i) || cleanText(p['OmniClass 编号']);
  const title = (valueOfKeys(p, /omniclass.*(标题|title|name)/i) || cleanText(p['OmniClass 标题'])).toLowerCase();

  if (code) {
    const head = code.replace(/[^0-9.]/g, '.').match(/^2?3\.(\d{2})/);
    const key = head ? `23.${head[1]}` : '';
    const mapped = key && OMNICLASS_PREFIX[key];
    // 23.29 是「设施与人身防护」，消防与安防混在一起，看标题拆
    if (mapped === 'FIRE' && title) {
      if (/cctv|intrusion|security|access|surveillance/.test(title)) return 'ELV';
    }
    if (mapped && mapped !== 'OTHER') return mapped;
  }
  if (title) {
    for (const [code2, words] of OMNI_TITLE) {
      for (const w of words) if (title.includes(w)) return code2;
    }
  }
  return '';
}

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
 * 构件 → 专业代码 + 判定来源
 *
 * 比 disciplineCode 多给两样东西，树上的悬浮提示和体检报告要用：
 *   from   —— 是哪一级规则定的（manual = 手工命名规则、category = 同类别多数…）
 *   detail —— 一句人话依据（"系统名「智能照明」" / "没有「_」分隔符"）
 *
 * @param {object} props 构件的 BIM 属性（extras，可能是空对象）
 * @param {{fireFirst?: boolean, name?: string}} [opts] name = 构件名，手工命名规则的输入
 * @returns {{code:string, from:string, detail:string}}
 */
export function resolveDiscipline(props, opts = {}) {
  const p = props || {};
  const fireFirst = opts.fireFirst ?? POLICY.fireFirst;
  const name = cleanText(opts.name ?? p['名称'] ?? p['Name']);

  const sysCat = cleanText(p['系统分类']);
  const sysType = cleanText(p['系统类型']);
  const sysName = cleanText(p['系统名称']);
  const cat = cleanText(p['Category Name']) || cleanText(p['类别']);
  const fam = cleanText(p['族']) || cleanText(p['Family Name']);
  const abbr = systemKey(p);

  // 手工命名规则：**只在构件完全没有系统字段时生效**。
  // 有属性就以属性为准 —— 用户随手起的名字不能盖掉模型自带的权威口径。
  const hasSysField = !!(sysCat || sysType || sysName || cleanText(p['系统缩写']));
  const man = hasSysField ? { ok: false, reason: 'has-sys' } : parseManualName(name);
  const manSys = man.ok ? man.system : '';
  const manDev = man.ok ? man.device : '';
  // 系统名参与「系统口径」打分（和 系统分类/系统类型 同级），设备名进设备词表
  const sysFromManual = man.ok && !(sysCat || sysType || sysName);

  const typeName = cleanText(p['Type Name']);
  const sysText = [sysCat, sysType, sysName, manSys].filter(Boolean).join(' '); // 系统口径
  const compText = [cat, fam, manDev].filter(Boolean).join(' ');                // 构件口径
  const equipText = [cat, fam, typeName, manDev].filter(Boolean).join(' ');     // 设备识别口径
  const allText = `${sysText} ${compText}`;
  const detail = man.ok ? `系统名「${man.system}」` : '';
  const ret = (code, from) => ({ code, from, detail });

  // ① 模型自带专业字段
  const explicit = cleanText(p['专业']) || cleanText(p['专业名称']);
  if (explicit) {
    if (has(explicit, FIRE_STRONG)) return ret(fireFirst ? 'FIRE' : (fireHostOf(explicit) || 'FIRE'), 'field');
    const b = bestOf(scoreStrong(explicit));
    if (b) return ret(b, 'field');
    const w = scoreWeak(explicit);
    if (w) return ret(w, 'field');
  }

  // ② 消防优先：系统字段和构件字段都看（消防是职能口径，跨专业存在）
  if (has(allText, FIRE_STRONG)) {
    return ret(fireFirst ? 'FIRE' : (fireHostOf(sysText || compText) || 'FIRE'), 'fire');
  }

  // ③ BIM 语义层（IFC 实体 / OmniClass 编码）里凡是消防的先落地 —— 消防优先不能漏。
  //    （IFC4 按 IfcHvacDomain / IfcPlumbingFireProtectionDomain / IfcElectricalDomain
  //      划分专业；OmniClass Table 23 的 23-31/33/35/37 就是给排水/暖通/电气/信息通信）
  const bim = ifcDiscipline(p) || omniclassDiscipline(p);
  if (bim === 'FIRE') {
    return ret(fireFirst ? 'FIRE' : (fireHostOf(sysText || compText) || 'FIRE'), 'fire');
  }

  // ④ 系统中文语义 —— **比缩写可靠**：模型自己写的「系统分类 / 系统类型」是权威口径，
  //    缩写只是各院自定的代号（同一个 NW，有的指网络，有的指凝结水）。
  //    手工命名里的系统名也走这一级（它的地位等同系统字段）。
  const semanticFrom = sysFromManual ? 'manual' : 'semantic';
  const sc = scoreStrong(sysText);
  // 混合水系统：同时含空调类词和排水类词 → 按排水（它是把水排走的系统，
  // 而不是制备冷热水的系统）。例：NW = 空调凝结水 + 坡道雨水。
  if (has(sysText, DRAIN) && (sc.get('HVAC') || 0) > 0) return ret('PLUMB', semanticFrom);
  const best = bestOf(sc);
  if (best) return ret(best, semanticFrom);

  // ⑤ BIM 语义层：IFC 实体 / OmniClass 编码 —— 系统没给答案时，按「这是什么设备」定。
  //    顺序放在系统语义之后是有意的：一台泵在冷冻水系统里属暖通，不能因为它是 IfcPump
  //    就划到给排水；但模型没写系统时，IfcPump 就是最可靠的依据。
  if (bim) return ret(bim, 'bim');

  // ⑥ 系统缩写（模型没给中文语义时才兜底）
  if (abbr && abbr !== UNKNOWN_LABEL && ABBR_DISCIPLINE[abbr]) {
    return ret(ABBR_DISCIPLINE[abbr], 'abbr');
  }

  // ⑦ 兜底：系统名里的泛词 → 构件类别上的强词（如「电缆桥架」）→ 设备名 → 构件泛词
  const weakSys = scoreWeak(sysText);
  if (weakSys) return ret(weakSys, sysFromManual ? 'manual' : 'fallback');
  const strongComp = bestOf(scoreStrong(compText));
  if (strongComp) return ret(strongComp, sysFromManual ? 'manual' : 'fallback');
  // 设备名（板式换热器 → 暖通、水泵 → 给排水…）：机械设备这种泛类别靠它定专业
  const equip = bestOf(scoreStrong(equipText, EQUIP));
  if (equip) return ret(equip, sysFromManual ? 'manual' : 'fallback');
  const weakComp = scoreWeak(compText);
  if (weakComp) return ret(weakComp, sysFromManual ? 'manual' : 'fallback');

  // ⑨ 兜底桶：属性缺失 + 命名不合规 / 系统名认不出
  return {
    code: 'NONE',
    from: 'none',
    detail: man.ok ? `系统名「${man.system}」认不出专业` : (MANUAL_REASONS[man.reason] || ''),
  };
}

/**
 * 构件 → 专业代码（只要结果）
 * @param {object} props 构件的 BIM 属性（extras）
 * @param {{fireFirst?: boolean, name?: string}} [opts]
 */
export function disciplineCode(props, opts = {}) {
  return resolveDiscipline(props, opts).code;
}

/**
 * 构件所属的「类别」—— 同类别多数兜底的分组键。
 * 用 Category Name（Revit 的类别）而不是族：族太细，同族内部不会有分歧。
 */
export function categoryKey(props) {
  const p = props || {};
  return cleanText(p['Category Name']) || cleanText(p['类别']);
}

/**
 * 泛类别：本身横跨多个专业，不能拿「同类别多数」去推。
 * 例：机械设备下面既有换热器（暖通）也有水泵（给排水）。
 */
const GENERIC_CATS = ['常规模型', '机械设备', '专用设备', '设备', '其他', '系统设备', '族'];

/**
 * 整批构件 → 专业（带「同类别多数」兜底）
 *
 * 单看一条属性判不出来的构件，往往能和已经判对的同类构件归到一起：
 * 例如某套模型里「管件」大部分带系统信息、少数没带 —— 没带的那些跟同类走是对的。
 * 规则（三道闸，宁可留在「其他分类」也不乱归）：
 *   1. 只对**非泛类别**生效（机械设备 / 常规模型 / 专用设备 …除外）
 *   2. 该类别里已判对（非其他分类）的样本 ≥ 3 条
 *   3. 这些样本里最高专业占比 ≥ 75%
 *
 * 判定前先把构件名交给手工命名规则（`系统名_设备名+编号`），所以「其他分类」里的
 * 手工模型只要名字合规就会先被分掉，走不到多数推断这一层。
 *
 * @param {Array<{props: object, name?: string}>} leaves
 * @returns {Map<object, {label: string, code: string, from: string, detail: string}>}
 */
export function classifyLeaves(leaves) {
  const rows = leaves.map((leaf) => {
    const r = resolveDiscipline(leaf.props || {}, { name: leaf.name });
    return { leaf, code: r.code, from: r.from, detail: r.detail };
  });

  const byCat = new Map();
  for (const r of rows) {
    if (r.code === 'NONE') continue;
    const cat = categoryKey(r.leaf.props || {});
    if (!cat || GENERIC_CATS.includes(cat)) continue;
    let m = byCat.get(cat);
    if (!m) { m = new Map(); byCat.set(cat, m); }
    m.set(r.code, (m.get(r.code) || 0) + 1);
  }

  const out = new Map();
  for (const r of rows) {
    let { code, from, detail } = r;
    if (code === 'NONE') {
      const cat = categoryKey(r.leaf.props || {});
      const m = cat && !GENERIC_CATS.includes(cat) ? byCat.get(cat) : null;
      if (m) {
        const total = [...m.values()].reduce((a, b) => a + b, 0);
        const [best, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
        if (total >= 3 && n / total >= 0.75) {
          code = best;
          from = 'category';
          detail = `同类别「${cat}」多数为${disciplineName(best)}`;
        }
      }
    }
    out.set(r.leaf, { label: disciplineName(code), code, from, detail });
  }
  return out;
}

/** 构件 → 专业名（树里显示的文字） */
export function disciplineOf(props, opts) {
  return disciplineName(disciplineCode(props, opts));
}
