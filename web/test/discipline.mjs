/**
 * discipline.mjs —— 规范层级第一层「专业」的判定规则（纯 Node，不依赖浏览器）
 *
 * node test/discipline.mjs
 */
import { disciplineCode, disciplineName, ABBR_DISCIPLINE, POLICY } from '../src/viewer/discipline.js';

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
  'NW = 空调凝结水+坡道雨水 → 给排水（不是智能化）');
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

console.log('--- 显式字段与兜底 ---');
eq({ 专业: '消防', 'Category Name': '风管' }, 'FIRE', '模型自带专业字段优先');
eq({}, 'NONE', '空属性 → 未分类');
eq({ 系统名称: '自定义系统 A', 'Category Name': '自定义' }, 'NONE', '认不出的一律未分类，不瞎猜');

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
