/**
 * process.js —— 浏览器端处理流水线：修版本 → 几何压缩（meshopt）→ 输出字节
 *
 * 编码器选择（重要）：
 *   Draco 的浏览器编码器只有 asm.js 版（官方 npm 只发 Node glue），
 *   实测在 Chrome 157 里初始化即让渲染进程崩溃，换参数无效 → 改用 meshopt。
 *   meshopt 的 wasm 内联在 19KB 的 js 里，自包含、浏览器原生可用，
 *   three.js 的 GLTFLoader 原生支持 EXT_meshopt_compression。
 *   体积效果与 Draco 接近（同为「量化 + 熵编码」路线），代价是输出扩展名不同。
 *
 * 只做「几何重编码」一件事：不 weld、不 simplify、不 prune、不 join。
 * 任何拓扑或图元结构的改动都会破坏 BIM 构件的一一对应关系，这是属性零丢失的前提。
 */
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { reorder } from '@gltf-transform/functions';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { loadDracoDecoder } from './draco.js';
import { parseGLB, readJSON } from './glb.js';

/** 三档预设：位深越高越保真；level 决定 meshopt 的编码模式 */
// 编码方式：reorder(按空间局部性重排顶点) + EXT_meshopt_compression 的 FILTER 模式。
// FILTER 对 Float32 顶点做 delta/预测编码，没有"位深档位"可调 —— 压缩率由数据本身决定，
// 所以这里不再有 high/balance/small 三档量化预设（那套只在 quantize 路线下有意义）。
export const PRESETS = { standard: {} };

let ioPromise = null;

export async function getIO(onProgress = () => {}) {
  if (ioPromise) return ioPromise;
  ioPromise = (async () => {
    // decoder 只为了能读入「源文件本身已是 Draco」的情况；纯未压缩文件用不到
    const decoder = await loadDracoDecoder(onProgress);
    onProgress('初始化 meshopt 编码器…');
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);

    return new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'draco3d.decoder': decoder,
      'meshopt.encoder': MeshoptEncoder,
      'meshopt.decoder': MeshoptDecoder,
    });
  })();
  ioPromise.catch(() => { ioPromise = null; });
  return ioPromise;
}

/** 体检：只解析 JSON chunk，不解码二进制（200MB 文件也是毫秒级） */
export function inspect(bytes) {
  const { total, jsonLength, binLength, version } = parseGLB(bytes);
  const json = readJSON(bytes);
  const prims = (json.meshes || []).flatMap((m) => m.primitives || []);
  const verts = prims.reduce((s, p) => s + (json.accessors?.[p.attributes?.POSITION]?.count || 0), 0);
  const tris = prims.reduce(
    (s, p) => s + (p.indices !== undefined ? Math.floor((json.accessors?.[p.indices]?.count || 0) / 3) : 0), 0);
  const extrasKeys = new Set();
  let propEntries = 0;
  for (const n of json.nodes || []) {
    const e = n.extras || {};
    for (const k of Object.keys(e)) extrasKeys.add(k);
    propEntries += Object.keys(e).length;
  }
  const req = json.extensionsRequired || [];
  return {
    version,
    gltfVersion: json.asset?.version ?? '(缺失)',
    generator: json.asset?.generator ?? '',
    total,
    jsonLength,
    binLength,
    nodes: (json.nodes || []).length,
    meshes: (json.meshes || []).length,
    primitives: prims.length,
    materials: (json.materials || []).length,
    textures: (json.textures || []).length,
    vertices: verts,
    triangles: tris,
    hasDraco: req.includes('KHR_draco_mesh_compression'),
    hasMeshopt: req.includes('EXT_meshopt_compression'),
    compressed: req.includes('KHR_draco_mesh_compression') || req.includes('EXT_meshopt_compression'),
    extensions: json.extensionsUsed || [],
    extrasKeys: extrasKeys.size,
    propEntries,
    materialGroups: new Set(prims.map((p) => p.material ?? -1)).size,
  };
}

/**
 * 几何压缩
 * @param {Uint8Array} bytes 已修过 asset.version 的 GLB
 * @param {{preset?:string, onProgress?:(m:string)=>void}} opts
 */
export async function compressGeometry(bytes, opts = {}) {
  const { preset = 'standard', onProgress = () => {} } = opts;
  const params = { ...(PRESETS[preset] || PRESETS.standard) };

  const io = await getIO(onProgress);

  onProgress('解析 glTF 文档…');
  const doc = await io.readBinary(bytes);

  // 源文件若是 Draco 压缩的：读入时几何已经被解码到内存，但扩展还挂在文档上，
  // 写回时它会索要 draco3d.encoder 重新编码 —— 而浏览器里没有可用的 Draco 编码器。
  // 所以显式摘掉这个扩展，随后用 meshopt 重新压。几何数据本身不受影响。
  let droppedDraco = false;
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression') {
      ext.dispose();
      droppedDraco = true;
    }
  }
  if (droppedDraco) onProgress('源文件是 Draco 压缩的，已摘除其扩展（几何已在内存，改用 meshopt 重压）');

  onProgress('重排 + 熵编码几何…');

  // 刻意不走 gltf-transform 的 meshopt()：它内部强制调 quantize()，
  // 而 quantize 会对每个 mesh 做 transformMeshMaterials(mesh, 1/nodeScale)，
  // 把 KHR_materials_volume.thicknessFactor 按节点缩放改写（0.2 → 0.00024），
  // 共用材质还会被克隆出多份 —— 与"材质外观不损失"直接冲突。
  // 这里只做 reorder + FILTER 编码：顶点保持 Float32，材质与节点变换原封不动。
  await doc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }));

  const ext = doc.createExtension(EXTMeshoptCompression);
  ext.setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });

  onProgress('写回 GLB…');
  const out = await io.writeBinary(doc);

  // Document 握着全部几何数组，不 dispose 会一直占着几百 MB
  try { doc.dispose(); } catch { /* 旧版本没有 dispose */ }

  return { bytes: out, params };
}

/** 当前 JS 堆用量（MB），Chrome 才有意义 */
export function heapMB() {
  const m = performance.memory;
  return m ? m.usedJSHeapSize / 1048576 : null;
}
