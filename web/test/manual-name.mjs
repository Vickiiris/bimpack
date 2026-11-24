/**
 * manual-name.mjs —— 「系统名_设备名+编号」手工命名规则
 *
 * 背景：用户手工补进场景的非 BIM 模型没有 extras，属性判定只能落到「其他分类」。
 * 这条规则让它们按名字自动归位：系统名定专业，编号不参与判定。
 *
 * node test/manual-name.mjs
 */
import { parseManualName, manualSystemName, normalizeName, MANUAL_REASONS } from '../src/viewer/manual-name.js';
import { disciplineCode, resolveDiscipline, classifyLeaves, disciplineName, DISCIPLINES } from '../src/viewer/discipline.js';
import { systemKeyOf, UNKNOWN_LABEL } from '../src/viewer/system-key.js';

let failed = 0;
const t = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
};

console.log('--- 改名：兜底桶叫「其他分类」 ---');
t(UNKNOWN_LABEL === '其他分类', `UNKNOWN_LABEL = ${UNKNOWN_LABEL}`);
t(DISCIPLINES.NONE.name === '其他分类', `DISCIPLINES.NONE.name = ${DISCIPLINES.NONE.name}`);
t(disciplineName('NONE') === '其他分类', 'disciplineName("NONE") 同步');

console.log('\n--- 解析：正常格式 ---');
const p = (raw, want, msg) => {
  const r = parseManualName(raw);
  const got = r.ok ? `${r.system}|${r.device}|${r.serial}` : `✗${r.reason}`;
  t(got === want, `${msg}：${JSON.stringify(raw)} → ${got}`);
};
p('智能照明_筒灯001', '智能照明|筒灯|001', '标准形式');
p('消防_喷淋头012', '消防|喷淋头|012', '编号多位');
p('给排水_地漏3', '给排水|地漏|3', '编号一位');
p('暖通_风机盘管 001', '暖通|风机盘管|001', '编号前有空格');
p('暖通_风机盘管-001', '暖通|风机盘管|001', '编号前有横线');
p('暖通_风机盘管#001', '暖通|风机盘管|001', '编号前有井号');
p('智能照明_筒灯', '智能照明|筒灯|', '缺编号也认（编号可缺）');
p('智能照明＿筒灯001', '智能照明|筒灯|001', '全角下划线');
p('智能照明__筒灯001', '智能照明|筒灯|001', '连续下划线当一个分隔符');
p('智能照明1_筒灯001', '智能照明|筒灯|001', '系统名自带编号，编号不进系统名');
p('EAD_排风管_003', 'EAD|排风管|003', '系统名是缩写，设备名可含下划线');
p('智能照明_筒灯001 ', '智能照明|筒灯|001', '首尾空白');

console.log('\n--- 解析：格式不规则（留在其他分类，并给出原因）---');
const bad = (raw, reason, msg) => {
  const r = parseManualName(raw);
  t(!r.ok && r.reason === reason, `${msg}：${JSON.stringify(raw)} → ${r.reason}（${MANUAL_REASONS[r.reason]}）`);
};
bad('筒灯001', 'no-sep', '没有分隔符');
bad('智能照明筒灯001', 'no-sep', '全中文没分隔符');
bad('_筒灯001', 'no-system', '分隔符前为空');
bad('123_筒灯001', 'bad-system', '系统名只有数字');
bad('A_筒灯001', 'bad-system', '系统名单字母');
bad('智能照明_', 'no-device', '分隔符后为空');
bad('智能照明_001', 'no-device', '设备名只有编号');
bad('', 'empty', '空名称');
bad('   ', 'empty', '纯空白');

console.log('\n--- 解析结果只取系统名 ---');
t(manualSystemName('消防_喷淋头001') === '消防', 'manualSystemName 取系统名');
t(manualSystemName('筒灯001') === '', '不合规则时为空串');
t(normalizeName(' 智能照明 ＿ 筒灯001 ') === '智能照明 _ 筒灯001', '归一化保留内部空格，全角转半角');

console.log('\n--- 归类：系统名 → 专业 ---');
const c = (name, want, msg, props = {}) => {
  const got = disciplineCode(props, { name });
  t(got === want, `${msg}：${JSON.stringify(name)} → ${got}${got === want ? '' : `（期望 ${want}）`}`);
};
c('智能照明_筒灯001', 'ELEC', '智能照明 → 电气');
c('消防_喷淋头001', 'FIRE', '消防 → 消防');
c('给排水_地漏03', 'PLUMB', '给排水 → 给排水');
c('暖通_风机盘管001', 'HVAC', '暖通 → 暖通空调');
c('智能化_网络面板001', 'ELV', '智能化 → 安防（ELV）');
c('燃气_燃气表001', 'GAS', '燃气 → 燃气');
c('EAD_排风管_003', 'HVAC', '缩写系统名靠设备名兜底 → 暖通');

console.log('\n--- 归类：优先级与边界 ---');
c('消防_应急照明灯具001', 'FIRE', '系统名是消防 → 消防优先，不因设备是灯具归电气');
c('智能照明_筒灯001', 'FIRE', '属性里写明消防时属性优先（名字不能盖掉模型自带口径）', { 系统名称: '消防' });
const unk = resolveDiscipline({}, { name: '构件甲_未知设备001' });
t(unk.code === 'NONE' && unk.from === 'none' && unk.detail.includes('认不出'),
  `系统名认不出 → 其他分类（${unk.code}/${unk.detail}）`);
const noSep = resolveDiscipline({}, { name: '筒灯001' });
t(noSep.code === 'NONE' && noSep.detail === '没有「_」分隔符',
  `没有分隔符 → 其他分类（${noSep.detail}）`);
const fromManual = resolveDiscipline({}, { name: '智能照明_筒灯001' });
t(fromManual.from === 'manual', `判定来源标为 manual（${fromManual.from}）`);

console.log('\n--- 系统层：手工模型的系统名 ---');
t(systemKeyOf({}, '智能照明_筒灯001') === '智能照明', '无属性时用名字里的系统名');
t(systemKeyOf({ 系统名称: 'CHW 5' }, '智能照明_筒灯001') === 'CHW', '有属性时属性优先');
t(systemKeyOf({}, '筒灯001') === UNKNOWN_LABEL, '规则不合 → 其他分类');

console.log('\n--- 整批：命名规则先于「同类别多数」---');
{
  // 3 条同类别都是给排水，但第 4 条名字写明「智能照明」→ 按名字走，不被多数拉走
  const ls = [
    { name: '管件 1', props: { 'Category Name': '管件', 系统名称: '生活给水 1' } },
    { name: '管件 2', props: { 'Category Name': '管件', 系统名称: '生活给水 2' } },
    { name: '管件 3', props: { 'Category Name': '管件', 系统名称: '生活给水 3' } },
    { name: '智能照明_筒灯001', props: { 'Category Name': '管件' } },
  ];
  const r = classifyLeaves(ls);
  const got = r.get(ls[3]);
  t(got.code === 'ELEC' && got.from === 'manual', `命名规则优先于同类别多数（${got.code}/${got.from}）`);
}
{
  // 纯手工批次（无任何属性）：各自按名字分开，不再全挤在「其他分类」
  const ls = [
    { name: '智能照明_筒灯001', props: {} },
    { name: '智能照明_筒灯002', props: {} },
    { name: '消防_喷淋头001', props: {} },
    { name: '筒灯003', props: {} },
  ];
  const r = classifyLeaves(ls);
  const codes = ls.map((l) => r.get(l).code);
  t(codes.join(',') === 'ELEC,ELEC,FIRE,NONE', `手工批次各自归位：${codes.join(',')}`);
  t(r.get(ls[3]).detail === '没有「_」分隔符', `不合规的那条给出原因：${r.get(ls[3]).detail}`);
}

console.log(failed ? `\n${failed} 条失败` : '\n全部通过');
if (failed) process.exit(1);
