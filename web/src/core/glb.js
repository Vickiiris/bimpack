/**
 * glb.js —— GLB 容器的字节级读写（浏览器版，零依赖）
 *
 * 为什么需要这一层：3ds Max 的 Khronos glTF 导出器会写出 `asset.version: "2.1"`，
 * 而 glTF 规范只允许 "2.0"。glTF-Transform / three.GLTFLoader 遇到 "2.1" 会直接拒绝加载。
 * 所以必须在进解析器之前，先按字节把版本号改掉。
 */

const MAGIC_GLTF = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/** 拆出 GLB 的各个 chunk（只做结构解析，不解析 JSON 内容） */
export function parseGLB(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC_GLTF) throw new Error('不是合法的 GLB 文件（magic 不匹配）');

  const version = view.getUint32(4, true);
  const total = view.getUint32(8, true);
  const chunks = [];
  let off = 12;
  const limit = Math.min(total, bytes.byteLength);
  while (off + 8 <= limit) {
    const length = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    chunks.push({ type, length, start: off + 8 });
    off += 8 + length;
  }
  const jsonChunk = chunks.find((c) => c.type === CHUNK_JSON);
  const binChunk = chunks.find((c) => c.type === CHUNK_BIN);
  return {
    version,
    total,
    chunks,
    jsonBytes: jsonChunk ? bytes.subarray(jsonChunk.start, jsonChunk.start + jsonChunk.length) : null,
    binBytes: binChunk ? bytes.subarray(binChunk.start, binChunk.start + binChunk.length) : new Uint8Array(0),
    jsonLength: jsonChunk ? jsonChunk.length : 0,
    binLength: binChunk ? binChunk.length : 0,
  };
}

/** 只读 JSON，不解码二进制 —— 做属性体检/校验时用这个，200MB 文件也是秒级 */
export function readJSON(bytes) {
  const { jsonBytes } = parseGLB(bytes);
  if (!jsonBytes) throw new Error('GLB 缺少 JSON chunk');
  return JSON.parse(decoder.decode(jsonBytes));
}

/** 按 glTF 规范重新拼装 GLB（JSON 用空格补齐到 4 字节，BIN 用 0 补齐） */
export function writeGLB(json, binBytes) {
  let jsonBuf = encoder.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBuf.length + jsonPad).fill(0x20);
    padded.set(jsonBuf);
    jsonBuf = padded;
  }

  let binBuf = binBytes && binBytes.length ? binBytes : null;
  if (binBuf) {
    const binPad = (4 - (binBuf.length % 4)) % 4;
    if (binPad) {
      const padded = new Uint8Array(binBuf.length + binPad);
      padded.set(binBuf);
      binBuf = padded;
    }
  }

  const total = 12 + 8 + jsonBuf.length + (binBuf ? 8 + binBuf.length : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC_GLTF, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBuf.length, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBuf, 20);

  if (binBuf) {
    const binHead = 20 + jsonBuf.length;
    view.setUint32(binHead, binBuf.length, true);
    view.setUint32(binHead + 4, CHUNK_BIN, true);
    out.set(binBuf, binHead + 8);
  }
  return out;
}

/**
 * glTF 规范里**没有 null**，但导出器照样会写：3ds Max / 部分插件会留下
 * `"targets": null`（图元的形变目标）、`"weights": null`（节点的形变权重）这类字段。
 *
 * three.js 的 GLTFLoader 在这些地方用 `!== undefined` 判断，null 会被当成「有值」，
 * 接着直接 `null.length` —— 抛出的就是那句看不出所以然的
 * `Cannot read properties of null (reading 'length')`，整个文件加载失败。
 *
 * 所以进解析器之前把 extras 之外的 null 全部删掉：删掉 = 回落到规范的默认值，
 * 比留着 null 更接近规范。`extras` 是 BIM 属性，里面可能真有用户写的 null，必须原样保留。
 */
function pruneNulls(node, stats) {
  if (Array.isArray(node)) {
    for (const v of node) pruneNulls(v, stats);
    return;
  }
  if (!node || typeof node !== 'object') return;

  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val === null) {
      delete node[key];
      stats.count++;
      stats.keys.add(key);
      continue;
    }
    if (key === 'extras') continue;   // 用户属性，连 null 也照原样留着
    pruneNulls(val, stats);
  }
}

/**
 * 引用型数组（场景的根节点、子节点、关节、图元、形变目标）里的 null 也要剔除。
 * 只对这类「纯引用列表」动手 —— 像 nodes / meshes / accessors 这种**按下标被引用**的数组，
 * 删元素会整体错位，绝对不能碰。
 */
function pruneRefList(list, stats) {
  if (!Array.isArray(list)) return;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] === null) {
      list.splice(i, 1);
      stats.count++;
    }
  }
}

/**
 * 进解析器前的字节级准备：修 asset.version + 清掉非法的 null 字段 + 补空的 primitives。
 * 都不动二进制，只在必要时重写 JSON chunk；没改动就原样返回（零拷贝）。
 *
 * @returns {{ bytes: Uint8Array, changed: boolean, from: string,
 *             removedNulls: number, nullKeys: string[] }}
 */
export function prepareGLB(bytes) {
  const { jsonBytes, binBytes } = parseGLB(bytes);
  const json = JSON.parse(decoder.decode(jsonBytes));

  const from = json.asset?.version;
  let changed = from !== '2.0';
  if (changed) json.asset = { ...(json.asset || {}), version: '2.0' };

  const stats = { count: 0, keys: new Set() };
  pruneNulls(json, stats);

  // 数组里的 null（引用型列表）
  for (const s of json.scenes || []) pruneRefList(s?.nodes, stats);
  for (const n of json.nodes || []) {
    pruneRefList(n?.children, stats);
    pruneRefList(n?.weights, stats);
  }
  for (const sk of json.skins || []) pruneRefList(sk?.joints, stats);
  for (const m of json.meshes || []) {
    // 没有任何 primitives 的 mesh 也是非法的（规范要求 minItems 1）。
    // three 会直接 `primitives.length` 崩掉；补成空数组后它退化成一个空 Group，
    // 后面的批处理会自然跳过 —— 一个坏图元不该让整层楼都打不开。
    if (m && !Array.isArray(m.primitives)) {
      m.primitives = [];
      stats.count++;
      continue;
    }
    pruneRefList(m?.primitives, stats);
    for (const p of m?.primitives || []) pruneRefList(p?.targets, stats);
  }

  if (!changed && !stats.count) {
    return { bytes, changed: false, from, removedNulls: 0, nullKeys: [] };
  }
  return {
    bytes: writeGLB(json, binBytes),
    changed: true,
    from,
    removedNulls: stats.count,
    nullKeys: [...stats.keys],
  };
}

/** 兼容旧名：等价于 prepareGLB */
export const fixAssetVersion = prepareGLB;

/** 给 Uint8Array 生成可下载的 Blob */
export function toBlob(bytes, mime = 'model/gltf-binary') {
  return new Blob([bytes], { type: mime });
}

/** 触发浏览器下载 */
export function download(bytes, filename, mime) {
  const url = URL.createObjectURL(toBlob(bytes, mime));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
