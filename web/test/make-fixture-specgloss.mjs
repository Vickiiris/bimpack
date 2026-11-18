/**
 * make-fixture-specgloss.mjs —— 造「旧版高光-光泽度材质」测试样（fixture-specgloss.glb）
 *
 * KHR_materials_pbrSpecularGlossiness 在 three r157 之后被移除支持：模型带这个扩展时，
 * GLTFLoader 拿不到 baseColor / 金属度，会退回「白 + metalness 1」的默认材质 →
 * 屏幕上发黑或惨白。meta 校验见 test/spec-gloss.mjs。
 *
 * node test/make-fixture-specgloss.mjs
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRMaterialsPBRSpecularGlossiness } from '@gltf-transform/extensions';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const doc = new Document();
const buf = doc.createBuffer();
const scene = doc.createScene('S');

// 声明并要求该扩展存在（真实文件里通常是 required）
const ext = doc.createExtension(KHRMaterialsPBRSpecularGlossiness).setRequired(true);
const sg = ext.createPBRSpecularGlossiness()
  .setDiffuseFactor([0.8, 0.15, 0.12, 1])
  .setGlossinessFactor(0.35)
  .setSpecularFactor([0.25, 0.25, 0.25]);

const mat = doc.createMaterial('LegacyRed').setExtension('KHR_materials_pbrSpecularGlossiness', sg);

const pos = new Float32Array([-5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0]);
const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const prim = doc.createPrimitive()
  .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf))
  .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buf))
  .setIndices(doc.createAccessor().setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3])).setBuffer(buf))
  .setMaterial(mat);
const mesh = doc.createMesh('legacy').addPrimitive(prim);
scene.addChild(doc.createNode('legacy').setMesh(mesh));

const out = path.join(HERE, 'fixture-specgloss.glb');
writeFileSync(out, Buffer.from(await new NodeIO().registerExtensions([KHRMaterialsPBRSpecularGlossiness]).writeBinary(doc)));
console.log('written', out);
