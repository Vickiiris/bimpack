/**
 * verify.mjs —— 交付前的质量闸门，两段式：
 *
 *   1) compareJSON()     纯 JSON 比对，不解码几何（秒级）
 *                        核的是"该保留的东西一样没少"：节点名、层级、extras、变换、材质、材质绑定、面数、扩展
 *   2) compareGeometry() 解码后逐顶点比对（重，可选）
 *                        核的是"改动的幅度可接受"：位置偏差、表面积偏差
 *
 * 任何一项 JSON 比对失败，都不应该把文件交出去。
 */
import { readJSON } from './glb.mjs';

const canon = (v) => JSON.stringify(v, (k, val) => {
  // 键序稳定化：对象按 key 排序，数组保持原序
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return Object.keys(val).sort().reduce((o, k) => ((o[k] = val[k]), o), {});
  }
  return val;
});

/** 数值等价判断（相对误差），用于材质/变换 */
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

/** 四元数 → 3x3 行主序 */
function quatToMat3(q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** 节点 → 4x4（列主序，glTF 约定）。matrix 与 TRS 两种写法统一到这里比较 */
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
 * 两个变换矩阵的"形状差异"用几何量衡量：把单位立方体的角点分别变换，
 * 取最大空间位移（模型单位）。比逐元素比矩阵靠谱得多 ——
 * 逐元素在 157 米量级的平移上会误判 float32 四元数往返噪声，
 * 而角点位移能真实反映"构件会不会错位"，也能抓住剪切（shear）这种 TRS 表达不出来的矩阵。
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

/**
 * JSON 层比对
 * @param {object} opts { transformTolerance } 角点位移容差，单位同模型（mm 模型默认 0.01 即 10µm）
 * @returns {{ pass: boolean, rows: Array<{ok:boolean,label:string,a:any,b:any}>, info: object }}
 */
export function compareJSON(bufA, bufB, opts = {}) {
  const tol = opts.transformTolerance ?? 0.01;
  const A = readJSON(bufA);
  const B = readJSON(bufB);
  const rows = [];
  const add = (ok, label, a = '', b = '') => rows.push({ ok, label, a, b });

  const nA = A.nodes || [];
  const nB = B.nodes || [];
  const primsA = (A.meshes || []).flatMap((m) => m.primitives || []);
  const primsB = (B.meshes || []).flatMap((m) => m.primitives || []);
  const triOf = (J) => (J.meshes || []).reduce((s, m) => s + (m.primitives || []).reduce(
    (t, p) => t + (p.indices !== undefined ? Math.floor((J.accessors[p.indices]?.count || 0) / 3) : 0), 0), 0);
  const vertOf = (J) => (J.meshes || []).reduce((s, m) => s + (m.primitives || []).reduce(
    (t, p) => t + (J.accessors[p.attributes?.POSITION]?.count || 0), 0), 0);

  add(nA.length === nB.length, '节点数', nA.length, nB.length);
  add((A.meshes || []).length === (B.meshes || []).length, '网格数', (A.meshes || []).length, (B.meshes || []).length);
  add(primsA.length === primsB.length, '图元数', primsA.length, primsB.length);
  add((A.materials || []).length === (B.materials || []).length, '材质数', (A.materials || []).length, (B.materials || []).length);
  add((A.scenes || []).length === (B.scenes || []).length, '场景数');
  add(
    JSON.stringify(A.scenes?.[0]?.nodes || []) === JSON.stringify(B.scenes?.[0]?.nodes || []),
    '场景根节点列表'
  );

  // 名称 / 层级
  const namesA = nA.map((n) => n.name ?? '');
  const namesB = nB.map((n) => n.name ?? '');
  add(JSON.stringify(namesA) === JSON.stringify(namesB), '节点名称逐项一致');
  add(
    JSON.stringify(nA.map((n) => n.children || [])) === JSON.stringify(nB.map((n) => n.children || [])),
    '节点父子层级一致'
  );

  // extras —— BIM 属性的核心指标
  const extrasOf = (arr) => arr.map((n) => canon(n.extras || {})).join('\u0000');
  add(extrasOf(nA) === extrasOf(nB), '节点 extras 指纹（SHA 级逐条一致）');
  const withExtrasA = nA.filter((n) => n.extras && Object.keys(n.extras).length).length;
  const withExtrasB = nB.filter((n) => n.extras && Object.keys(n.extras).length).length;
  add(withExtrasA === withExtrasB, '含属性节点数', withExtrasA, withExtrasB);
  const propCount = (arr) => arr.reduce((s, n) => s + Object.keys(n.extras || {}).length, 0);
  add(propCount(nA) === propCount(nB), '属性条目总数', propCount(nA), propCount(nB));
  add(
    JSON.stringify((A.meshes || []).map((m) => canon(m.extras || {}))) ===
      JSON.stringify((B.meshes || []).map((m) => canon(m.extras || {}))),
    '网格 extras 一致'
  );

  // 变换：允许 matrix ↔ TRS 改写，但"构件会不会错位"必须在容差内
  let maxDisp = 0;
  let worstNode = -1;
  for (let i = 0; i < Math.min(nA.length, nB.length); i++) {
    const d = transformDisplacement(nodeMatrix(nA[i]), nodeMatrix(nB[i]));
    if (d > maxDisp) { maxDisp = d; worstNode = i; }
  }
  add(
    maxDisp <= tol,
    '变换等价（角点最大位移）',
    `${maxDisp.toExponential(2)} 单位`,
    `容差 ${tol}` + (maxDisp > tol ? ` · 节点#${worstNode} ${nA[worstNode]?.name ?? ''}` : '')
  );

  // 材质：只比数值，不比 JSON 文本（1 与 1.0 是不同的字符串，但是同一个数）
  let badMat = 0;
  const mA = A.materials || [];
  const mB = B.materials || [];
  for (let i = 0; i < Math.min(mA.length, mB.length); i++) if (!numClose(mA[i], mB[i])) badMat++;
  add(badMat === 0 && mA.length === mB.length, '材质定义数值等价', badMat ? `${badMat} 个差异` : '0 差异');

  add(
    JSON.stringify(primsA.map((p) => p.material ?? -1)) === JSON.stringify(primsB.map((p) => p.material ?? -1)),
    '每图元材质绑定一致'
  );

  add(triOf(A) === triOf(B), '三角面数', triOf(A), triOf(B));
  const vA = vertOf(A);
  const vB = vertOf(B);
  // 顶点数允许变化：Draco 对非流形边会拆点，位置相同，不影响外形
  rows.push({ ok: true, label: '顶点数（Draco 重构后可变）', a: vA, b: vB });

  // 扩展
  const setOf = (x) => [...new Set(x || [])].sort().join(', ');
  // 首次压缩必然会新增 KHR_draco_mesh_compression —— 这是预期行为，不能算失败。
  // 判据：输出必须是输入的超集，且新增项只允许是 Draco。
  const reqA = new Set(A.extensionsRequired || []);
  const reqB = new Set(B.extensionsRequired || []);
  const missing = [...reqA].filter((x) => !reqB.has(x));
  const added = [...reqB].filter((x) => !reqA.has(x));
  const addedBad = added.filter((x) => x !== 'KHR_draco_mesh_compression');
  add(
    missing.length === 0 && addedBad.length === 0,
    'extensionsRequired（输出应为超集）',
    setOf(A.extensionsRequired) || '（无）',
    setOf(B.extensionsRequired) + (added.length ? `  (+${added.join(', ')})` : '')
  );
  add(
    JSON.stringify((A.materials || []).map((m) => canon(m.extensions || {}))) ===
      JSON.stringify((B.materials || []).map((m) => canon(m.extensions || {}))),
    '材质扩展（volume/transmission 等）保留'
  );

  return {
    pass: rows.every((r) => r.ok),
    rows,
    info: { verticesA: vA, verticesB: vB, triangles: triOf(A), maxTransformDisplacement: maxDisp },
  };
}

/**
 * 几何比对：解码后抽样逐顶点算偏差
 * @param {object} io         getIO() 的实例
 * @param {Buffer} bufA/B
 * @param {number} samples    抽样图元数（越多越准越慢）
 */
export async function compareGeometry(io, bufA, bufB, samples = 350) {
  const docA = await io.readBinary(new Uint8Array(bufA));
  const docB = await io.readBinary(new Uint8Array(bufB));

  const collect = (doc) => {
    const out = [];
    for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) out.push(prim);
    return out;
  };
  const pa = collect(docA);
  const pb = collect(docB);
  const N = Math.min(pa.length, pb.length);
  const step = Math.max(1, Math.floor(N / samples));

  let maxDev = 0;
  let sumDev = 0;
  let cnt = 0;
  let areaA = 0;
  let areaB = 0;
  let worst = -1;

  const surface = (pos, idx) => {
    let s = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      s += Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;
    }
    return s;
  };

  for (let i = 0; i < N; i += step) {
    const A = pa[i], B = pb[i];
    const attrA = A.getAttribute('POSITION');
    const attrB = B.getAttribute('POSITION');
    if (!attrA || !attrB) continue;
    const posA = attrA.getArray();
    const posB = attrB.getArray();
    const idxA = A.getIndices()?.getArray() || [];
    const idxB = B.getIndices()?.getArray() || [];
    areaA += surface(posA, idxA);
    areaB += surface(posB, idxB);

    const nB = posB.length / 3;
    for (let v = 0; v < posA.length; v += 3) {
      const x = posA[v], y = posA[v + 1], z = posA[v + 2];
      let best = Infinity;
      for (let w = 0; w < nB; w++) {
        const dx = x - posB[w * 3], dy = y - posB[w * 3 + 1], dz = z - posB[w * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
      const d = Math.sqrt(best);
      if (d > maxDev) { maxDev = d; worst = i; }
      sumDev += d;
      cnt++;
    }
  }

  return {
    sampledPrims: Math.ceil(N / step),
    sampledVertices: cnt,
    maxDeviation: maxDev,
    meanDeviation: cnt ? sumDev / cnt : 0,
    worstPrim: worst,
    areaA,
    areaB,
    areaDiffPercent: areaA ? Math.abs(areaB - areaA) / areaA * 100 : 0,
  };
}
