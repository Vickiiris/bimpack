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
 * 把 asset.version 修正为标准值 "2.0"（不动二进制，只重写 JSON chunk）
 * @returns {{ bytes: Uint8Array, changed: boolean, from: string }}
 */
export function fixAssetVersion(bytes) {
  const { jsonBytes, binBytes } = parseGLB(bytes);
  const json = JSON.parse(decoder.decode(jsonBytes));
  const from = json.asset?.version;
  if (from === '2.0') return { bytes, changed: false, from };

  json.asset = { ...(json.asset || {}), version: '2.0' };
  return { bytes: writeGLB(json, binBytes), changed: true, from };
}

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
