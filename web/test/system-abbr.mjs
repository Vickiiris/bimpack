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
eq('', '(未分类)', '空值');
eq('   ', '(未分类)', '纯空白');
eq('5', '(未分类)', '纯数字');
eq('12 34', '(未分类)', '纯数字带空格');
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
k({}, '(未分类)', '两个字段都没有');

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
const sysType = GROUP_MODES.systemType;
const m1 = sys?.fields?.[0]?.map;
const m2 = sysType?.fields?.[0]?.map;
const okMode = typeof m1 === 'function' && typeof m2 === 'function'
  && m1('EAD 5', { 系统缩写: 'EAD', 系统名称: 'EAD 5' }) === 'EAD'
  && m2('CN 7', { 系统名称: 'CN 7' }) === 'CN';
if (!okMode) failed++;
console.log(`${okMode ? '✓' : '✗'} 「系统 → 类别」与「系统 → 类别 → 类型」两档都用系统缩写归一`);
const okDepth = sys?.fields?.length === 2 && sysType?.fields?.length === 3;
if (!okDepth) failed++;
console.log(`${okDepth ? '✓' : '✗'} 两级 / 三级分组深度正确`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
