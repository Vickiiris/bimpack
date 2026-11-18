/**
 * make-fixture-metal.mjs —— 造「纯金属 PBR 材质」测试样（fixture-metal.glb）
 *
 * 为什么单独造这个样：PBR 的金属材质（metalness=1）几乎没有漫反射，
 * 完全靠**环境反射**呈现颜色。场景里只有平行光、没有 IBL 环境贴图时，
 * 它在屏幕上就是纯黑 —— 用户上传 PBR 模型「全黑」十有八九是这一条。
 * 这个样件把该情形固定下来，供 pbr-metal.mjs 回归。
 *
 * node test/make-fixture-metal.mjs
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const doc = new Document();
const buf = doc.createBuffer();
const scene = doc.createScene('S');

// 抛光金属：metalness 1 / roughness 0.15，无贴图
const metal = doc.createMaterial('PolishedMetal')
  .setBaseColorFactor([0.9, 0.9, 0.92, 1])
  .setMetallicFactor(1)
  .setRoughnessFactor(0.15);

// 粗糙电介质：作为对照，金属修复不应把普通材质一起洗白
const plaster = doc.createMaterial('Plaster')
  .setBaseColorFactor([0.55, 0.58, 0.62, 1])
  .setMetallicFactor(0)
  .setRoughnessFactor(0.85);

function addBox(mat, x) {
  const pos = new Float32Array([
    -5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0,
  ]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR')
      .setArray(new Uint16Array([0, 1, 2, 0, 2, 3])).setBuffer(buf))
    .setMaterial(mat);
  const mesh = doc.createMesh(mat.getName()).addPrimitive(prim);
  const node = doc.createNode(mat.getName()).setMesh(mesh).setTranslation([x, 0, 0]);
  scene.addChild(node);
}

addBox(metal, -7);
addBox(plaster, 7);

const out = path.join(HERE, 'fixture-metal.glb');
writeFileSync(out, Buffer.from(await new NodeIO().writeBinary(doc)));
console.log('written', out);
