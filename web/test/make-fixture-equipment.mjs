/**
 * make-fixture-equipment.mjs —— 造「设备分类」测试样（fixture-equipment.glb）
 *
 * 覆盖设备视图必须分清的几类：
 *   - 机房/末端设备：配电柜 ×2、水箱、空调机柜、新风机组、风机盘管、水泵
 *   - 管综：送风管、冷冻水管、电缆桥架（3 件，必须在同一组且排到最后）
 *   - 泛设备：类别写着机械设备但认不出型号 → 「其他设备」
 *   - 建筑结构：基本墙、电梯井道隔墙 → 「建筑结构」（名字带「电梯」也不能并入设备）；
     名字带「防火」的 3H 防火板墙 → 「建筑」（专业层一票否决，不进消防）
 *   - 管道附件上的压力传感器 → 「管综」，不再单列「末端设备」
 *   - 手工模型（完全没有 extras）：智能照明_筒灯001 → 电气 ›「智能照明」；
 *     智慧安防_摄像头001 → 安防 ›「智慧安防」（两级视图里智能化设备按系统名分组）；
 *     智能化_电缆桥架001 → 「管综」（名字带智能，但本体是线）
 *
 * 共 18 个构件，用来断言「按设备分类归类 + 一个都不丢」。
 *
 * node test/make-fixture-equipment.mjs
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const doc = new Document();
const buf = doc.createBuffer();
const scene = doc.createScene('S');
const mat = doc.createMaterial('Grey')
  .setBaseColorFactor([0.6, 0.6, 0.6, 1])
  .setMetallicFactor(0)
  .setRoughnessFactor(0.6);

// 每条 = 一个构件：name 决定设备类型，cat/fam/type 模拟 Revit → glTF 的 extras
const cases = [
  // 电气 —— 配电柜
  { name: '低压配电柜 GCS-1', cat: '机械设备', fam: '配电柜', type: '低压配电柜 GCS', sys: 'AL 1', abbr: 'AL', sysCat: '强电', x: 0 },
  { name: '照明配电箱 AL-1', cat: '机械设备', fam: '配电箱', type: '照明配电箱 PZ30', sys: 'AL 2', abbr: 'AL', sysCat: '强电', x: 2 },
  // 给排水 —— 水箱 / 水泵
  { name: '生活水箱 30m³', cat: '机械设备', fam: '生活水箱', type: '不锈钢水箱', sys: 'J 1', abbr: 'J', sysCat: '给水', x: 4 },
  { name: '冷冻水泵', cat: '机械设备', fam: '离心泵', type: '冷冻水泵 200m³/h', sys: 'CHWP 1', abbr: 'CHWP', sysCat: '冷冻水', x: 6 },
  // 暖通 —— 空调机柜 / 新风机组 / 风机盘管
  { name: '组合式空调机组 AHU-1', cat: '机械设备', fam: '空调机组', type: '组合式空调机组 6000m³/h', sys: 'KT 1', abbr: 'KT', sysCat: '空调', x: 8 },
  { name: '新风机组 XF-1', cat: '机械设备', fam: '新风机组', type: '新风机组 2000m³/h', sys: 'XF 1', abbr: 'XF', sysCat: '新风', x: 10 },
  { name: '风机盘管 FCU-01', cat: '机械设备', fam: '风机盘管', type: '风机盘管 FP-34', sys: 'KT 1', abbr: 'KT', sysCat: '空调', x: 12 },
  // 管综 —— 管道 / 风管 / 桥架（都不该进设备组）
  { name: '送风管 SF 1', cat: '风管', fam: '矩形风管', type: '镀锌铁皮 800×400', sys: 'SF 1', abbr: 'SF', sysCat: '送风', x: 14 },
  { name: '冷冻水管 CHW 1', cat: '管道', fam: '管道', type: '无缝钢管 DN100', sys: 'CHW 1', abbr: 'CHW', sysCat: '冷冻水', x: 16 },
  { name: '强电桥架 AL 1', cat: '电缆桥架', fam: '槽式桥架', type: '槽式桥架 200×100', sys: 'AL 1', abbr: 'AL', sysCat: '强电', x: 18 },
  // 泛设备 —— 认不出型号
  { name: '某某设备', cat: '机械设备', fam: '自定义族', type: '甲型', sys: 'AL 1', abbr: 'AL', sysCat: '强电', x: 20 },
  // 建筑结构：名字里带「电梯」，但它是墙 —— 不许被拉进电梯设备
  { name: '基本墙 电梯井道轻质隔墙_150', cat: '墙', fam: '基本墙', type: '电梯井道轻质隔墙_ 150', x: 22 },
  { name: '基本墙 1', cat: '墙', fam: '基本墙', type: '200mm 砌体', x: 24 },
  // 原「末端设备」：管道附件上的仪表，按类别归管综
  { name: '压力传感器', cat: '管道附件', fam: '压力传感器', type: '标准', x: 26 },
  // 手工添加的非 BIM 模型：只有名字，靠「名称里带智能」归到智能化设备
  { name: '智能照明_筒灯001', bare: true, x: 28 },
  // 同样只有名字，但本体是桥架 —— 带「智能」也仍归管综
  { name: '智能化_电缆桥架001', bare: true, x: 30 },
  // 安防专业的手工件：智能化设备要按系统名（智慧安防）分组，不是笼统一个「智能化设备」
  { name: '智慧安防_摄像头001', bare: true, x: 32 },
  // 名字带「防火」，但类别是墙 —— 建筑构件一票否决，不许进消防专业
  { name: '基本墙 3H防火板墙_150', cat: '墙', fam: '基本墙', type: '3H防火板墙_ 150', x: 34 },
];

for (const c of cases) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 1, 2, 0, 2, 3])).setBuffer(buf))
    .setMaterial(mat);
  const mesh = doc.createMesh(c.name).addPrimitive(prim);
  const extras = { 'Category Name': c.cat, 'Type Name': c.type, '族': c.fam };
  if (c.sys) extras['系统名称'] = c.sys;
  if (c.abbr) extras['系统缩写'] = c.abbr;
  if (c.sysCat) extras['系统分类'] = c.sysCat;
  const node = doc.createNode(c.name).setMesh(mesh).setTranslation([c.x, 0, 0]);
  if (!c.bare) node.setExtras(extras);   // 手工模型：一点 BIM 信息都没有
  scene.addChild(node);
}

const out = path.join(HERE, 'fixture-equipment.glb');
writeFileSync(out, Buffer.from(await new NodeIO().writeBinary(doc)));
console.log('written', out, 'components:', cases.length);
