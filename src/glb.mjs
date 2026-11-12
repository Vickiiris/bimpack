/**
 * glb.mjs —— GLB 容器的字节级读写（不依赖任何第三方库）
 *
 * 为什么需要这一层：3ds Max 的 Khronos glTF 导出器会写出 `asset.version: "2.1"`，
 * 而 glTF 规范只允许 "2.0"。glTF-Transform / three.GLTFLoader 遇到 "2.1" 会直接拒绝加载。
 * 所以必须在进解析器之前，先按字节把版本号改掉。
 */

const MAGIC_GLTF = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** 拆出 GLB 的各个 chunk（只做结构解析，不解析 JSON 内容） */
export function parseGLB(buf) {
  if (buf.readUInt32LE(0) !== MAGIC_GLTF) throw new Error('不是合法的 GLB 文件（magic 不匹配）');
  const version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  const chunks = [];
  let off = 12;
  while (off + 8 <= Math.min(total, buf.length)) {
    const length = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    chunks.push({ type, length, start: off + 8 });
    off += 8 + length;
  }
  const jsonChunk = chunks.find((c) => c.type === CHUNK_JSON);
  const binChunk = chunks.find((c) => c.type === CHUNK_BIN);
  return {
    version,
    total,
    chunks,
    jsonBytes: jsonChunk ? buf.subarray(jsonChunk.start, jsonChunk.start + jsonChunk.length) : null,
    binBytes: binChunk ? buf.subarray(binChunk.start, binChunk.start + binChunk.length) : Buffer.alloc(0),
    jsonLength: jsonChunk ? jsonChunk.length : 0,
    binLength: binChunk ? binChunk.length : 0,
  };
}

/** 只读 JSON，不解码二进制 —— 做属性体检/校验时用这个，200MB 文件也是秒级 */
export function readJSON(buf) {
  const { jsonBytes } = parseGLB(buf);
  if (!jsonBytes) throw new Error('GLB 缺少 JSON chunk');
  return JSON.parse(jsonBytes.toString('utf8'));
}

/** 按 glTF 规范重新拼装 GLB（JSON 用空格补齐到 4 字节，BIN 用 0 补齐） */
export function writeGLB(json, binBytes) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);

  let binBuf = binBytes && binBytes.length ? Buffer.from(binBytes) : null;
  if (binBuf) {
    const binPad = (4 - (binBuf.length % 4)) % 4;
    if (binPad) binBuf = Buffer.concat([binBuf, Buffer.alloc(binPad, 0x00)]);
  }

  const total = 12 + 8 + jsonBuf.length + (binBuf ? 8 + binBuf.length : 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC_GLTF, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);

  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonBuf.length, 0);
  jsonHead.writeUInt32LE(CHUNK_JSON, 4);

  const parts = [head, jsonHead, jsonBuf];
  if (binBuf) {
    const binHead = Buffer.alloc(8);
    binHead.writeUInt32LE(binBuf.length, 0);
    binHead.writeUInt32LE(CHUNK_BIN, 4);
    parts.push(binHead, binBuf);
  }
  return Buffer.concat(parts);
}

/**
 * 把 asset.version 修正为标准值 "2.0"
 * @returns {{ buf: Buffer, changed: boolean, from: string }}
 */
export function fixAssetVersion(buf) {
  const { jsonBytes, binBytes } = parseGLB(buf);
  const json = JSON.parse(jsonBytes.toString('utf8'));
  const from = json.asset?.version;
  if (from === '2.0') return { buf, changed: false, from };

  json.asset = json.asset || {};
  json.asset.version = '2.0';
  return { buf: writeGLB(json, binBytes), changed: true, from };
}

/** 从文件读，顺手给出基础信息 */
export function loadGLB(filePath, fs) {
  const buf = fs.readFileSync(filePath);
  const { jsonBytes, binBytes, total } = parseGLB(buf);
  return { buf, total, jsonLength: jsonBytes.length, binLength: binBytes.length };
}
