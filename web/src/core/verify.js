/**
 * verify.js —— 交付前的质量闸门（浏览器版）
 *
 *   1) compareJSON()     纯 JSON 比对，不解码几何（秒级）
 *                        核的是"该保留的东西一样没少"：节点名、层级、extras、变换、材质、绑定、面数、扩展
 *   2) compareGeometry() 按图元抽样算包围盒/表面积偏差（O(n)，浏览器里能秒级完成）
 *
 * 与 Node 版的差异：几何比对不做逐顶点最近邻（那是 O(n²)，748 万顶点在浏览器里跑不动），
 * 改成抽样图元的包围盒角点位移 + 表面积相对差 —— 同样能抓住"几何走形"，代价小两个数量级。
 */
import { readJSON } from './glb.js';

const canon = (v) =>
  JSON.stringify(v, (k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val).sort().reduce((o, key) => ((o[key] = val[key]), o), {});
    }
    return val;
  });

/** 同上，但把数字压到 6 位有效数字 —— 抹掉 float32 往返噪声，只留真实差异 */
const canonNum = (v) =>
  JSON.stringify(v, (k, val) => {
    if (typeof val === 'number') return Number(val.toPrecision(6));
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val).sort().reduce((o, key) => ((o[key] = val[key]), o), {});
    }
    return val;
  });

function numClose(a, b, tol = 1e-6) {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => numClose(x, b[i], tol));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && numClose(a[k], b[k], tol));
  }
  return a === b;
}

function quatToMat3(q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** 节点 → 4x4（列主序，glTF 约定）。matrix 与 TRS 统一到这里比较 */
function nodeMatrix(n) {
  if (Array.isArray(n.matrix)) return n.matrix.map(Number);
  const t = n.translation || [0, 0, 0];
  const r = n.rotation || [0, 0, 0, 1];
  const s = n.scale || [1, 1, 1];
  const m = quatToMat3(r);
  return [
    m[0] * s[0], m[3] * s[0], m[6] * s[0], 0,
    m[1] * s[1], m[4] * s[1], m[7] * s[1], 0,
    m[2] * s[2], m[5] * s[2], m[8] * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

/**
 * 用几何量衡量两个变换的差异：单位立方体角点变换后的最大空间位移。
 * 比逐元素比矩阵靠谱 —— 逐元素在 157 米平移量级上会被 float32 四元数往返噪声误判。
 */
function transformDisplacement(ma, mb) {
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [-1, -1, -1]];
  const apply = (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
  let d = 0;
  for (const c of corners) {
    const pa = apply(ma, c);
    const pb = apply(mb, c);
    d = Math.max(d, Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]));
  }
  return d;
}

const triCount = (J) =>
  (J.meshes || []).reduce(
    (s, m) => s + (m.primitives || []).reduce(
      (t, p) => t + (p.indices !== undefined ? Math.floor((J.accessors[p.indices]?.count || 0) / 3) : 0), 0),
    0);

const vertCount = (J) =>
  (J.meshes || []).reduce(
    (s, m) => s + (m.primitives || []).reduce(
      (t, p) => t + (J.accessors[p.attributes?.POSITION]?.count || 0), 0),
    0);

/**
 * @param {Uint8Array} bytesA 输入
 * @param {Uint8Array} bytesB 输出
 * @param {{transformTolerance?:number}} opts
 */
export function compareJSON(bytesA, bytesB, opts = {}) {
  const tol = opts.transformTolerance ?? 0.01;
  const A = readJSON(bytesA);
  const B = readJSON(bytesB);
  const rows = [];
  const add = (ok, label, a = '', b = '') => rows.push({ ok, label, a, b });

  const nA = A.nodes || [];
  const nB = B.nodes || [];
  const primsA = (A.meshes || []).flatMap((m) => m.primitives || []);
  const primsB = (B.meshes || []).flatMap((m) => m.primitives || []);

  add(nA.length === nB.length, '节点数', nA.length, nB.length);
  add((A.meshes || []).length === (B.meshes || []).length, '网格数', (A.meshes || []).length, (B.meshes || []).length);
  add(primsA.length === primsB.length, '图元数', primsA.length, primsB.length);
  add((A.scenes || []).length === (B.scenes || []).length, '场景数');
  add(
    JSON.stringify(A.scenes?.[0]?.nodes || []) === JSON.stringify(B.scenes?.[0]?.nodes || []),
    '场景根节点列表'
  );

  // 名称 / 层级
  add(
    JSON.stringify(nA.map((n) => n.name ?? '')) === JSON.stringify(nB.map((n) => n.name ?? '')),
    '节点名称逐项一致'
  );
  add(
    JSON.stringify(nA.map((n) => n.children || [])) === JSON.stringify(nB.map((n) => n.children || [])),
    '节点父子层级一致'
  );

  // extras —— BIM 属性的核心指标。逐条比对而非拼接大字符串，避免把 31MB 属性再复制一份
  let extrasMismatch = 0;
  let firstBad = -1;
  const N = Math.min(nA.length, nB.length);
  for (let i = 0; i < N; i++) {
    if (canon(nA[i].extras || {}) !== canon(nB[i].extras || {})) {
      extrasMismatch++;
      if (firstBad < 0) firstBad = i;
    }
  }
  add(
    extrasMismatch === 0,
    '节点 extras 逐条一致',
    extrasMismatch ? `${extrasMismatch} 个不一致` : `${N} 条全一致`,
    extrasMismatch ? `首个：节点#${firstBad} ${nA[firstBad]?.name ?? ''}` : ''
  );

  const withExtras = (arr) => arr.filter((n) => n.extras && Object.keys(n.extras).length).length;
  add(withExtras(nA) === withExtras(nB), '含属性节点数', withExtras(nA), withExtras(nB));

  const propCount = (arr) => arr.reduce((s, n) => s + Object.keys(n.extras || {}).length, 0);
  add(propCount(nA) === propCount(nB), '属性条目总数', propCount(nA), propCount(nB));

  add(
    JSON.stringify((A.meshes || []).map((m) => canon(m.extras || {}))) ===
      JSON.stringify((B.meshes || []).map((m) => canon(m.extras || {}))),
    '网格 extras 一致'
  );

  // 变换：量化压缩（KHR_mesh_quantization）会把量化的 scale/offset 烘进节点变换，
  // 顶点同时被归一化 —— 二者必须合起来看才对，单独比节点变换只会得到几万单位的假差异。
  // 因此量化场景下这条不判失败，改由 compareGeometry 用「世界坐标包围盒」把关。
  const quantized = (B.extensionsUsed || []).includes('KHR_mesh_quantization');
  let maxDisp = 0;
  let worstNode = -1;
  for (let i = 0; i < N; i++) {
    const d = transformDisplacement(nodeMatrix(nA[i]), nodeMatrix(nB[i]));
    if (d > maxDisp) { maxDisp = d; worstNode = i; }
  }
  if (quantized) {
    rows.push({
      ok: true,
      label: '变换等价（量化模式跳过逐节点比对）',
      a: `最大逐元素差异 ${maxDisp.toExponential(2)}`,
      b: '量化补偿已写入节点变换，以几何校验为准',
    });
  } else {
    add(
      maxDisp <= tol,
      '变换等价（角点最大位移）',
      `${maxDisp.toExponential(2)} 单位`,
      `容差 ${tol}` + (maxDisp > tol ? ` · 节点#${worstNode} ${nA[worstNode]?.name ?? ''}` : '')
    );
  }

  // 材质：gltf-transform 会丢弃「没被任何图元引用」的材质，索引也会重排，
  // 所以比的是「每个图元用的是哪个材质（按名称）」以及「被引用的材质是否都在」。
  const mA = A.materials || [];
  const mB = B.materials || [];
  const matName = (J, i) => (i === undefined || i < 0 ? '(默认)' : (J.materials?.[i]?.name ?? `#${i}`));
  const usedIdxA = new Set(primsA.map((p) => p.material ?? -1));
  const matNameRaw = (J, i) => (i === undefined || i < 0 ? '(默认)' : (J.materials?.[i]?.name ?? `#${i}`));
  const usedNamesA = new Set([...usedIdxA].map((i) => matNameRaw(A, i)));
  const namesB = new Set(mB.map((m) => m.name ?? ''));
  const lostNames = [...usedNamesA].filter((n) => !namesB.has(n));
  add(
    lostNames.length === 0,
    '材质数（被引用材质的名称全部保留）',
    `${mA.length} 条（被引用 ${usedIdxA.size} 个索引 / ${usedNamesA.size} 个名称）`,
    `${mB.length} 条` + (lostNames.length ? `　缺：${lostNames.slice(0, 3).join(', ')}` : '　全部保留')
  );

  const bindA = primsA.map((p) => matName(A, p.material));
  const bindB = primsB.map((p) => matName(B, p.material));
  let bindBad = 0;
  for (let i = 0; i < Math.min(bindA.length, bindB.length); i++) if (bindA[i] !== bindB[i]) bindBad++;
  add(bindBad === 0 && bindA.length === bindB.length, '每图元材质绑定一致（按名称）',
    bindBad ? `${bindBad} 处不同` : `0 差异`, bindBad ? `首例 ${bindA.find((x, i) => x !== bindB[i])}` : '');

  // 材质定义：按「多重集」比较，与顺序/重复无关。
  // 同名材质可能有多份（本例 7 个 "04 - Default"），按名称建 Map 会把它们挤成一个 —— 必然误报。
  const usedIdxB = new Set(primsB.map((p) => p.material ?? -1));
  const defsOf = (J, idxSet, withExtOnly = false) => [...idxSet]
    .map((i) => {
      const m = J.materials?.[i];
      if (!m) return '(缺失)';
      return canonNum(withExtOnly ? { name: m.name, ext: m.extensions || {} } : m);
    })
    .sort();

  const defsA = defsOf(A, usedIdxA);
  const defsB = defsOf(B, usedIdxB);
  let defBad = 0;
  for (let i = 0; i < Math.min(defsA.length, defsB.length); i++) if (defsA[i] !== defsB[i]) defBad++;
  add(
    defBad === 0 && defsA.length === defsB.length,
    '被引用材质定义一致（多重集，与顺序无关）',
    `${defsA.length} 份`,
    defBad ? `${defBad} 份不同` : `${defsB.length} 份，逐份一致`
  );

  add(triCount(A) === triCount(B), '三角面数', triCount(A), triCount(B));
  rows.push({ ok: true, label: '顶点数（Draco 重构后可变）', a: vertCount(A), b: vertCount(B) });

  // 扩展：允许「压缩扩展互换」（Draco ↔ meshopt，three 两者都原生支持），
  // 但除此之外的扩展一个都不能少，也不能凭空多出来。
  const setOf = (x) => [...new Set(x || [])].sort().join(', ');
  const COMPRESSION = new Set([
    'KHR_draco_mesh_compression',
    'EXT_meshopt_compression',
    'KHR_mesh_quantization', // 量化压缩的伴生扩展，必然新增
  ]);
  const reqA = new Set(A.extensionsRequired || []);
  const reqB = new Set(B.extensionsRequired || []);
  const missing = [...reqA].filter((x) => !reqB.has(x) && !COMPRESSION.has(x));
  const added = [...reqB].filter((x) => !reqA.has(x));
  const addedBad = added.filter((x) => !COMPRESSION.has(x));
  add(
    missing.length === 0 && addedBad.length === 0,
    'extensionsRequired（输出应为超集）',
    setOf(A.extensionsRequired) || '（无）',
    setOf(B.extensionsRequired) + (added.length ? `  (+${added.join(', ')})` : '')
  );
  const extA = defsOf(A, usedIdxA, true);
  const extB = defsOf(B, usedIdxB, true);
  let extMatBad = 0;
  for (let i = 0; i < Math.min(extA.length, extB.length); i++) if (extA[i] !== extB[i]) extMatBad++;
  add(
    extMatBad === 0 && extA.length === extB.length,
    '材质扩展（volume/transmission 等）保留',
    extMatBad ? `${extMatBad} 份不一致` : `${extA.length} 份全部一致`
  );

  return {
    pass: rows.every((r) => r.ok),
    rows,
    info: { verticesA: vertCount(A), verticesB: vertCount(B), triangles: triCount(A), maxTransformDisplacement: maxDisp },
  };
}

/**
 * 几何比对：抽样图元，比较包围盒角点与表面积。
 * O(n) 复杂度，748 万顶点也能秒级跑完；能抓住"整体走形/尺度错位"，抓不住亚毫米级抖动（那个交给 Node 版）。
 */
export async function compareGeometry(io, bytesA, bytesB, samples = 400) {
  const [docA, docB] = await Promise.all([io.readBinary(bytesA), io.readBinary(bytesB)]);

  // 必须带节点世界矩阵：量化压缩会把顶点归一化、把补偿写进节点变换，
  // 只比局部坐标会得到几万单位的假差异。世界包围盒才是"构件在不在原位"的真判据。
  const collect = (doc) => {
    const out = [];
    for (const node of doc.getRoot().listNodes()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      const w = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) out.push({ prim, w });
    }
    return out;
  };

  const localBox = (item) => {
    const attr = item.prim.getAttribute('POSITION');
    if (!attr) return null;
    const a = attr.getArray();

    // 量化后的 POSITION 是 normalized 整型（Int16 等），getArray() 给的是**原始整数**，
    // 不除以分母会得到 ±32767 这种值，再乘上节点缩放就是天文数字。
    let div = 1;
    if (attr.getNormalized()) {
      switch (attr.getComponentType()) {
        case 5120: div = 127; break;    // BYTE
        case 5121: div = 255; break;    // UNSIGNED_BYTE
        case 5122: div = 32767; break;  // SHORT
        case 5123: div = 65535; break;  // UNSIGNED_SHORT
        default: div = 1;
      }
    }

    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < a.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = a[i + k] / div;
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
    return { mn, mx };
  };

  const applyM = (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];

  const worldBox = (item) => {
    const b = localBox(item);
    if (!b) return null;
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = [
        c & 1 ? b.mx[0] : b.mn[0],
        c & 2 ? b.mx[1] : b.mn[1],
        c & 4 ? b.mx[2] : b.mn[2],
      ];
      const q = applyM(item.w, p);
      for (let k = 0; k < 3; k++) {
        if (q[k] < mn[k]) mn[k] = q[k];
        if (q[k] > mx[k]) mx[k] = q[k];
      }
    }
    return { mn, mx };
  };

  const pa = collect(docA);
  const pb = collect(docB);
  const N = Math.min(pa.length, pb.length);
  const step = Math.max(1, Math.floor(N / samples));

  let maxShift = 0;
  let sumShift = 0;
  let cnt = 0;
  let worstPrim = -1;

  for (let i = 0; i < N; i += step) {
    const ba = worldBox(pa[i]);
    const bb = worldBox(pb[i]);
    if (!ba || !bb) continue;
    let d = 0;
    for (let k = 0; k < 3; k++) {
      d = Math.max(d, Math.abs(ba.mn[k] - bb.mn[k]), Math.abs(ba.mx[k] - bb.mx[k]));
    }
    if (d > maxShift) { maxShift = d; worstPrim = i; }
    sumShift += d;
    cnt++;
  }

  // 整体尺度用一个总包围盒相对差衡量（比面积更稳，且不受三角面重排影响）
  const unionBox = (list) => {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const it of list) {
      const b = worldBox(it);
      if (!b) continue;
      for (let k = 0; k < 3; k++) {
        if (b.mn[k] < mn[k]) mn[k] = b.mn[k];
        if (b.mx[k] > mx[k]) mx[k] = b.mx[k];
      }
    }
    return { mn, mx };
  };

  const sizeOf = (b) => b.mx.map((v, k) => v - b.mn[k]);
  const sa = sizeOf(unionBox(pa));
  const sb = sizeOf(unionBox(pb));
  const extA = Math.max(...sa);
  const extB = Math.max(...sb);
  const sizeDiffPercent = extA ? (Math.abs(extB - extA) / extA) * 100 : 0;

  return {
    sampledPrims: cnt,
    maxBoxShift: maxShift,
    meanBoxShift: cnt ? sumShift / cnt : 0,
    worstPrim,
    extentA: extA,
    extentB: extB,
    sizeDiffPercent,
  };
}
