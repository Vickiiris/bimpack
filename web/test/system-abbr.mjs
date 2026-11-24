/**
 * system-abbr.mjs —— 「系统名称 → 系统缩写」归类规则（通用，不绑定任何具体模型）
 *
 * 规则：以英文缩写作为类别标识，缩写后跟随的编号不参与类别判定。
 * node test/system-abbr.mjs
 */
import { systemAbbr, GROUP_MODES } from '../src/viewer/tree.js';

let failed = 0;
const eq = (input, want, msg) => {
  const got = systemAbbr(input);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${msg}：${JSON.stringify(input)} → ${JSON.stringify(got)}${ok ? '' : `（期望 ${JSON.stringify(want)}）`}`);
};

console.log('--- 基本形态：缩写 + 空格 + 编号 ---');
eq('CN 5', 'CN', '同缩写不同编号归为一类');
eq('CN 7', 'CN', '同缩写不同编号归为一类');
eq('CN 15', 'CN', '同缩写不同编号归为一类');
eq('CWP 3', 'CWP', '多字母缩写');
eq('CW 1', 'CW', '两字母缩写');

console.log('--- 分隔符变体：编号不参与判定 ---');
eq('CN-5', 'CN', '连字符');
eq('CN_05', 'CN', '下划线 + 前导零');
eq('CN.5', 'CN', '点号');
eq('CN5', 'CN', '数字紧贴缩写');
eq('CW 2A', 'CW', '编号里带字母后缀');

console.log('--- 大小写 / 空白 ---');
eq('cn 5', 'CN', '统一大写');
eq('  CN   5  ', 'CN', '多点空白');
eq('Cwp\t4', 'CWP', '制表符 + 混合大小写');

console.log('--- 多系统值：取第一个系统的缩写 ---');
eq('CR 30,CR 18', 'CR', '英文逗号');
eq('CR 30，CR 18', 'CR', '中文逗号');
eq('CW 2;CW 3', 'CW', '分号');
eq('CW 2/CW 3', 'CW', '斜杠');
eq('CS 1、CS 2', 'CS', '顿号');

console.log('--- 缩写里带字母后缀：字母有区分意义，保留 ---');
eq('CHW-A', 'CHW-A', '字母后缀保留（不是编号）');
eq('CHW-B 12', 'CHW-B', '字母后缀 + 编号');

console.log('--- 注释 / 兜底 ---');
eq('CN 5(备用)', 'CN', '括号注释');
eq('CN 5（备用）', 'CN', '中文括号注释');
eq('', '其他分类', '空值');
eq('   ', '其他分类', '纯空白');
eq('5', '其他分类', '纯数字');
eq('12 34', '其他分类', '纯数字带空格');
eq('冷冻水', '冷冻水', '无英文缩写的中文值原样保留');
eq('生活给水 JL 3', '生活给水 JL', '中文 + 缩写：保留到编号前');

console.log('--- 优先用模型自带的「系统缩写」字段 ---');
const { systemKey, stripAbbrPrefix } = await import('../src/viewer/tree.js');
const k = (props, want, msg) => {
  const got = systemKey(props);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${msg}：${JSON.stringify(props)} → ${JSON.stringify(got)}${ok ? '' : `（期望 ${want}）`}`);
};
k({ 系统缩写: 'EAD', 系统名称: 'EAD 5' }, 'EAD', '自带缩写优先，取字段而非解析系统名称');
k({ 系统缩写: ' ead-5 ' }, 'EAD', '自带缩写带编号/空白也能收敛');
k({ 系统名称: 'CN 5' }, 'CN', '没有自带缩写字时回落到系统名称解析');
k({ 系统缩写: '', 系统名称: 'CR 30,CR 18' }, 'CR', '空字段视同没有');
k({}, '其他分类', '两个字段都没有');

const sp = (v, abbr, want, msg) => {
  const got = stripAbbrPrefix(v, abbr);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${msg}：${JSON.stringify(v)} → ${JSON.stringify(got)}${ok ? '' : `（期望 ${want}）`}`);
};
sp('EAD-排风管', 'EAD', '排风管', '系统类型去掉缩写前缀');
sp('EAD 排风管', 'EAD', '排风管', '空格分隔');
sp('EAD：排风管', 'EAD', '排风管', '中文冒号分隔');
sp('排风管', 'EAD', '排风管', '没有前缀时原样返回');

console.log('--- 分组模式注册 ---');
const sys = GROUP_MODES.system;
const m1 = sys?.fields?.[0]?.map;
const okMode = typeof m1 === 'function'
  && m1('EAD 5', { 系统缩写: 'EAD', 系统名称: 'EAD 5' }) === 'EAD'
  && m1('CN 7', { 系统名称: 'CN 7' }) === 'CN';
if (!okMode) failed++;
console.log(`${okMode ? '✓' : '✗'} 「系统 → 类别」用系统缩写归一`);
const okDepth = sys?.fields?.length === 2;
if (!okDepth) failed++;
console.log(`${okDepth ? '✓' : '✗'} 两级分组深度正确`);

// 下拉视图：同义变体（族 / 标高 / 系统→类别→类型）不再注册；
// 主干「专业›系统›类别›类型」+ 两级「专业›设备分类」，以及系统/类别两个换轴视图
const modes = Object.keys(GROUP_MODES);
const want = ['unified', 'discEquip', 'system', 'category', 'raw'];
const okList = modes.join(',') === want.join(',');
if (!okList) failed++;
console.log(`${okList ? '✓' : '✗'} 共 5 种视图：${modes.join(' / ')}`);

const un = GROUP_MODES.unified;
const okUnDepth = un?.fields?.map((f) => f.key).join(',') === '专业,系统名称,Category Name,Type Name';
if (!okUnDepth) failed++;
console.log(`${okUnDepth ? '✓' : '✗'} 主干是四层「专业 → 系统 → 类别 → 类型」`);
const okGone = !('equipment' in GROUP_MODES);
if (!okGone) failed++;
console.log(`${okGone ? '✓' : '✗'} 「系统›专业›设备」已下架`);

// 新增的两级视图：专业 → 设备分类，管综单独成一级
const de = GROUP_MODES.discEquip;
const okDeDepth = de?.fields?.length === 3
  && de.fields[0].key === '专业' && de.fields[0].label === '专业'
  && de.fields[1].key === '设备分类' && de.fields[1].label === '设备分类'
  && de.fields[2].key === 'Category Name' && de.fields[2].label === '类别';
if (!okDeDepth) failed++;
console.log(`${okDeDepth ? '✓' : '✗'} 两级视图字段是「专业 → 设备分类 →（仅管综）类别」`);
const okDePipe = typeof de?.fields?.[0]?.fix === 'function'
  && de.fields[0].fix('暖通空调', { 'Category Name': '风管' }, { name: '送风管 SF 1' }) === '管综'
  && de.fields[0].fix('暖通空调', {}, { name: '风机盘管 FCU-01' }) === '暖通空调';
if (!okDePipe) failed++;
console.log(`${okDePipe ? '✓' : '✗'} 两级视图里管综也是单独一级，设备留在专业下`);
const okDeRank = typeof de?.fields?.[0]?.rank === 'function'
  && de.fields[0].rank('管综') > de.fields[0].rank('暖通空调');
if (!okDeRank) failed++;
console.log(`${okDeRank ? '✓' : '✗'} 两级视图的专业按业务序排（暖通在前、管综压最后）`);
const okDeKind = de?.fields?.[1]?.map?.('', {}, { name: '风机盘管 FCU-01' }) === '风机盘管'
  && de.fields[1].map('', { 'Category Name': '风管' }, { name: '送风管 SF 1' }) === '暖通空调'
  && de.fields[1].map('', { 'Category Name': '风管', 系统名称: '排烟' }, { name: '排烟风管' }) === '消防';
if (!okDeKind) failed++;
console.log(`${okDeKind ? '✓' : '✗'} 第二层：设备给设备分类、管综给专业方向（风管 → 暖通 / 排烟 → 消防）`);

// 第 3 层只挂在「管综 › 专业」下面，设备分支不多这一层
const okDeThird = de?.fields?.[2]?.label === '类别'
  && typeof de.fields[2].only === 'function'
  && de.fields[2].only({ 'Category Name': '风管' }, { name: '送风管 SF 1' }) === true
  && de.fields[2].only({ 'Category Name': '机械设备' }, { name: '风机盘管 FCU-01' }) === false
  && de.fields[2].map('', { 'Category Name': '风管' }) === '风管';
if (!okDeThird) failed++;
console.log(`${okDeThird ? '✓' : '✗'} 第三层「类别」只对管综生效（设备分支不再多一层）`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
