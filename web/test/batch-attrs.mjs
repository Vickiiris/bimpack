/**
 * batch-attrs.mjs —— 批处理是否保住了「材质看得见的东西」
 *
 * 回归背景：早期版本把几何统一剥到只剩 position/normal，
 * 带顶点色或贴图的构件进 BatchedMesh 后就没有 uv/color 可采样，
 * 整块显示成材质基色的死灰 —— 这就是"部分材质显示不正确"。
 *
 * 纯 Node 跑（BatchedMesh 只在 CPU 侧组装缓冲，不需要 WebGL）：
 *   node test/batch-attrs.mjs
 */
import * as THREE from 'three';
import { batchGLTFScene } from '../src/viewer/bim-batch.js';

const assert = (cond, msg) => {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; }
  else console.log('✓ ' + msg);
};

// ---------- 1. 顶点色材质 ----------
const vcGeo = new THREE.BoxGeometry(1, 1, 1);
const n = vcGeo.attributes.position.count;
vcGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.5), 3));
const vcMat = new THREE.MeshStandardMaterial({ vertexColors: true, name: 'VC' });
const vcMesh = new THREE.Mesh(vcGeo, vcMat);

// ---------- 2. 带贴图材质 ----------
const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
tex.needsUpdate = true;
const texMat = new THREE.MeshStandardMaterial({ map: tex, name: 'TEX' });
const texMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), texMat);

// ---------- 3. 镜像网格（负缩放）----------
const mirrorGeo = new THREE.BufferGeometry();
mirrorGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
  0, 0, 0, 1, 0, 0, 0, 1, 0,
]), 3));
mirrorGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
  0, 0, 1, 0, 0, 1, 0, 0, 1,
]), 3));
mirrorGeo.setIndex([0, 1, 2]);
const mirrorMat = new THREE.MeshStandardMaterial({ name: 'MIRROR' });
const mirrorMesh = new THREE.Mesh(mirrorGeo, mirrorMat);
mirrorMesh.scale.x = -1;                       // 行列式 < 0
mirrorMesh.position.set(5, 0, 0);

// ---------- 4. 没有顶点色的普通件（与顶点色件同批时补白）----------
const plainMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), vcMat); // 共用 vertexColors 材质

const scene = new THREE.Scene();
scene.add(vcMesh, texMesh, mirrorMesh, plainMesh);

const batched = await batchGLTFScene(scene, { chunk: 1000 });
const byMat = (m) => batched.batches.find((b) => b.material === m);

const vcBatch = byMat(vcMat);
const texBatch = byMat(texMat);
const mirBatch = byMat(mirrorMat);

// ---- 断言：属性集合 ----
assert(vcBatch?.batch.geometry.attributes.color, '顶点色材质：批内几何保留 color 属性');
assert(texBatch?.batch.geometry.attributes.uv, '贴图材质：批内几何保留 uv 属性');
assert(!texBatch?.batch.geometry.attributes.color, '贴图材质：不额外塞无用的 color 属性');

// 同批里缺顶点色的件要补白（否则乘上去是黑的）
if (vcBatch) {
  const g = vcBatch.batch.geometry;
  const rec = [...vcBatch.batch.userData.byInstance.values()].find((r) => r.object === plainMesh);
  const color = g.attributes.color;
  if (rec) {
    const geoInfo = vcBatch.batch._geometryInfo?.[rec.geometryId];
    const start = geoInfo ? geoInfo.vertexStart : 0;
    let allOne = true;
    for (let i = 0; i < 6; i++) if (Math.abs(color.getX(start + i) - 1) > 1e-6) allOne = false;
    assert(allOne, '同批无顶点色的件补白（乘色不变黑）');
  }
}

// ---- 断言：镜像绕序 ----
if (mirBatch) {
  const g = mig(mirBatch.batch);
  function mig(batch) { return batch.geometry; }
  const rec = [...mirBatch.batch.userData.byInstance.values()][0];
  const info = mirBatch.batch._geometryInfo?.[rec.geometryId];
  const idx = g.index.array;
  const start = info ? Math.floor(info.indexStart / 1) : 0;
  const i0 = idx[start], i1 = idx[start + 1], i2 = idx[start + 2];
  const pos = g.attributes.position;
  const a = new THREE.Vector3().fromBufferAttribute(pos, i0);
  const b = new THREE.Vector3().fromBufferAttribute(pos, i1);
  const c = new THREE.Vector3().fromBufferAttribute(pos, i2);
  const cross = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
  assert(cross.z > 0, `镜像件绕序已纠正（几何法线 z=${cross.z.toFixed(3)} > 0）`);
  const nrm = g.attributes.normal;
  assert(nrm.getZ(i0) > 0, `镜像件顶点法线与绕序一致（nz=${nrm.getZ(i0).toFixed(3)} > 0）`);
}

console.log(process.exitCode ? '\n有断言失败' : '\n全部通过');
