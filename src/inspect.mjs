/**
 * inspect.mjs —— 体检：在压缩/交付之前，先把这份 GLB 的底细摸清楚
 *
 * 只读 JSON chunk，不碰二进制，200MB 的文件也是秒级。
 * 输出既是给人看的报告，也是后面 build 流程的决策依据（比如要不要修版本号、要不要二次压）。
 */
import { readJSON, parseGLB } from './glb.mjs';

const ACC_COMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const ACC_NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** 估算 accessor 未压缩时的字节数（用来对比 Draco 的压缩率） */
function rawAccessorBytes(accessors) {
  let sum = 0;
  for (const a of accessors || []) {
    const comp = ACC_COMP[a.componentType] || 4;
    const num = ACC_NUM[a.type] || 1;
    sum += (a.count || 0) * comp * num;
  }
  return sum;
}

export function inspect(buf, filePath = '') {
  const json = readJSON(buf);
  const { total, jsonLength, binLength } = parseGLB(buf);
  const nodes = json.nodes || [];
  const meshes = json.meshes || [];
  const materials = json.materials || [];
  const accessors = json.accessors || [];
  const prims = meshes.flatMap((m) => m.primitives || []);

  // ---- 几何规模 ----
  let vertices = 0;
  let triangles = 0;
  let uvPrims = 0;
  let dracoPrims = 0;
  for (const p of prims) {
    const pos = p.attributes?.POSITION;
    if (pos !== undefined) vertices += accessors[pos]?.count || 0;
    if (p.indices !== undefined) triangles += Math.floor((accessors[p.indices]?.count || 0) / 3);
    if (p.attributes?.TEXCOORD_0 !== undefined) uvPrims++;
    if (p.extensions?.KHR_draco_mesh_compression) dracoPrims++;
  }

  // ---- 按材质的批次分组（直接决定 three.js 的 draw call 数）----
  const byMat = new Map();
  for (const n of nodes) {
    if (n.mesh === undefined) continue;
    const mesh = meshes[n.mesh];
    if (!mesh) continue;
    for (const p of mesh.primitives || []) {
      const mi = p.material ?? -1;
      let rec = byMat.get(mi);
      if (!rec) {
        rec = {
          material: mi,
          name: materials[mi]?.name ?? '(无材质)',
          geometryCount: 0,
          vertices: 0,
          indices: 0,
          uvPrims: 0,
        };
        byMat.set(mi, rec);
      }
      rec.geometryCount++;
      rec.vertices += accessors[p.attributes?.POSITION]?.count || 0;
      rec.indices += accessors[p.indices]?.count || 0;
      if (p.attributes?.TEXCOORD_0 !== undefined) rec.uvPrims++;
    }
  }
  const batches = [...byMat.values()].sort((a, b) => b.geometryCount - a.geometryCount);

  // ---- BIM 属性（extras）----
  let nodesWithExtras = 0;
  let propEntries = 0;
  let extrasBytes = 0;
  let keyBytes = 0;
  const keys = new Set();
  const blobSet = new Set();
  for (const n of nodes) {
    if (!n.extras || typeof n.extras !== 'object') continue;
    nodesWithExtras++;
    const s = JSON.stringify(n.extras);
    extrasBytes += Buffer.byteLength(s, 'utf8');
    blobSet.add(s);
    for (const [k, v] of Object.entries(n.extras)) {
      propEntries++;
      keys.add(k);
      keyBytes += Buffer.byteLength(JSON.stringify(k) + ':', 'utf8');
    }
  }

  // ---- 包围盒（用 accessor 的 min/max，注意这是局部坐标）----
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    const a = accessors[p.attributes?.POSITION];
    if (!a?.min || !a?.max) continue;
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], a.min[i]);
      max[i] = Math.max(max[i], a.max[i]);
    }
  }
  const extent = min[0] === Infinity ? [0, 0, 0] : [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

  // ---- 警告：这些是踩过的坑，逐条显式提示 ----
  const warnings = [];
  const ver = json.asset?.version;
  if (ver !== '2.0') {
    warnings.push(`asset.version = "${ver}" 不是合法 glTF 值（规范只允许 "2.0"），多数加载器会直接拒绝加载 → build 会自动修正`);
  }
  if (dracoPrims > 0) {
    warnings.push(
      `源文件已含 KHR_draco_mesh_compression（${dracoPrims}/${prims.length} 图元）→ 再压属于二次编码，属"二代有损"，需提高量化位深`
    );
  }
  if (propEntries === 0) {
    warnings.push('节点 extras 为空 —— 这不是 BIM 导出（或属性被剥掉了），压缩后也无属性可保');
  }
  if ((json.textures || []).length > 0 && uvPrims < prims.length) {
    warnings.push(`存在贴图，但只有 ${uvPrims}/${prims.length} 个图元带 UV → 批处理时必须保留 UV 且给缺失的补空 UV`);
  }
  if ((json.textures || []).length === 0 && uvPrims > 0) {
    warnings.push(`无贴图但 ${uvPrims} 个图元带 UV → viewer 批处理可安全剥离 UV 以统一属性集合`);
  }
  if (prims.length > 2000) {
    warnings.push(`图元数 ${prims.length} → three.js 里就是 ${prims.length} 次 draw call，必须批处理（见 viewer/bim-batch.js）`);
  }
  if (materials.length > batches.length) {
    warnings.push(`材质表 ${materials.length} 条，实际被引用 ${batches.length} 条 → 批处理按 ${batches.length} 组分，不要按材质表长度估算`);
  }

  const rawGeoBytes = rawAccessorBytes(accessors);

  return {
    file: filePath,
    total,
    jsonLength,
    binLength,
    asset: json.asset || {},
    extensionsUsed: json.extensionsUsed || [],
    extensionsRequired: json.extensionsRequired || [],
    alreadyDraco: dracoPrims > 0,
    dracoPrims,
    counts: {
      scenes: (json.scenes || []).length,
      nodes: nodes.length,
      nodesWithoutMesh: nodes.filter((n) => n.mesh === undefined).length,
      meshes: meshes.length,
      primitives: prims.length,
      materials: materials.length,
      materialGroups: batches.length,
      textures: (json.textures || []).length,
      images: (json.images || []).length,
      accessors: accessors.length,
      animations: (json.animations || []).length,
      skins: (json.skins || []).length,
    },
    geometry: {
      vertices,
      triangles,
      uvPrims,
      rawAccessorBytes: rawGeoBytes,
      binBytes: binLength,
      bytesPerVertex: vertices ? +(binLength / vertices).toFixed(2) : 0,
    },
    bbox: { min: min[0] === Infinity ? null : min, max: max[0] === Infinity ? null : max, extent },
    extras: {
      nodesWithExtras,
      propEntries,
      distinctKeys: keys.size,
      extrasBytes,
      keyBytes,
      percentOfJSON: jsonLength ? +((extrasBytes / jsonLength) * 100).toFixed(1) : 0,
      uniqueBlobs: blobSet.size,
    },
    batches,
    warnings,
  };
}
