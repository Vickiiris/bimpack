/**
 * report-unknown.mjs —— 体检：哪些构件没被归到专业、哪些是靠「同类别多数」推的
 *
 * 用法：node test/report-unknown.mjs "路径/模型.glb"
 * （不需要起 dev 服务，只读 GLB 的 JSON chunk）
 *
 * 输出三段：
 *   1. 专业分布
 *   2. 仍未分类的组合（Category | 族 | 类型 + 数量）—— 把这些值发出来就能补词表
 *   3. 靠同类别多数推断的数量（按类别统计）
 */
import { readFileSync } from 'node:fs';
import { classifyLeaves, disciplineName } from '../src/viewer/discipline.js';

const file = process.argv[2];
if (!file) {
  console.error('用法：node test/report-unknown.mjs "路径/模型.glb"');
  process.exit(1);
}

const buf = readFileSync(file);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 12;
let json = null;
while (off < buf.byteLength) {
  const len = dv.getUint32(off, true);
  const type = dv.getUint32(off + 4, true);
  if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len)));
  off += 8 + len;
}
if (!json) {
  console.error('不是 GLB / 没有 JSON chunk');
  process.exit(1);
}

// 一个节点一个叶子（报告用，不关心合批后的 rec 合并）
const leaves = (json.nodes || []).map((n) => ({ props: n.extras || {} }));
const res = classifyLeaves(leaves);

const dist = new Map();
const unknown = new Map();
const byCategory = new Map();
for (const leaf of leaves) {
  const r = res.get(leaf);
  dist.set(r.code, (dist.get(r.code) || 0) + 1);
  if (r.code === 'NONE') {
    const p = leaf.props;
    const k = `${p['Category Name'] || '-'} | ${p['族'] || '-'} | ${p['Type Name'] || '-'}`;
    unknown.set(k, (unknown.get(k) || 0) + 1);
  }
  if (r.from === 'category') {
    const k = leaf.props['Category Name'] || '-';
    byCategory.set(k, (byCategory.get(k) || 0) + 1);
  }
}

const total = leaves.length;
console.log(`构件数：${total}`);
console.log('\n专业分布：');
for (const [code, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${disciplineName(code).padEnd(6)} ${String(n).padStart(7)}  ${(n / total * 100).toFixed(1)}%`);
}

console.log(`\n仍未分类的组合（${unknown.size} 种）：`);
if (!unknown.size) console.log('  无');
for (const [k, n] of [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(6)}  ${k}`);
}

console.log('\n靠「同类别多数」推断的：');
if (!byCategory.size) console.log('  无');
for (const [k, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(n).padStart(6)}  ${k}`);
}
