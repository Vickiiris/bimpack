/**
 * report-unknown.mjs —— 体检：哪些构件没被归到专业、哪些是靠「同类别多数」推的
 *
 * 用法：node test/report-unknown.mjs "路径/模型.glb"
 * （不需要起 dev 服务，只读 GLB 的 JSON chunk）
 *
 * 输出四段：
 *   1. 专业分布
 *   2. 仍留在「其他分类」的组合（名称 | Category | 族 | 类型 + 数量）—— 发出来就能补词表
 *   3. 靠同类别多数推断的数量（按类别统计）
 *   4. 按「系统名_设备名+编号」命名规则归位的数量，以及命名不合规的原因分布
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
const leaves = (json.nodes || []).map((n) => ({ props: n.extras || {}, name: n.name || '' }));
const res = classifyLeaves(leaves);

const dist = new Map();
const unknown = new Map();
const byCategory = new Map();
const manual = new Map();
const manualBad = new Map();
for (const leaf of leaves) {
  const r = res.get(leaf);
  dist.set(r.code, (dist.get(r.code) || 0) + 1);
  if (r.code === 'NONE') {
    const p = leaf.props;
    const k = `${leaf.name || '-'} | ${p['Category Name'] || '-'} | ${p['族'] || '-'} | ${p['Type Name'] || '-'}`;
    unknown.set(k, (unknown.get(k) || 0) + 1);
    if (r.detail) manualBad.set(r.detail, (manualBad.get(r.detail) || 0) + 1);
  }
  if (r.from === 'category') {
    const k = leaf.props['Category Name'] || '-';
    byCategory.set(k, (byCategory.get(k) || 0) + 1);
  }
  // detail 只会在「属性无系统字段 + 名字合规」时出现，所以拿它认命名规则命中的件
  if (r.code !== 'NONE' && r.detail.startsWith('系统名')) {
    const k = `${r.detail} → ${r.label}${r.from === 'fire' ? '（消防优先）' : ''}`;
    manual.set(k, (manual.get(k) || 0) + 1);
  }
}

const total = leaves.length;
console.log(`构件数：${total}`);
console.log('\n专业分布：');
for (const [code, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${disciplineName(code).padEnd(6)} ${String(n).padStart(7)}  ${(n / total * 100).toFixed(1)}%`);
}

console.log(`\n仍留在「其他分类」的组合（${unknown.size} 种）：`);
if (!unknown.size) console.log('  无');
for (const [k, n] of [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(6)}  ${k}`);
}

console.log('\n靠「同类别多数」推断的：');
if (!byCategory.size) console.log('  无');
for (const [k, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(n).padStart(6)}  ${k}`);
}

console.log('\n按「系统名_设备名+编号」命名规则归位的：');
if (!manual.size) console.log('  无');
for (const [k, n] of [...manual.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(n).padStart(6)}  ${k}`);
}
if (manualBad.size) {
  console.log('\n命名规则没匹配上的原因：');
  for (const [k, n] of [...manualBad.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
}
