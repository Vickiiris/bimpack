/**
 * bim-batch.js —— 把成千上万个独立 Mesh 收敛成「按材质分组的 BatchedMesh」
 *
 * 效果：12209 个 draw call → 按材质分组数（本例 29 个），
 *      同时保留「逐构件」能力：视锥剔除、隐藏、拾取、聚焦。
 *
 * 与 Node 版 viewer 的差异：额外记录了「构件世界包围盒」与「Object3D → 实例」映射，
 * 让层级树点选后能直接高亮 + 相机飞过去。
 *
 * 三个必须遵守的 BatchedMesh 硬约束（否则直接抛错）：
 *   1. 同一 batch 内所有几何的「属性集合」必须完全一致 → 统一剥到只剩 position/normal
 *   2. 同一 batch 内所有几何要么全有 index 要么全没有 → 缺的自动补满索引
 *   3. itemSize / normalized 必须一致 → 统一转 Float32
 * 易踩的坑：maxIndexCount 默认是 maxVertexCount*2，
 *   但本例最大一组是 1.81M 顶点 / 5.79M 索引（3.2 倍），不显式传会抛
 *   "Reserved space request exceeds the maximum buffer size."
 */
import * as THREE from 'three';

const IDENTITY = new THREE.Matrix4();
const HILIGHT = new THREE.Color(0xff8a3d);
const WHITE = new THREE.Color(0xffffff);

function collect(scene) {
  const groups = new Map(); // material.uuid → { material, items: [] }
  const geoUse = new Map(); // geometry.uuid → 引用次数
  let skipped = 0;

  scene.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh) return;
    const g = o.geometry;
    if (!g || !g.attributes.position) return;
    if (!o.material) { skipped++; return; }
    if (Array.isArray(o.material)) { skipped++; return; }
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

/**
 * 把任意顶点属性压成「Float32 / 非交错 / 已反归一化」。
 *
 * 为什么必须做：meshopt / Draco 的量化会把 POSITION 存成 Int16 normalized 且交错存放
 * （byteStride = 3*2 + padding）。此时：
 *   - `attr.array` 是整段交错缓冲，直接 slice 当单属性用 → count 错乱、取值错位
 *   - normalized 属性的原始值是整数，不反归一化 → 坐标放大成千上万倍
 * 这两条都会让 BatchedMesh 预分配爆掉（Reserved space request exceeds...）。
 */
function flattenAttribute(geo, name) {
  const a = geo.attributes[name];
  if (!a) return;

  const interleaved = !!a.isInterleavedBufferAttribute;
  const needsConv = interleaved || a.normalized || !(a.array instanceof Float32Array);
  if (!needsConv) return;

  let denom = 1;
  if (a.normalized) {
    const arr = a.array;
    if (arr instanceof Int8Array) denom = 127;
    else if (arr instanceof Uint8Array) denom = 255;
    else if (arr instanceof Int16Array) denom = 32767;
    else if (arr instanceof Uint16Array) denom = 65535;
  }

  const n = a.count;
  const size = a.itemSize;
  const out = new Float32Array(n * size);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < size; k++) {
      out[i * size + k] = a.getComponent(i, k) / denom;
    }
  }
  geo.setAttribute(name, new THREE.BufferAttribute(out, size, false));
}

/** 规整几何到 BatchedMesh 能接受的统一形态，并把世界变换烘进顶点 */
function normalizeGeometry(src, matrixWorld, cloneIt, keepVertexAttrs) {
  const geo = cloneIt ? src.clone() : src;

  for (const name of Object.keys(geo.attributes)) {
    if (!keepVertexAttrs.includes(name)) geo.deleteAttribute(name);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();

  // BatchedMesh 要求同批属性集合完全一致，缺的补空
  const vertCount = geo.attributes.position.count;
  for (const name of keepVertexAttrs) {
    if (geo.attributes[name]) continue;
    if (name === 'uv') geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertCount * 2), 2));
    else if (name === 'color') {
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertCount * 3).fill(1), 3));
    }
  }

  // 统一成 Float32、非交错、已反归一化（量化压缩过的文件必须走这一步）
  for (const name of Object.keys(geo.attributes)) flattenAttribute(geo, name);

  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (geo.index.array.constructor !== Uint32Array) {
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(geo.index.array), 1));
  }

  // 世界变换烘进顶点（等价于实例矩阵设为单位阵）
  geo.applyMatrix4(matrixWorld);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * @param {THREE.Object3D} scene  GLTFLoader 出来的 gltf.scene
 * @param {object} opts
 * @param {(p:{done:number,total:number,phase:string})=>void} opts.onProgress
 * @param {string[]} opts.keepAttrs  额外保留的顶点属性
 * @param {number} opts.chunk        每处理多少几何让出一次主线程
 * @param {(o:THREE.Object3D)=>string|undefined} opts.nameOf  取 GLB 里的原始节点名
 *        （GLTFLoader 会按 PropertyBinding 规则把名字里的空格/括号改写成下划线，
 *         这里用 parser.associations 找回原文，层级树上看到的就和 3ds Max 一致）
 */
export async function batchGLTFScene(scene, opts = {}) {
  const { onProgress = () => {}, keepAttrs = [], chunk = 250, nameOf = null } = opts;
  const keepVertexAttrs = ['position', 'normal', ...keepAttrs];

  scene.updateMatrixWorld(true);
  const tStart = performance.now();
  const { groups, geoUse, skipped } = collect(scene);

  const total = [...groups.values()].reduce((a, g) => a + g.items.length, 0);
  onProgress({ done: 0, total, phase: 'collect' });

  const group = new THREE.Group();
  group.name = 'BatchedBIM';
  const batches = [];
  const trash = [];
  /** Object3D → 该对象对应的实例记录（树点选用） */
  const objectToRecs = new Map();
  /** 世界包围盒：顺手累出来，比事后 setFromObject 去猜 BatchedMesh 的盒可靠 */
  const modelBox = new THREE.Box3();
  let done = 0;

  for (const { material, items } of groups.values()) {
    let maxV = 0;
    let maxI = 0;
    for (const m of items) {
      maxV += m.geometry.attributes.position.count;
      maxI += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count;
    }

    const batch = new THREE.BatchedMesh(items.length, maxV, maxI, material);
    batch.name = 'batch:' + (material.name || material.uuid.slice(0, 6));
    batch.perObjectFrustumCulled = true;
    batch.sortObjects = true;
    batch.userData.byInstance = new Map();

    let localIndex = 0;
    for (const mesh of items) {
      const src = mesh.geometry;
      const shared = (geoUse.get(src.uuid) || 1) > 1;
      const geo = normalizeGeometry(src, mesh.matrixWorld, shared, keepVertexAttrs);
      const box = geo.boundingBox ? geo.boundingBox.clone() : null;
      if (box) modelBox.union(box);
      if (shared) trash.push(geo);

      const geometryId = batch.addGeometry(geo);
      const instanceId = batch.addInstance(geometryId);
      batch.setMatrixAt(instanceId, IDENTITY);

      const rec = {
        batch,
        geometryId,
        instanceId,
        localIndex,
        object: mesh,
        name: nameOf?.(mesh) || mesh.name || mesh.parent?.name || '(未命名)',
        box,
        props: (mesh.userData && Object.keys(mesh.userData).length)
          ? mesh.userData
          : (mesh.parent?.userData || {}),
        highlighted: false,
      };
      batch.userData.byInstance.set(instanceId, rec);

      const list = objectToRecs.get(mesh);
      if (list) list.push(rec);
      else objectToRecs.set(mesh, [rec]);

      localIndex++;

      if (++done % chunk === 0) {
        onProgress({ done, total, phase: 'batch' });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    batch.computeBoundingSphere();
    batch.computeBoundingBox();
    group.add(batch);
    batches.push({ batch, count: items.length, material });
  }

  for (const g of trash) g.dispose();
  // 原始几何已拷进 BatchedMesh 的大缓冲，GPU 侧可以释放；Object3D 保留给层级树用
  scene.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });

  const ms = performance.now() - tStart;
  onProgress({ done: total, total, phase: 'done' });

  return {
    group,
    batches,
    objectToRecs,
    box: modelBox,
    stats: {
      drawCalls: batches.length,
      meshes: total,
      skipped,
      vertexCount: batches.reduce((a, b) => a + b.batch.geometry.attributes.position.count, 0),
      buildMs: Math.round(ms),
    },
    /** 命中信息在 hit.batchId（= instanceId），不是 instancedMesh 的 instanceId 字段 */
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

export function setHighlight(rec, on) {
  if (!rec) return;
  rec.highlighted = on;
  // three r170 的 BatchedMesh 把实例色存在私有 _colorsTexture 里，setColorAt 内部
  // 已经做了 needsUpdate，不要再去碰 instanceColor（那个属性不存在，会抛异常）
  rec.batch.setColorAt(rec.instanceId, on ? HILIGHT : WHITE);
}

export function setVisible(rec, visible) {
  rec.batch.setVisibleAt(rec.instanceId, visible);
}

/** 把一组记录的世界包围盒并起来（树上点 Group 时用） */
export function unionBox(recs) {
  const box = new THREE.Box3();
  for (const r of recs) if (r.box) box.union(r.box);
  return box;
}
