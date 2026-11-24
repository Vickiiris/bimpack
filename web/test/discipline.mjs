/**
 * discipline.mjs —— 规范层级第一层「专业」的判定规则（纯 Node，不依赖浏览器）
 *
 * node test/discipline.mjs
 */
import { disciplineCode, disciplineName, ABBR_DISCIPLINE, POLICY, classifyLeaves } from '../src/viewer/discipline.js';
import { equipmentKind, NON_MEP } from '../src/viewer/equipment.js';

let failed = 0;
const eq = (props, want, msg, opts) => {
  const got = disciplineCode(props, opts);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${msg}：${JSON.stringify(props)} → ${got}${ok ? '' : `（期望 ${want}）`}`);
};

console.log('--- 缩写查表 ---');
eq({ 系统缩写: 'CHW' }, 'HVAC', 'CHW 冷冻水 → 暖通');
eq({ 系统缩写: 'CWP' }, 'HVAC', 'CWP 冷却水泵 → 暖通（水系统按惯例随暖通）');
eq({ 系统缩写: 'XH' }, 'FIRE', 'XH 消火栓 → 消防');
eq({ 系统缩写: 'SP' }, 'FIRE', 'SP 喷淋 → 消防');
eq({ 系统缩写: 'AL' }, 'ELEC', 'AL 桥架 → 电气');
eq({ 系统缩写: 'PY' }, 'FIRE', 'PY 排烟 → 消防');
eq({ 系统缩写: 'JL' }, 'PLUMB', 'JL 给水 → 给排水');

console.log('--- 消防优先（核心冲突规则）---');
eq({ 系统缩写: 'PY', 系统分类: '排烟', 'Category Name': '风管' }, 'FIRE', '排烟风管：设备是风管，系统是消防 → 消防');
eq({ 系统缩写: 'SF', 系统分类: '送风', 'Category Name': '风管' }, 'HVAC', '送风管 → 暖通（同类别不同专业，不并到一起）');
eq({ 系统名称: '喷淋 3', 'Category Name': '管道' }, 'FIRE', '喷淋管道 → 消防（管道本身属给排水）');
eq({ 系统名称: '消防水泵 1', 'Category Name': '管道' }, 'FIRE', '消防水泵 → 消防（水泵本身属给排水/暖通）');
eq({ 系统分类: '排烟', 'Category Name': '风管' }, 'HVAC', '关掉消防优先后排烟风管归暖通（策略可配）', { fireFirst: false });

console.log('--- 系统中文名关键词（缩写不在表里）---');
eq({ 系统名称: '生活给水 JL 3', 'Category Name': '管道' }, 'PLUMB', '生活给水 → 给排水');
eq({ 系统名称: '弱电 1', 'Category Name': '电缆桥架' }, 'ELV', '弱电 → 智能化（同类别桥架，不同专业）');
eq({ 系统名称: '燃气 1', 'Category Name': '管道' }, 'GAS', '燃气 → 燃气');
eq({ 系统名称: '冷凝水 2', 'Category Name': '管道' }, 'HVAC', '冷凝水 → 暖通');

console.log('--- 系统中文语义优先于缩写（NW 误判成智能化的回归）---');
eq({ 系统缩写: 'NW', 系统分类: '排水', 系统类型: 'NW-空调凝结水、坡道雨水', 'Category Name': '管道' }, 'PLUMB',
  'NW = 空调凝结水+坡道雨水 → 给排水（不是安防/ELV）');
eq({ 系统类型: 'NW-空调凝结水、坡道雨水', 'Category Name': '管道' }, 'PLUMB',
  '即使没有系统分类，混合水系统也按排水');
eq({ 系统缩写: 'NW', 'Category Name': '管道' }, 'PLUMB', '缩写 NW 不再当网络，回落到类别');
eq({ 系统类型: '空调冷凝水', 'Category Name': '管道' }, 'HVAC', '纯冷凝水系统仍归暖通');
eq({ 系统类型: '网络', 'Category Name': '电缆桥架' }, 'ELV', '真正的网络系统仍归智能化');
eq({ 系统分类: '入侵报警', 'Category Name': '电缆桥架' }, 'ELEC', '入侵报警不当消防（裸「报警」已从消防词里去掉）');
eq({ 系统分类: '火灾报警', 'Category Name': '电缆桥架' }, 'FIRE', '火灾报警仍是消防');
eq({ 系统名称: '生活热水 1', 'Category Name': '管道' }, 'PLUMB', '生活热水 → 给排水');
eq({ 系统类型: 'CHW-冷冻水', 'Category Name': '管道' }, 'HVAC', '系统类型写明冷冻水就按语义走');
eq({ 系统类型: 'PY-排烟风管', 系统缩写: 'PY', 'Category Name': '风管' }, 'FIRE', '排烟风管仍归消防');

console.log('--- 无系统字段：靠类别/族 ---');
eq({ 'Category Name': '墙', 族: '基本墙' }, 'ARCH', '墙 → 建筑');
eq({ 'Category Name': '结构框架', 族: 'HW-矩形梁' }, 'STR', '结构框架 → 结构');
eq({ 'Category Name': '楼板' }, 'ARCH', '楼板 → 建筑（不是结构）');
eq({ 'Category Name': '门', 族: 'HW-单扇平开门' }, 'ARCH', '门 → 建筑');
eq({ 'Category Name': '电缆桥架' }, 'ELEC', '桥架（无系统） → 电气');

console.log('--- 机械设备（跨专业泛类别）靠设备名定专业 ---');
eq({ 'Category Name': '机械设备', 族: '板式换热器(1)', 'Type Name': '板式换热器 -1700KW' }, 'HVAC',
  '板式换热器 → 暖通（不是结构：单字「板」早已从弱词表移除）');
eq({ 'Category Name': '机械设备', 族: '冷水机组(1)' }, 'HVAC', '冷水机组 → 暖通');
eq({ 'Category Name': '机械设备', 族: '空调机组(1)' }, 'HVAC', '空调机组 → 暖通');
eq({ 'Category Name': '机械设备', 族: '风机盘管(1)' }, 'HVAC', '风机盘管 → 暖通');
eq({ 'Category Name': '机械设备', 族: '水泵(1)' }, 'PLUMB', '水泵 → 给排水');
eq({ 'Category Name': '机械设备', 族: '水箱(1)' }, 'PLUMB', '水箱 → 给排水');
eq({ 'Category Name': '机械设备', 族: '变压器(1)' }, 'ELEC', '变压器 → 电气');
eq({ 'Category Name': '结构框架', 族: 'HW-矩形梁' }, 'STR', '结构构件仍然归结构');
eq({ 'Category Name': '楼板', 族: '楼板' }, 'ARCH', '楼板仍归建筑');
eq({ 'Category Name': '楼梯', 族: '组合楼梯' }, 'ARCH', '楼梯仍归建筑');

console.log('--- 显式字段与兜底 ---');
eq({ 专业: '消防', 'Category Name': '风管' }, 'FIRE', '模型自带专业字段优先');
eq({}, 'NONE', '空属性 → 未分类');
eq({ 系统名称: '自定义系统 A', 'Category Name': '自定义' }, 'NONE', '认不出的一律未分类，不瞎猜');

console.log('--- 常见机电族（以前落未分类的）---');
eq({ 'Category Name': '常规模型', 族: '套管_', 'Type Name': 'PD1-DN89' }, 'PLUMB', '管道套管 → 给排水');
eq({ 'Category Name': '管道附件', 族: '过滤器' }, 'PLUMB', '管道附件 → 给排水');
eq({ 'Category Name': '风管附件', 族: '消声器' }, 'HVAC', '风管附件 → 暖通');
eq({ 'Category Name': '电气设备', 族: '接线盒' }, 'ELEC', '接线盒 → 电气');
eq({ 'Category Name': '机械设备', 族: '空气幕(1)' }, 'HVAC', '空气幕 → 暖通');
eq({ 'Category Name': '机械设备', 族: '热水器(1)' }, 'PLUMB', '热水器 → 给排水');

console.log('--- 同类别多数兜底（整批判定）---');
const leaf = (props) => ({ props });
{
  // 同类 3 条判对（给排水）+ 1 条什么都没有 → 跟同类
  const ls = [
    leaf({ 'Category Name': '特殊部件', 系统名称: '生活给水 1' }),
    leaf({ 'Category Name': '特殊部件', 系统名称: '生活给水 2' }),
    leaf({ 'Category Name': '特殊部件', 系统名称: '生活给水 3' }),
    leaf({ 'Category Name': '特殊部件' }),
  ];
  const r = classifyLeaves(ls);
  const got = r.get(ls[3]);
  const ok = got.code === 'PLUMB' && got.from === 'category';
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} 3 条同类都是给排水 → 第 4 条跟过去（${got.code}/${got.from}）`);
}
{
  // 泛类别（机械设备）内部专业不一致 → 不许推
  const ls = [
    leaf({ 'Category Name': '机械设备', 族: '板式换热器(1)' }),
    leaf({ 'Category Name': '机械设备', 族: '水泵(1)' }),
    leaf({ 'Category Name': '机械设备', 族: '未知设备甲' }),
    leaf({ 'Category Name': '机械设备', 族: '未知设备乙' }),
  ];
  const r = classifyLeaves(ls);
  const got = r.get(ls[2]);
  const ok = got.code === 'NONE';
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} 机械设备是泛类别，不确定的仍留未分类（${got.code}）`);
}
{
  // 样本不足 3 条 → 不推
  const ls = [
    leaf({ 'Category Name': '稀有类别', 系统名称: '给水 1' }),
    leaf({ 'Category Name': '稀有类别' }),
  ];
  const r = classifyLeaves(ls);
  const ok = r.get(ls[1]).code === 'NONE';
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} 同类样本不足 3 条时不推（${r.get(ls[1]).code}）`);
}
{
  // 同类里专业混杂（各半）→ 不推
  const ls = [
    leaf({ 'Category Name': '混杂类别', 系统名称: '给水 1' }),
    leaf({ 'Category Name': '混杂类别', 系统名称: '冷冻水 1' }),
    leaf({ 'Category Name': '混杂类别', 系统名称: '生活给水 2' }),
    leaf({ 'Category Name': '混杂类别', 系统名称: '空调冷冻水 2' }),
    leaf({ 'Category Name': '混杂类别' }),
  ];
  const r = classifyLeaves(ls);
  const ok = r.get(ls[4]).code === 'NONE';
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} 同类里专业混杂（50 对 50）时不推（${r.get(ls[4]).code}）`);
}

console.log('--- BIM 语义层：IFC 实体 ---');
eq({ 导出类型到IFC: '', 'IFC 类型': 'IfcPump' }, 'PLUMB', 'IfcPump → 给排水');
eq({ '导出类型到 IFC': 'IfcChiller' }, 'HVAC', 'IfcChiller → 暖通');
eq({ '导出类型到 IFC': 'IfcBoiler' }, 'HVAC', 'IfcBoiler → 暖通');
eq({ '导出类型到 IFC': 'IfcHeatExchanger' }, 'HVAC', 'IfcHeatExchanger → 暖通');
eq({ '导出类型到 IFC': 'IfcFan' }, 'HVAC', 'IfcFan → 暖通');
eq({ '导出类型到 IFC': 'IfcDuctSegment' }, 'HVAC', 'IfcDuctSegment → 暖通');
eq({ '导出类型到 IFC': 'IfcValve' }, 'PLUMB', 'IfcValve → 给排水');
eq({ '导出类型到 IFC': 'IfcSanitaryTerminal' }, 'PLUMB', 'IfcSanitaryTerminal → 给排水');
eq({ '导出类型到 IFC': 'IfcFireSuppressionTerminal' }, 'FIRE', 'IfcFireSuppressionTerminal → 消防');
eq({ '导出类型到 IFC': 'IfcLightFixture' }, 'ELEC', 'IfcLightFixture → 电气');
eq({ '导出类型到 IFC': 'IfcCableCarrierSegment' }, 'ELEC', '桥架段 → 电气');
eq({ '导出类型到 IFC': 'IfcTransformer' }, 'ELEC', '变压器 → 电气');
eq({ '导出类型到 IFC': 'IfcCommunicationsAppliance' }, 'ELV', '通信设备 → 安防（ELV）');
eq({ '导出类型到 IFC': 'IfcSensor' }, 'ELV', '传感器 → 安防（ELV）');
eq({ '导出类型到 IFC': 'IfcColumn' }, 'STR', 'IfcColumn → 结构');
eq({ '导出类型到 IFC': 'IfcPump', 系统分类: '冷冻水' }, 'HVAC', '系统优先于设备类型：冷冻水泵归暖通');
eq({ '导出类型到 IFC': 'IfcFireSuppressionTerminal', 系统分类: '给水' }, 'FIRE', '消防实体压过系统字段');
eq({ '导出类型到 IFC': '默认' }, 'NONE', '「默认」不是 IFC 实体，不参与判定');

console.log('--- BIM 语义层：OmniClass Table 23 ---');
eq({ 'OmniClass 编号': '23.30.10.00', 'OmniClass 标题': 'Doors' }, 'ARCH', '23-30 门 → 建筑');
eq({ 'OmniClass 编号': '23.25.30.11.14.11', 'OmniClass 标题': 'Columns' }, 'STR', '23-25 柱 → 结构');
eq({ 'OmniClass 编号': '23.33.00.00' }, 'HVAC', '23-33 暖通');
eq({ 'OmniClass 编号': '23.31.11.00' }, 'PLUMB', '23-31 给排水');
eq({ 'OmniClass 编号': '23.35.47.11' }, 'ELEC', '23-35 电气（灯具）');
eq({ 'OmniClass 编号': '23.37.11.00' }, 'ELV', '23-37 信息通信');
eq({ 'OmniClass 编号': '23.29.11.11', 'OmniClass 标题': 'CCTV' }, 'ELV', '23-29 里的安防 → 安防（ELV）');
eq({ 'OmniClass 编号': '23.29.29.00', 'OmniClass 标题': 'Fire Detection Devices' }, 'FIRE', '23-29 里的火灾探测 → 消防');
eq({ 'OmniClass 标题': 'Plumbing Fixtures' }, 'PLUMB', '只有英文标题也能判');
eq({ 'Category Name': '机械设备', 族: '未知设备', 'OmniClass 编号': '23.33.00.00' }, 'HVAC',
  '机械设备 + OmniClass 暖通 → 暖通（泛类别终于有依据了）');

console.log('--- 建筑构件类别一票否决（防火板墙不进消防）---');
eq({ 'Category Name': '墙', 族: '基本墙', 'Type Name': '3H防火板墙_150' }, 'ARCH',
  '防火板墙：类别是墙 → 建筑（不被「防火」拉进消防）', { name: '基本墙_3H防火板墙_150_1055' });
eq({ 'Category Name': '门', 族: '智能防火门' }, 'ARCH',
  '智能防火门：类别是门 → 建筑', { name: '门 | 智能防火门' });
eq({ 'Category Name': '幕墙嵌板', '系统名称': '防火分区' }, 'ARCH',
  '幕墙嵌板（前缀判）→ 建筑');
eq({ 'Category Name': '结构梁', 'Type Name': '防火涂料钢梁' }, 'STR', '钢梁刷防火涂料仍是结构');
eq({ 'Category Name': '楼板', '系统名称': '消防' }, 'ARCH', '楼板不因系统名叫消防就进消防');
// 消防系统本体不能被误伤
eq({ 'Category Name': '喷头', '系统名称': '消防喷淋' }, 'FIRE', '喷淋头仍是消防');
eq({ 'Category Name': '风管', '系统缩写': 'PY', '系统名称': '排烟' }, 'FIRE', '排烟风管仍是消防');
eq({ 'Category Name': '管道', '系统名称': '消火栓' }, 'FIRE', '消火栓管道仍是消防');
// 与设备层口径一致：同一根构件两档归属相同
const wall = { 'Category Name': '墙', 族: '基本墙', 'Type Name': '3H防火板墙_150' };
const wCode = disciplineCode(wall, { name: '基本墙_3H防火板墙_150_1055' });
const wKind = equipmentKind(wall, '基本墙_3H防火板墙_150_1055');
if (!(wCode === 'ARCH' && wKind === NON_MEP)) failed++;
console.log(`${wCode === 'ARCH' && wKind === NON_MEP ? '✓' : '✗'} 专业层与设备层同一口径（${disciplineName(wCode)} / ${wKind}）`);

console.log('--- 表结构自检 ---');
const bad = Object.entries(ABBR_DISCIPLINE).filter(([k, v]) => k !== k.toUpperCase() || !disciplineName(v));
if (bad.length) failed++;
console.log(`${bad.length ? '✗' : '✓'} 缩写表的键都是大写且专业代码有效（${Object.keys(ABBR_DISCIPLINE).length} 条）`);

// 有歧义的缩写不许再进表 —— NW 这次就是把凝结水认成网络的元凶
const RISKY = ['NW', 'W', 'FS', 'TR', 'HW', 'HWS', 'HWR', 'QT', 'SSP', 'FFS', 'WSF'];
const leaked = RISKY.filter((k) => k in ABBR_DISCIPLINE);
if (leaked.length) failed++;
console.log(`${leaked.length ? '✗' : '✓'} 含义不稳定的缩写没有进表${leaked.length ? '：' + leaked.join(',') : `（已排除 ${RISKY.join(' ')}）`}`);
console.log(`${POLICY.fireFirst ? '✓' : '✗'} 默认策略：消防优先单列（GB 55037 口径）`);
console.log(`${disciplineName('HVAC') === '暖通空调' ? '✓' : '✗'} 专业名可反查（HVAC → 暖通空调）`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
