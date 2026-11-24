/**
 * equipment.mjs —— 「设备类型」判定的单元测试
 *
 * 目标：机电模型里把机房设备 / 末端设备按类型捞出来，管道风管桥架归「管综」，
 * 而且不能靠单个模型的叫法 —— 各院/各软件（Revit、鸿业、天正、Magicad）命名差异很大。
 *
 * 覆盖：14 类设备的常见写法、管综（管道/风管/桥架/支吊架）、IFC 实体兜底、
 *       建筑结构一票否决（电梯井道墙不能被「电梯」拉走）、取消末端设备后的去向、
 *       以及「不能按系统名判设备」这条红线。
 *
 * node test/equipment.mjs
 */
import { equipmentKind, isEquipment, kindRank, EQUIP_KINDS, NON_EQUIP, OTHER_EQUIP, NON_MEP } from '../src/viewer/equipment.js';

let failed = 0;
const eq = (props, name, want, note) => {
  const got = equipmentKind(props, name);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${(name || props['名称'] || JSON.stringify(props)).padEnd(26)} → ${got}${ok ? '' : `（期望 ${want}）`}${note ? `  ${note}` : ''}`);
};

console.log('--- 配电柜 ---');
eq({ 'Category Name': '机械设备', 族: '配电柜', 'Type Name': '低压配电柜 GCS' }, '配电柜', '配电柜');
eq({ 族: '配电箱', 'Type Name': '照明配电箱' }, '配电箱AL-1', '配电柜');
eq({ 族: '开关柜' }, '高压开关柜', '配电柜');
eq({ 族: '箱式变电站' }, '箱变', '配电柜');
eq({ 族: '变压器' }, '干式变压器', '配电柜');
eq({ 'Type Name': 'UPS 不间断电源 20kVA' }, 'UPS-1', '配电柜');
eq({ 族: '控制柜' }, '消防控制柜', '配电柜');

console.log('\n--- 水箱 ---');
eq({ 族: '生活水箱' }, '生活水箱 30m³', '水箱');
eq({ 族: '膨胀水箱' }, '膨胀水箱', '水箱');
eq({ 'Type Name': '气压罐 Φ800' }, '气压罐', '水箱');
eq({ 族: '消防水池' }, '消防水池', '水箱');

console.log('\n--- 空调机柜 / 新风机组 / 风机盘管 ---');
eq({ 族: '组合式空调机组' }, '空调机组 AHU-1', '空调机柜');
eq({ 'Type Name': '空调机柜 6000m³/h' }, '空调机柜', '空调机柜');
eq({ 'Type Name': 'AHU-3' }, 'AHU-3', '空调机柜');
eq({ 族: '恒温恒湿机组' }, '恒温恒湿机组', '空调机柜');
eq({ 族: '新风机组' }, '新风机组 XF-1', '新风机组');
eq({ 'Type Name': '新风处理机组' }, '新风处理机组', '新风机组');
eq({ 'Type Name': '新风机 2000m³/h' }, '新风机', '新风机组');
eq({ 族: '风机盘管' }, '风机盘管 FCU-01', '风机盘管');
eq({ 'Type Name': 'FCU-12' }, 'FCU-12', '风机盘管');

console.log('\n--- 冷热源 ---');
eq({ 族: '离心式冷水机组' }, '冷水机组', '冷水机组');
eq({ 'Type Name': '多联机 VRV' }, '多联机', '冷水机组');
eq({ 族: '冷却塔' }, '方形横流冷却塔', '冷却塔');
eq({ 族: '燃气锅炉' }, '燃气锅炉 2t/h', '锅炉');
eq({ 族: '板式换热器' }, '板式换热器 1700kW', '换热器');
eq({ 族: '分集水器' }, '分集水器 DN300', '换热器');

console.log('\n--- 水泵 / 水处理 ---');
eq({ 族: '冷冻水泵' }, '冷冻水泵', '水泵');
eq({ 'Type Name': '潜污泵 50WQ' }, '潜污泵', '水泵');
eq({ 族: '消防泵' }, '消防泵 XBD', '水泵');
eq({ 族: '软化水装置' }, '全自动软化水装置', '水处理设备');
eq({ 族: '加药装置' }, '加药装置', '水处理设备');

console.log('\n--- 弱电 ---');
eq({ 族: '网络机柜' }, '网络机柜', '弱电机柜');
eq({ 族: '弱电箱' }, '弱电箱', '弱电机柜');

console.log('\n--- 原「末端设备」取消后：按自身类别归，不再单列 ---');
eq({ 'Category Name': '管道附件', 族: '压力传感器' }, '压力传感器', NON_EQUIP, '装在管上的仪表 → 管综');
eq({ 'Category Name': '管道附件', 族: '温度传感器3' }, '温度传感器3', NON_EQUIP);
eq({ 'Category Name': '电缆桥架', 'Type Name': 'CT-广播线槽' }, '带配件的电缆桥架', NON_EQUIP, '「广播」是系统名，本体还是线槽');
eq({ 族: '摄像机' }, '球型摄像机', OTHER_EQUIP, '认不出型号的末端件进「其他设备」');
eq({ 'Type Name': '温控器' }, '温控器', OTHER_EQUIP);
eq({ 族: '筒灯' }, '筒灯 9W', '照明灯具', '灯具是具体类型，不进「其他设备」');
eq({}, 'Light083', '照明灯具', '只有英文名的灯具');

console.log('\n--- 电梯：门/井道属建筑，轿厢/曳引属设备 ---');
eq({ 族: '曳引电梯', 'Category Name': '机械设备', 'Type Name': '曳引式 1000kg' }, '客梯 DT-1', '电梯设备');
eq({ 'Category Name': '专用设备', 族: '电梯门', 'Type Name': '1300mm_入口宽度' }, '电梯门 1300mm_入口宽度', NON_MEP, '门属建筑，不并进电梯设备');

console.log('\n--- 管综（不能当设备）---');
eq({ 'Category Name': '风管' }, '送风管 800×400', NON_EQUIP);
eq({ 'Category Name': '管道', 'Type Name': '无缝钢管 DN100' }, '冷冻水管', NON_EQUIP);
eq({ 'Category Name': '电缆桥架' }, '强电桥架 200×100', NON_EQUIP);
eq({ 'Category Name': '管道' }, '线管 JDG20', NON_EQUIP);
eq({ 族: '电动蝶阀' }, '电动蝶阀 DN150', NON_EQUIP);
eq({ 族: '风口' }, '散流器 400×400', NON_EQUIP);
eq({ 族: '管道支吊架' }, '支吊架', NON_EQUIP);
eq({ 族: '弯头' }, '90°弯头 DN100', NON_EQUIP);

console.log('\n--- 属性陷阱：系统名不能决定是不是设备 ---');
eq({ 系统分类: '冷冻水', 系统名称: 'CHW 1', 'Category Name': '管道' }, '弯头 DN100', NON_EQUIP, '在冷冻水系统里也还是管子');
eq({ 系统分类: '配电', 系统名称: 'AL 1', 'Category Name': '电缆桥架' }, '桥架', NON_EQUIP);

console.log('\n--- IFC 实体兜底（中文名认不出时）---');
eq({ 'ifc_type': 'IfcPump', 'Category Name': '机械设备' }, 'P-01', '水泵');
eq({ 'Ifc Entity': 'IfcTank' }, 'T-01', '水箱');
eq({ 'ifc_type': 'IfcChiller' }, 'CH-01', '冷水机组');
eq({ 'ifc_type': 'IfcDuctSegment' }, 'D-01', NON_EQUIP);
eq({ 'ifc_type': 'IfcCableCarrierSegment' }, 'CT-01', NON_EQUIP);

console.log('\n--- 建筑结构：一票否决，不许并入任何设备类型 ---');
eq({ 'Category Name': '墙', 族: '基本墙', 'Type Name': '电梯井道轻质隔墙_ 150' }, '基本墙 电梯井道轻质隔墙_ 150', NON_MEP, '名字带「电梯」但它是墙');
eq({ 'Category Name': '墙', 族: '基本墙', 'Type Name': '电梯井道轻质隔墙_ 200' }, '基本墙 电梯井道轻质隔墙_ 200', NON_MEP);
eq({ 'Category Name': '结构框架', 族: '混凝土-矩形梁(无边)_电梯大堂&电梯大堂', 'Type Name': '1000 x 1500' }, '混凝土梁', NON_MEP, '带「电梯大堂」但不能算电梯设备');
eq({ 'Category Name': '墙', 族: '基本墙' }, '基本墙 1', NON_MEP);
eq({ 'Category Name': '结构柱' }, '框架柱 KZ1', NON_MEP);

console.log('\n--- 其他设备（认不出型号）---');
eq({ 'Category Name': '机械设备', 族: '自定义族', 'Type Name': '甲型' }, '某某设备', OTHER_EQUIP);


console.log('\n--- 真实模型里踩到的写法 ---');
eq({ 'Category Name': '机械设备', 族: '风机', 'Type Name': '700' }, '风机 700', '风机');
eq({ 'Category Name': '机械设备', 族: '离心风机箱 电机外置', 'Type Name': '离心风机箱 左右' }, '离心风机箱', '风机');
eq({ 'Category Name': '常规模型', 族: '新风热回收机组', 'Type Name': '新风热回收机组' }, '新风热回收机组', '新风机组');
eq({ 'Category Name': '机械设备', 族: 'PM-管卡', 'Type Name': 'PM-管卡' }, 'PM-管卡', NON_EQUIP, '支吊架');
eq({ 'Category Name': '机械设备', 族: 'PM-木托（圆管卡）', 'Type Name': 'PM-木托（圆管卡）' }, 'PM-木托', NON_EQUIP);
eq({ 'Category Name': '机械设备', 族: '定压补水装置(1)', 'Type Name': '定压补水装置' }, '定压补水装置', '水处理设备');

console.log('\n--- 排序与 `isEquipment` ---');
const rankOk = kindRank('冷水机组') < kindRank('配电柜')
  && kindRank('配电柜') < kindRank(OTHER_EQUIP)
  && kindRank(OTHER_EQUIP) < kindRank(NON_EQUIP)
  && kindRank(NON_EQUIP) < kindRank(NON_MEP);
if (!rankOk) failed++;
console.log(`${rankOk ? '✓' : '✗'} 排序：冷热源 → 水电 → 其他设备 → 管综 → 建筑结构（大桶沉底）`);
const isEqOk = isEquipment({ 族: '配电柜' }, '配电柜') === true
  && isEquipment({ 'Category Name': '风管' }, '风管') === false;
if (!isEqOk) failed++;
console.log(`${isEqOk ? '✓' : '✗'} isEquipment 能区分设备与管综`);
const kindsOk = EQUIP_KINDS.every((k) => k.name && k.words.every((w) => w.length >= 2));
if (!kindsOk) failed++;
console.log(`${kindsOk ? '✓' : '✗'} 设备词表只收多字词（避免单字误伤）`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
