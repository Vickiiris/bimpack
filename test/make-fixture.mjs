/**
 * make-fixture.mjs —— 生成一个极小的测试 GLB，用来验证流水线而不必拿几百 MB 的模型
 *
 *   node test/make-fixture.mjs [输出路径]
 *
 * 故意做成"不合格的源文件"，把三个坑都踩一遍：
 *   1. asset.version = "2.1"（3ds Max 的写法，非法值）
 *   2. 几何未压缩（走首次压缩路径，而不是二次编码）
 *   3. 两个节点共用一个 mesh（考验变换比对 + 共享几何）
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeGLB } from '../src/glb.mjs';

const out = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'fixture.glb');

// 一个 2×1×1 的长方体：8 顶点、12 三角面，无 normals/uv（考验下游补齐能力）
const P = [
  [-1, -0.5, -0.5], [1, -0.5, -0.5], [1, 0.5, -0.5], [-1, 0.5, -0.5],
  [-1, -0.5, 0.5], [1, -0.5, 0.5], [1, 0.5, 0.5], [-1, 0.5, 0.5],
];
const F = [
  [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
  [0, 4, 5], [0, 5, 1], [3, 2, 6], [3, 6, 7],
  [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2],
];

const posBuf = Buffer.alloc(P.length * 3 * 4);
P.forEach((v, i) => v.forEach((c, j) => posBuf.writeFloatLE(c, (i * 3 + j) * 4)));
const idxBuf = Buffer.alloc(F.length * 3 * 2);
F.flat().forEach((n, i) => idxBuf.writeUInt16LE(n, i * 2));
const bin = Buffer.concat([posBuf, idxBuf]);

const json = {
  asset: { version: '2.1', generator: 'bimpack test fixture' },
  scene: 0,
  scenes: [{ nodes: [0, 1] }],
  nodes: [
    {
      name: '测试构件 A',
      mesh: 0,
      translation: [0, 0, 0],
      extras: { id: 'A-001', 'Category Name': '风管', 'Type Name': '矩形风管', 宽度: '400 mm', IfcGUID: '0AAA' },
    },
    {
      name: '测试构件 B',
      mesh: 0,
      translation: [4, 0, 0],
      rotation: [0, 0.2588190451, 0, 0.9659258263], // 绕 Y 轴 30°
      scale: [1, 1, 2.5], // 非均匀缩放，考验 TRS ↔ matrix 等价判定
      extras: { id: 'A-002', 'Category Name': '风管', 'Type Name': '矩形风管', 宽度: '600 mm', IfcGUID: '0BBB' },
    },
  ],
  meshes: [
    {
      name: 'cube',
      primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }],
    },
  ],
  materials: [
    { name: 'Grey', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0 } },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: P.length, type: 'VEC3', min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5] },
    { bufferView: 1, componentType: 5123, count: F.length * 3, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length, byteLength: idxBuf.length, target: 34963 },
  ],
  buffers: [{ byteLength: bin.length }],
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, writeGLB(json, bin));
console.log(`已生成 ${out}  ${fs.statSync(out).size} B  (version=${json.asset.version}, 2 节点共用 1 mesh)`);
