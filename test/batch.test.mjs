/**
 * 无头单元测试：不开 WebGL，直接验证 bim-batch.js 的核心逻辑
 *   node test-batch.mjs
 *
 * 覆盖：材质分组 / 顶点与索引预分配 / 属性不一致处理 / 变换烘焙 / 拾取 / 显隐 / 高亮
 */
import * as THREE from 'three';
import { batchGLTFScene, setHighlight, setVisible } from '../viewer/bim-batch.js';

const ok = [];
const fail = [];
const t = (name, cond, extra = '') => (cond ? ok : fail).push(name + (extra ? ` (${extra})` : ''));

// ---------- 造一个假场景：2 种材质、5 个构件 ----------
const root = new THREE.Group();
const matA = new THREE.MeshStandardMaterial({ name: 'A' });
const matB = new THREE.MeshStandardMaterial({ name: 'B', transparent: true });

function addMesh(geo, mat, name, x, withUV) {
  if (withUV) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.position.set(x, 0, 0);
  m.userData = { id: 'ID-' + name, 'Category Name': '风管', Type: '测试' };
  root.add(m);
  return m;
}

// A 组：3 个带 UV 的盒子（模拟 GLB 里 517 个带 UV 的图元）
addMesh(new THREE.BoxGeometry(10, 10, 10), matA, 'A1', 0, true);
addMesh(new THREE.BoxGeometry(10, 20, 10), matA, 'A2', 30, true);
const a3 = addMesh(new THREE.SphereGeometry(6, 16, 12), matA, 'A3', 60, true);
// B 组：一个无 UV、一个无索引（验证自动补索引）
const nb = new THREE.BoxGeometry(8, 8, 8);
nb.deleteAttribute('uv');
addMesh(nb, matB, 'B1', 0, false);
const noIdx = new THREE.BoxGeometry(4, 4, 4).toNonIndexed();
noIdx.deleteAttribute('uv');
addMesh(noIdx, matB, 'B2', 20, false);

root.updateMatrixWorld(true);
let vtxBefore = 0, idxBefore = 0;
root.traverse((o) => {
  if (!o.isMesh) return;
  vtxBefore += o.geometry.attributes.position.count;
  idxBefore += o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
});

// ---------- 跑批处理 ----------
const b = await batchGLTFScene(root, { chunk: 2 });

t('按材质分 2 组 → 2 个 draw call', b.stats.drawCalls === 2, `实际 ${b.stats.drawCalls}`);
t('构件数 5 全部保留', b.stats.meshes === 5, `实际 ${b.stats.meshes}`);
t('无跳过项', b.stats.skipped === 0, `实际 ${b.stats.skipped}`);
t('顶点总数一致', b.stats.vertexCount === vtxBefore, `${b.stats.vertexCount} vs ${vtxBefore}`);
t('无索引几何已自动补索引', b.batches.every((x) => x.batch.geometry.index !== null));

const bA = b.batches.find((x) => x.material === matA);
const bB = b.batches.find((x) => x.material === matB);
t('A 组实例数 3', bA.batch.instanceCount === 3, `实际 ${bA.batch.instanceCount}`);
t('B 组实例数 2', bB.batch.instanceCount === 2, `实际 ${bB.batch.instanceCount}`);
t('索引缓冲按需精确预分配（无浪费）', bA.batch.unusedIndexCount === 0, `剩余 ${bA.batch.unusedIndexCount}`);

// 属性一致性：同一批内属性集合必须完全相同，否则 three 会抛错
const attrSets = b.batches.map((x) => Object.keys(x.batch.geometry.attributes).sort().join(','));
t('所有批次属性集合一致', new Set(attrSets).size === 1, attrSets.join(' | '));
t('UV 已按预期剥离', !b.batches[0].batch.geometry.attributes.uv);

// 变换烘焙：A2 顶点应已平移到 x≈30
const gid = bA.batch.getGeometryRangeAt(1);
const pos = bA.batch.geometry.attributes.position.array;
let cx = 0;
for (let i = gid.vertexStart; i < gid.vertexStart + gid.vertexCount; i++) cx += pos[i * 3];
cx /= gid.vertexCount;
t('节点世界变换已烘焙进顶点', Math.abs(cx - 30) < 0.01, `质心 x=${cx.toFixed(3)}`);

// ---------- 拾取 ----------
const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 200), new THREE.Vector3(0, 0, -1));
const hit = b.pick(ray);
t('射线能命中', !!hit);
t('命中带 batchId', hit && hit.batchId !== undefined);
t('命中能反查构件名', hit && hit.rec.name === 'A1', hit?.rec?.name);
t('命中能拿到 BIM 属性', hit && hit.rec.props['Category Name'] === '风管');

// ---------- 显隐 / 高亮 ----------
setVisible(hit.rec, false);
t('隐藏生效', hit.rec.batch.getVisibleAt(hit.rec.instanceId) === false);
setVisible(hit.rec, true);
t('恢复显示生效', hit.rec.batch.getVisibleAt(hit.rec.instanceId) === true);
setHighlight(hit.rec, 0xffb020);
const c = new THREE.Color();
hit.rec.batch.getColorAt(hit.rec.instanceId, c);
t('高亮颜色写入成功', c.getHex() === 0xffb020, `c=#${c.getHexString()}`);

// ---------- 结果 ----------
console.log('\n通过 ' + ok.length + ' / ' + (ok.length + fail.length));
for (const o of ok) console.log('  ✓ ' + o);
if (fail.length) {
  console.log('\n失败：');
  for (const f of fail) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\nstats:', JSON.stringify(b.stats));
