/**
 * make-fixture-unified.mjs —— 造「规范层级」测试样（fixture-unified.glb）
 *
 * 覆盖合并时必须处理的几类情况：
 *   - 跨专业同类别：排烟风管（消防）与送风管（暖通）的 Category 都是「风管」
 *   - 消防优先：排烟风管在设备上属暖通，按规范必须归消防
 *   - 缩写在表里 / 不在表里：CHW 查表得暖通；弱电靠「系统分类」关键词
 *   - 无系统字段的建筑构件：墙只能靠类别/族判定
 *
 * node test/make-fixture-unified.mjs
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

// 每条 = 一个构件；extras 就是 BIM 属性
const cases = [
  // 消防：排烟风管（设备是风管，系统是消防 —— 冲突样本）
  { name: '排烟风管 PY 5', sys: 'PY 5', abbr: 'PY', sysType: 'PY-排烟风管', sysCat: '排烟', cat: '风管', type: '镀锌铁皮', x: 0 },
  { name: '排烟风管 PY 6', sys: 'PY 6', abbr: 'PY', sysType: 'PY-排烟风管', sysCat: '排烟', cat: '风管', type: '镀锌铁皮', x: 2 },
  // 暖通：送风管（同类别、不同系统）
  { name: '送风管 SF 1', sys: 'SF 1', abbr: 'SF', sysType: 'SF-送风管', sysCat: '送风', cat: '风管', type: '镀锌铁皮', x: 4 },
  // 暖通：冷冻水（靠缩写查表）
  { name: '冷冻水管 CHW 2', sys: 'CHW 2', abbr: 'CHW', cat: '管道', type: '无缝钢管', x: 6 },
  // 消防：喷淋 / 消火栓（管道类别，但系统口径是消防）
  { name: '喷淋管道 SP 1', sys: 'SP 1', abbr: 'SP', sysCat: '喷淋', cat: '管道', type: '镀锌钢管', x: 8 },
  { name: '消火栓管道 XH 1', sys: 'XH 1', abbr: 'XH', sysCat: '消防', cat: '管道', type: '焊接钢管', x: 10 },
  // 电气 / 智能化：同类别（电缆桥架），不同专业
  { name: '强电桥架 AL 1', sys: 'AL 1', abbr: 'AL', sysCat: '强电', cat: '电缆桥架', type: '槽式桥架', x: 12 },
  { name: '弱电桥架 1', sys: '弱电 1', sysCat: '弱电', cat: '电缆桥架', type: '槽式桥架', x: 14 },
  // 建筑：无任何系统字段
  { name: '基本墙 1', cat: '墙', fam: '基本墙', type: '200mm 砌体', x: 16 },
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
  const extras = { 'Category Name': c.cat, 'Type Name': c.type };
  if (c.sys) extras['系统名称'] = c.sys;
  if (c.abbr) extras['系统缩写'] = c.abbr;
  if (c.sysType) extras['系统类型'] = c.sysType;
  if (c.sysCat) extras['系统分类'] = c.sysCat;
  if (c.fam) extras['族'] = c.fam;
  const node = doc.createNode(c.name).setMesh(mesh).setTranslation([c.x, 0, 0]).setExtras(extras);
  scene.addChild(node);
}

const out = path.join(HERE, 'fixture-unified.glb');
writeFileSync(out, Buffer.from(await new NodeIO().writeBinary(doc)));
console.log('written', out, 'components:', cases.length);
