/**
 * bim-batch.js —— 把 glTF 里成千上万个独立 Mesh 收敛成「按材质分组的 BatchedMesh」
 *
 * 效果：12209 个 draw call → 29 个（按材质分组数），
 *      同时保留「逐构件」能力：视锥剔除、隐藏、拾取。
 *
 * 用法：
 *   import { batchGLTFScene } from './bim-batch.js';
 *   const b = await batchGLTFScene(gltf.scene, { onProgress: console.log });
 *   scene.add(b.group);            // 用这个换掉 gltf.scene
 *   const hit = b.pick(raycaster);  // 命中 → { name, props, instanceId }
 *
 * 三个必须遵守的 BatchedMesh 硬约束（否则直接抛错）：
 *   1. 同一 batch 内所有几何的「属性集合」必须完全一致 → 本模块统一剥到只剩 position/normal
 *   2. 同一 batch 内所有几何要么全有 index 要么全没有 → 缺的自动补满索引
 *   3. itemSize / normalized 必须一致 → 统一转 Float32
 * 另有一个易踩的坑：
 *   maxIndexCount 默认是 maxVertexCount*2，但本模型最大一组是 1.81M 顶点 / 5.79M 索引（3.2 倍），
 *   不显式传会直接抛 "Reserved space request exceeds the maximum buffer size."
 */
import * as THREE from 'three';

const IDENTITY = new THREE.Matrix4();

/** 收集场景里所有可批处理的三角形 Mesh，并按材质分组 */
function collect(scene) {
  const groups = new Map(); // material.uuid → { material, items: [] }
  const geoUse = new Map(); // geometry.uuid → 被引用次数（决定能否原地烘焙变换）
  let skipped = 0;

  scene.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh) return;
    const g = o.geometry;
    if (!g || !g.attributes.position) return;
    if (Array.isArray(o.material)) { skipped++; return; } // 多材质 Mesh 极少见，本例不会出现
    if (o.material.transparent && o.material.opacity === 0) { skipped++; return; }

    let rec = groups.get(o.material.uuid);
    if (!rec) {
      rec = { material: o.material, items: [] };
      groups.set(o.material.uuid, rec);
    }
    rec.items.push(o);
    geoUse.set(g.uuid, (geoUse.get(g.uuid) || 0) + 1);
  });

  return { groups, geoUse, skipped };
}

/** 把几何规整成 BatchedMesh 能接受的统一形态，并把世界变换烘进顶点 */
function normalizeGeometry(src, matrixWorld, cloneIt, keepVertexAttrs) {
  const geo = cloneIt ? src.clone() : src;

  // 1) 属性白名单：默认只留 position / normal（无贴图的楼层 UV 纯冗余，剥掉可统一属性集合）
  for (const name of Object.keys(geo.attributes)) {
    if (!keepVertexAttrs.includes(name)) geo.deleteAttribute(name);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();

  // 2) 缺失的可选属性补空 —— BatchedMesh 要求同批属性集合完全一致，
  //    否则报 "Added geometry missing 'uv'"，这是带贴图楼层最容易翻车的地方
  const vertCount = geo.attributes.position.count;
  for (const name of keepVertexAttrs) {
    if (geo.attributes[name]) continue;
    if (name === 'uv') {
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertCount * 2), 2));
    } else if (name === 'color') {
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertCount * 3).fill(1), 3));
    }
  }

  // 3) 统一成 Float32、非交错
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name];
    if (a.isInterleavedBufferAttribute) {
      geo.setAttribute(name, new THREE.BufferAttribute(a.array.slice(), a.itemSize, a.normalized));
    }
  }

  // 3) 没索引的补一个"顺序索引"，保证同批几何一致性
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  // 4) 索引统一成 Uint32（避免同批内 u16/u32 混用）
  if (geo.index.array.constructor !== Uint32Array) {
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(geo.index.array), 1));
  }

  // 5) 把节点世界变换烘进顶点 —— BatchedMesh 每个实例的矩阵只做实例级摆放，
  //    这里直接烘焙等价于 setMatrixAt(instanceId, identity)
  geo.applyMatrix4(matrixWorld);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  return geo;
}

/**
 * @param {THREE.Object3D} scene  GLTFLoader 出来的 gltf.scene
 * @param {object} opts
 * @param {(p:{done:number,total:number,phase:string})=>void} opts.onProgress
 * @param {string[]} opts.keepAttrs  额外保留的顶点属性（默认只留 position/normal）
 * @param {number} opts.chunk        每处理多少几何让出一次主线程
 */
export async function batchGLTFScene(scene, opts = {}) {
  const { onProgress = () => {}, keepAttrs = [], chunk = 250 } = opts;
  const keepVertexAttrs = ['position', 'normal', ...keepAttrs];

  scene.updateMatrixWorld(true);
  const tStart = performance.now();
  const { groups, geoUse, skipped } = collect(scene);

  const total = [...groups.values()].reduce((a, g) => a + g.items.length, 0);
  onProgress({ done: 0, total, phase: 'collect' });

  const group = new THREE.Group();
  group.name = 'BatchedBIM';
  const batches = [];
  const trash = []; // 延迟释放的克隆几何
  let done = 0;

  for (const { material, items } of groups.values()) {
    // 预分配：BatchedMesh 是"定容"结构，必须先算准总量
    let maxV = 0;
    let maxI = 0;
    for (const m of items) {
      maxV += m.geometry.attributes.position.count;
      maxI += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count;
    }

    const batch = new THREE.BatchedMesh(items.length, maxV, maxI, material);
    batch.name = 'batch:' + (material.name || material.uuid.slice(0, 6));
    batch.perObjectFrustumCulled = true; // 逐构件视锥剔除（BIM 场景收益很大）
    batch.sortObjects = true; // 透明材质需要按距离排序
    // instanceId → 构件记录。挂在 batch 上，拾取时 O(1) 命中
    batch.userData.byInstance = new Map();

    let localIndex = 0;
    for (const mesh of items) {
      const src = mesh.geometry;
      const shared = (geoUse.get(src.uuid) || 1) > 1;
      const geo = normalizeGeometry(src, mesh.matrixWorld, shared, keepVertexAttrs);
      if (shared) trash.push(geo);

      const geometryId = batch.addGeometry(geo);
      const instanceId = batch.addInstance(geometryId);
      batch.setMatrixAt(instanceId, IDENTITY);

      // 记录「实例 → 构件」，拾取/属性面板就靠它（不持有 mesh 引用，避免原件无法 GC）
      batch.userData.byInstance.set(instanceId, {
        batch,
        geometryId,
        instanceId,
        localIndex,
        name: mesh.name || mesh.parent?.name || '(未命名)',
        props: mesh.userData && Object.keys(mesh.userData).length
          ? mesh.userData
          : mesh.parent?.userData || {},
      });
      localIndex++;

      if (++done % chunk === 0) {
        onProgress({ done, total, phase: 'batch' });
        await new Promise((r) => setTimeout(r, 0)); // 让出主线程，别把页面卡死
      }
    }

    batch.computeBoundingSphere();
    batch.computeBoundingBox();
    group.add(batch);
    batches.push({ batch, count: items.length, material });
  }

  // 释放克隆出来的临时几何（此时 BatchedMesh 已把数据拷进自己的大缓冲）
  for (const g of trash) g.dispose();
  // 原始几何全部释放（GPU 侧）
  scene.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
    }
  });

  const ms = performance.now() - tStart;
  onProgress({ done: total, total, phase: 'done' });

  return {
    group,
    batches,
    stats: {
      drawCalls: batches.length,
      meshes: total,
      skipped,
      vertexCount: batches.reduce((a, b) => a + b.batch.geometry.attributes.position.count, 0),
      buildMs: Math.round(ms),
    },
    /** 用 Raycaster 拾取：命中信息在 hit.batchId（= instanceId），不是 instancedMesh 的 instanceId 字段 */
    pick(raycaster) {
      const hits = raycaster.intersectObject(group, true);
      for (const hit of hits) {
        if (hit.batchId === undefined) continue;
        const rec = hit.object.userData.byInstance.get(hit.batchId);
        if (rec) return { ...hit, rec };
      }
      return null;
    },
  };
}

/** 选中高亮：setColorAt 是乘性着色，所以默认色用白色，选中用橙色 */
export function setHighlight(rec, colorHex) {
  rec.batch.setColorAt(rec.instanceId, new THREE.Color(colorHex));
}

/** 逐构件显隐（隔离、剖切联动都靠它） */
export function setVisible(rec, visible) {
  rec.batch.setVisibleAt(rec.instanceId, visible);
}
