/**
 * smart-equip.mjs —— 「智能化设备」归类的单元测试
 *
 * 规则：构件名称里带「智能 / 智慧 / 智控 / 智联」（英文 smart / intelligent）→ 智能化设备。
 *   · 手工模型（无 BIM 信息，只有「系统名_设备名+编号」）与 BIM 模型同一口径；
 *   · 但**管线本体**不退让：智能化_电缆桥架、智能电动阀 仍是「管综」；
 *   · **建筑构件**不退让：智能防火门、智能化隔墙 仍是「建筑结构」；
 *   · 只看构件自己的名字，**不读系统名** —— 否则弱电整层（系统名常叫「智能化」）全涌进来。
 *
 * node test/smart-equip.mjs
 */
import {
  equipmentKind, resolveEquipment, isSmartEquip, isEquipment,
  kindRank, EQUIP_KINDS, CATCH_ALL,
  SMART_KIND, NON_EQUIP, OTHER_EQUIP, NON_MEP,
} from '../src/viewer/equipment.js';

let failed = 0;
let total = 0;

const check = (props, name, want, wantFrom, note) => {
  total++;
  const r = resolveEquipment(props, name);
  const ok = r.kind === want && (!wantFrom || r.from === wantFrom);
  if (!ok) failed++;
  const shown = name || props['名称'] || JSON.stringify(props);
  console.log(`${ok ? '✓' : '✗'} ${String(shown).padEnd(26)} → ${r.kind.padEnd(7)} [${r.from}]${ok ? '' : `（期望 ${want}${wantFrom ? ` / ${wantFrom}` : ''}）`}${note ? `  ${note}` : ''}`);
};

console.log('=== 一、手工模型：只有「系统名_设备名+编号」 ===');
check({}, '智能照明_筒灯001', SMART_KIND, 'smart', '系统名带智能');
check({}, '智慧园区_摄像机001', SMART_KIND, 'smart');
check({}, '智能化_网络面板01', SMART_KIND, 'smart');
check({}, '智控_机柜003', SMART_KIND, 'smart', '「智控」也算');
check({}, '智联_门禁面板001', SMART_KIND, 'smart', '「智联」也算');
check({}, '智慧_水泵001', SMART_KIND, 'smart', '设备词让位给智能化');
check({}, '智能照明_智能插座001', SMART_KIND, 'smart');
check({}, 'Smart Lighting Panel', SMART_KIND, 'smart', '英文整词');
check({}, 'Intelligent Camera 01', SMART_KIND, 'smart');

console.log('\n=== 二、手工模型里「不是设备」的智能构件 ===');
check({}, '智能照明_电缆桥架001', NON_EQUIP, 'pipe-word', '桥架是线不是机');
check({}, '智能化_桥架_002', NON_EQUIP, 'pipe-word');
check({}, '智慧_风口001', NON_EQUIP, 'pipe-word');
check({}, '智能电动阀', NON_EQUIP, 'pipe-word', '阀门属管综');
check({}, '智能支吊架', NON_EQUIP, 'pipe-word');
check({}, '智慧_喷头001', NON_EQUIP, 'pipe-word');

console.log('\n=== 三、不该被「智能」误伤的反例 ===');
check({}, '弱电_摄像机001', OTHER_EQUIP, null, '没有智能字样，不硬归智能化');
check({}, '智造中心_支架', NON_EQUIP, 'pipe-word', '单字「智」不命中');
check({}, 'Smartphone rack', OTHER_EQUIP, null, 'smart 要整词，smartphone 不算');
check({}, 'AI 摄像机001', OTHER_EQUIP, null, '「AI」不在词表（避免与字母型号撞车）');

console.log('\n=== 四、BIM 模型：读类别 / 族 / 类型，同一口径 ===');
check({ 'Category Name': '机械设备', 族: '智能配电箱' }, '', SMART_KIND, 'smart', '族里带智能');
check({ 'Category Name': '常规模型', 族: '智能照明灯具', 'Type Name': '智能筒灯 9W' }, '筒灯', SMART_KIND, 'smart');
check({ 'Category Name': '专用设备', 族: '智能安防', 'Type Name': '人脸识别一体机' }, '一体机', SMART_KIND, 'smart');
check({ 'Type Name': '智慧灯杆 8m' }, '灯杆-01', SMART_KIND, 'smart');
check({ ifc_type: 'IfcSensor' }, '智能温湿度传感器', SMART_KIND, 'smart', '智能化优先于 IFC 兜底');

console.log('\n=== 五、BIM 模型里被「管线 / 建筑」拦住的 ===');
check({ 'Category Name': '电缆桥架', 族: '智能化桥架' }, '桥架-1', NON_EQUIP, 'pipe-cat', '类别是桥架');
check({ 'Category Name': '管道附件', 族: '智能压力传感器' }, '压力传感器', NON_EQUIP, 'pipe-cat');
check({ 'Category Name': '风管', 'Type Name': '智能送风管' }, '送风管', NON_EQUIP, 'pipe-cat');
check({ 'Category Name': '墙', 族: '基本墙', 'Type Name': '智能化隔墙 150' }, '墙', NON_MEP, 'arch');
check({ 'Category Name': '门', 族: '智能防火门' }, '门-1', NON_MEP, 'arch', '门再智能也是建筑构件');
check({ 'Category Name': '门', 族: '防火门' }, '门-2', NON_MEP, 'arch');
check({ 'Category Name': '幕墙嵌板', 族: '智能调光玻璃' }, '幕墙-1', NON_MEP, 'arch', '幕墙前缀');
check({ 'Category Name': '楼板', 族: '智能化架空地板' }, '楼板-1', NON_MEP, 'arch');

console.log('\n=== 六、不读系统名（关键边界）===');
check({ 系统名称: '智能化', 族: '筒灯' }, '筒灯001', '照明灯具', 'word', '系统名不参与，落到灯具');
check({ 系统名称: '智能化', 'Category Name': '常规模型', 族: '摄像机' }, '摄像机001', OTHER_EQUIP, 'generic-cat');
check({ 系统分类: '智能化', 系统类型: '智能化-综合布线', 族: '配线架' }, '配线架01', '弱电机柜');
check({ 系统缩写: 'NW', 系统名称: '智能化' }, '冷冻水管 CHW-1', NON_EQUIP, 'pipe-word');

console.log('\n=== 七、不改变既有判定（无智能字样）===');
check({ 'Category Name': '机械设备', 族: '离心泵' }, '冷冻水泵', '水泵');
check({ 'Category Name': '机械设备', 族: '组合式空调机组' }, 'AHU-1', '空调机柜');
check({ 'Category Name': '管道附件', 族: '温度传感器3' }, '温度传感器3', NON_EQUIP, 'pipe-cat');
check({ 族: '配电柜' }, '低压配电柜', '配电柜');
check({ 'Category Name': '风管' }, '矩形风管 800×400', NON_EQUIP, 'pipe-cat');

console.log('\n=== 八、接口与排序 ===');
total++;
const rankOk = kindRank(SMART_KIND) === kindRank('弱电机柜') + 1
  && kindRank(SMART_KIND) < kindRank('照明灯具')
  && kindRank(SMART_KIND) < kindRank(OTHER_EQUIP);
if (!rankOk) failed++;
console.log(`${rankOk ? '✓' : '✗'} 排序：弱电机柜 → 智能化设备 → 照明灯具 → 兜底桶`);

total++;
const isEqOk = isEquipment({}, '智能照明_筒灯001') === true && isSmartEquip({}, '智慧_水泵001') === true;
if (!isEqOk) failed++;
console.log(`${isEqOk ? '✓' : '✗'} isEquipment / isSmartEquip 认可智能化设备`);

total++;
const catchOk = !CATCH_ALL.has(SMART_KIND) && CATCH_ALL.has(NON_EQUIP) && CATCH_ALL.has(NON_MEP);
if (!catchOk) failed++;
console.log(`${catchOk ? '✓' : '✗'} 智能化设备是「真设备」，不在兜底桶里`);

total++;
const kindListed = EQUIP_KINDS.every((k) => k.name !== SMART_KIND);
if (!kindListed) failed++;
console.log(`${kindListed ? '✓' : '✗'} 智能化设备不占设备词表名额（由 SMART_WORDS 单独判）`);

total++;
const consistent = [...EQUIP_KINDS.map((k) => k.name), SMART_KIND].every((name) => {
  const r = resolveEquipment({}, name);
  return equipmentKind({}, name) === r.kind;
});
if (!consistent) failed++;
console.log(`${consistent ? '✓' : '✗'} equipmentKind 与 resolveEquipment 结论一致`);

console.log(`\n共 ${total} 项，${failed ? `${failed} 项失败` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
