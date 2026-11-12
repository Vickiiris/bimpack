/**
 * sanitize.mjs —— prepareGLB 的回归：非法 null / 空 primitives 的清理
 *
 *   node test/sanitize.mjs
 *
 * 背景：3ds Max 之类的导出器会写出 `"targets": null`、`"weights": null`。
 * three.js 的 GLTFLoader 用 `!== undefined` 判空，null 会一路走到 `null.length`，
 * 抛出一句看不出原因的错误，整个模型打不开。所以进解析器前必须清掉。
 *
 * 断言：
 *   1. extras 之外的 null 全部消失（含数组里的 null）
 *   2. extras 里的 null 原样保留（那是 BIM 用户属性）
 *   3. asset.version 统一成 2.0
 *   4. 没有 primitives 的 mesh 被补成 []
 *   5. 干净的 2.0 文件不被改写（changed = false，字节原样返回）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGLB, writeGLB, prepareGLB } from '../src/core/glb.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const raw = new Uint8Array(fs.readFileSync(path.join(HERE, '../../test/fixture.glb')));
const baseJson = JSON.parse(new TextDecoder().decode(parseGLB(raw).jsonBytes));
const bin = parseGLB(raw).binBytes;

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, extra); }
};

/** 造一个变体：mutate(json) 之后重新拼 GLB */
function variant(mutate) {
  const json = structuredClone(baseJson);
  mutate(json);
  return writeGLB(json, bin);
}

/** 递归找 null（跳过 extras 子树），返回命中的 key 路径 */
function findNulls(node, at = '', out = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => { if (v === null) out.push(`${at}[${i}]`); else findNulls(v, `${at}[${i}]`, out); });
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'extras') continue;
    if (v === null) out.push(`${at}.${k}`);
    else findNulls(v, `${at}.${k}`, out);
  }
  return out;
}

const roundTrip = (bytes) => JSON.parse(new TextDecoder().decode(parseGLB(bytes).jsonBytes));

console.log('\n— 清掉非法 null —');
{
  const bytes = variant((j) => {
    j.nodes[0].weights = null;
    j.meshes[0].weights = null;
    j.meshes[0].primitives[0].targets = null;
    j.meshes[0].primitives[0].material = null;
    j.scenes[0].nodes[0] = j.scenes[0].nodes[0]; // 保留有效项
    j.nodes[0].extras = { ...(j.nodes[0].extras || {}), 备注: null };  // 这条必须留着
  });
  const r = prepareGLB(bytes);
  const j = roundTrip(r.bytes);
  check(r.changed === true, '报告有改动');
  check(r.removedNulls >= 4, `统计到 ${r.removedNulls} 处 null`);
  check(findNulls(j).length === 0, 'extras 之外没有 null 了', findNulls(j).join(','));
  check(j.nodes[0].extras?.备注 === null, 'extras 里的 null 原样保留');
  check(j.asset.version === '2.0', 'asset.version = 2.0');
}

console.log('\n— 空 primitives 的 mesh —');
{
  const r = prepareGLB(variant((j) => { j.meshes[0].primitives = null; }));
  const j = roundTrip(r.bytes);
  check(Array.isArray(j.meshes[0].primitives) && j.meshes[0].primitives.length === 0, '补成空数组');
}

console.log('\n— 数组里的 null —');
{
  const r = prepareGLB(variant((j) => { j.scenes[0].nodes.push(null); }));
  const j = roundTrip(r.bytes);
  check(!j.scenes[0].nodes.includes(null), '数组元素 null 被剔除');
}

console.log('\n— 干净的 2.0 文件不重写 —');
{
  const clean = variant((j) => { j.asset.version = '2.0'; });
  const r = prepareGLB(clean);
  check(r.changed === false, 'changed = false');
  check(r.bytes === clean, '字节原样返回（零拷贝）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
