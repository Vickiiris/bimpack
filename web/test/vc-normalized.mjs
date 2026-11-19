/**
 * vc-normalized.mjs —— normalized 顶点属性只能反归一化一次
 *
 * 复现背景：水厂模型整体发黑。根因在 bim-batch 的 flattenAttribute()：
 * `getComponent()` 从 three r152 起自带 denormalize()，外面又除了一次分母，
 * 等于压了两次 —— Uint8 的白色顶点色 255 → 1.0 → 1/255 ≈ 0.004，乘到底色上全黑；
 * 同理 KHR_mesh_quantization 的 Int16 坐标会被再缩 32767 倍（模型塌成一点）。
 *
 * 覆盖：
 *   1. normalized Uint8 COLOR_0 = 255 → 批处理后仍是 1.0（不是 1/255）
 *   2. normalized Int16 POSITION（量化坐标）→ 世界包围盒不变
 *   3. normalized 交错缓冲（meshopt 式）：颜色 + UV 都要只归一化一次
 *   4. 非 normalized 的 Float32 顶点色原样保留（对照组，确认没改坏）
 *
 * node test/vc-normalized.mjs
 */
import * as THREE from 'three';
import { batchGLTFScene } from '../src/viewer/bim-batch.js';

const ok = [];
const fail = [];
const t = (name, cond, extra = '') => {
  if (cond) ok.push(name);
  else fail.push(name + (extra ? ` (${extra})` : ''));
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`);
};

const root = new THREE.Group();

/** 一个 4 顶点的方形（世界坐标 0..1），position/normal 用 float */
function quadGeo() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

const tex1x1 = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
tex1x1.needsUpdate = true;

// ---------- 1) normalized Uint8 顶点色 = 255（白） ----------
{
  const g = quadGeo();
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  // 4 顶点 × RGBA，全部 255 → normalized 后应正好是 1.0
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(16).fill(255), 4, true));
  const mat = new THREE.MeshStandardMaterial({ name: '白顶点色', vertexColors: true });
  const m = new THREE.Mesh(g, mat);
  m.name = 'vc-white';
  root.add(m);
}

// ---------- 2) normalized Int16 量化坐标（0..32767 → 0..1，节点缩放 ×2 = 0..2 米） ----------
{
  const g = new THREE.BufferGeometry();
  const i16 = new Int16Array(9);
  const src = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 3; k++) i16[i * 3 + k] = Math.round(src[i][k] * 32767);
  }
  g.setAttribute('position', new THREE.BufferAttribute(i16, 3, true));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 1, 2]);
  const mat = new THREE.MeshStandardMaterial({ name: '量化坐标' });
  const m = new THREE.Mesh(g, mat);
  m.name = 'quantized-pos';
  m.scale.setScalar(2);
  root.add(m);
}

// ---------- 3) 交错缓冲（meshopt 式）：RGBA 颜色 + UV 都是 normalized Uint8 ----------
{
  const g = quadGeo();
  const stride = 8; // color 4 字节 + uv 2 字节 + 2 字节填充
  const buf = new Uint8Array(4 * stride);
  for (let i = 0; i < 4; i++) {
    buf[i * stride + 0] = 255;
    buf[i * stride + 1] = 255;
    buf[i * stride + 2] = 255;
    buf[i * stride + 3] = 255;
    buf[i * stride + 4] = i === 1 || i === 2 ? 255 : 0; // u
    buf[i * stride + 5] = i >= 2 ? 255 : 0;             // v
  }
  const ib = new THREE.InterleavedBuffer(buf, stride);
  g.setAttribute('color', new THREE.InterleavedBufferAttribute(ib, 4, 0, true));
  g.setAttribute('uv', new THREE.InterleavedBufferAttribute(ib, 2, 4, true));
  const mat = new THREE.MeshStandardMaterial({ name: '交错量化', vertexColors: true, map: tex1x1 });
  const m = new THREE.Mesh(g, mat);
  m.name = 'interleaved';
  root.add(m);
}

// ---------- 4) 对照组：float 顶点色 0.5，不该被改动 ----------
{
  const g = quadGeo();
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(16).fill(0.5), 4));
  const mat = new THREE.MeshStandardMaterial({ name: 'float顶点色', vertexColors: true });
  const m = new THREE.Mesh(g, mat);
  m.name = 'vc-float';
  root.add(m);
}

root.updateMatrixWorld(true);
const res = await batchGLTFScene(root, { chunk: 10 });
const byName = (n) => res.batches.find((x) => x.material.name === n);

const stat = (attr) => {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < attr.array.length; i++) {
    const v = attr.array[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return { mn, mx };
};

// 1) 白色顶点色
{
  const b = byName('白顶点色');
  const c = b?.batch.geometry.attributes.color;
  const s = c ? stat(c) : { mn: NaN, mx: NaN };
  t('白色顶点色：color 属性仍在', !!c);
  t('白色顶点色：材质仍开 vertexColors', b?.batch.material.vertexColors === true);
  t('白色顶点色：值仍是 1.0（没有被二次归一化压成 1/255）',
    Math.abs(s.mx - 1) < 1e-6 && Math.abs(s.mn - 1) < 1e-6,
    `min=${s.mn?.toFixed(5)} max=${s.mx?.toFixed(5)}`);
  t('白色顶点色：没有被压到 0.0039 那一档', s.mx > 0.5, `实际 ${s.mx?.toFixed(5)}`);
}

// 2) 量化坐标
{
  const b = byName('量化坐标');
  const p = b?.batch.geometry.attributes.position;
  const s = p ? stat(p) : { mn: NaN, mx: NaN };
  t('量化坐标：包围盒仍是 0..2 米（节点缩放已烘焙）',
    Math.abs(s.mn) < 1e-3 && Math.abs(s.mx - 2) < 1e-3,
    `min=${s.mn?.toFixed(4)} max=${s.mx?.toFixed(4)}`);
  t('量化坐标：没有被再缩 32767 倍（原本会塌成 0.00006）', s.mx > 0.5, `实际 ${s.mx?.toFixed(4)}`);
}

// 3) 交错缓冲
{
  const b = byName('交错量化');
  const c = b?.batch.geometry.attributes.color;
  const u = b?.batch.geometry.attributes.uv;
  const sc = c ? stat(c) : { mn: NaN, mx: NaN };
  const su = u ? stat(u) : { mn: NaN, mx: NaN };
  t('交错缓冲：颜色取到 1.0（偏移与归一化都对）', Math.abs(sc.mx - 1) < 1e-6, `max=${sc.mx?.toFixed(5)}`);
  t('交错缓冲：UV 取到 0..1（偏移正确）',
    Math.abs(su.mn) < 1e-6 && Math.abs(su.mx - 1) < 1e-6,
    `min=${su.mn?.toFixed(5)} max=${su.mx?.toFixed(5)}`);
}

// 4) 对照组
{
  const b = byName('float顶点色');
  const c = b?.batch.geometry.attributes.color;
  const s = c ? stat(c) : { mn: NaN, mx: NaN };
  t('float 顶点色：0.5 原样保留', Math.abs(s.mx - 0.5) < 1e-6 && Math.abs(s.mn - 0.5) < 1e-6,
    `min=${s.mn?.toFixed(3)} max=${s.mx?.toFixed(3)}`);
}

console.log(`\n通过 ${ok.length} / ${ok.length + fail.length}`);
if (fail.length) {
  console.log('失败：\n  ' + fail.join('\n  '));
  process.exitCode = 1;
}
