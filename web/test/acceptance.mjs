/**
 * acceptance.mjs —— 浏览器内压缩的验收：属性零丢失 + 材质不变 + 几何不走形
 * node test/acceptance.mjs <文件路径（会被拷到 public/acc.glb）>
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const src = process.argv[2];
fs.copyFileSync(src, path.join(ROOT, 'public/acc.glb'));

const b = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=8192'] });
const p = await b.newPage();
p.on('crash', () => console.log('*** CRASH ***'));
await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });

const r = await p.evaluate(async () => {
  const { compressGeometry, inspect, getIO } = await import('/src/core/process.js');
  const { fixAssetVersion, readJSON } = await import('/src/core/glb.js');
  const { compareJSON, compareGeometry } = await import('/src/core/verify.js');
  const buf = await (await fetch('/acc.glb')).arrayBuffer();
  const fixed = fixAssetVersion(new Uint8Array(buf)).bytes;
  const infoIn = inspect(fixed);
  const t0 = performance.now();
  const { bytes: out, params } = await compressGeometry(fixed, { preset: 'high' });
  const ms = performance.now() - t0;
  const infoOut = inspect(out);
  const v = compareJSON(fixed, out, { transformTolerance: 0.01 });
  const io = await getIO();
  const g = await compareGeometry(io, fixed, out, 400);

  const A = readJSON(fixed), B = readJSON(out);
  // 定位数值不一致的材质（verify 用的是 numClose，这里复现一份用于打印名字）
  const numClose2 = (a, b, tol = 1e-6) => {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => numClose2(x, b[i], tol));
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
      return ka.length === kb.length && ka.every((k, i) => k === kb[i] && numClose2(a[k], b[k], tol));
    }
    return a === b;
  };
  const mapB2 = new Map((B.materials || []).map(m => [m.name ?? '', m]));
  const matDiff = [];
  for (const m of A.materials || []) {
    const nb = mapB2.get(m.name ?? '');
    if (!nb) { matDiff.push({ name: m.name, why: '输出缺失' }); continue; }
    if (!numClose2(m, nb)) matDiff.push({ name: m.name, in: JSON.stringify(m).slice(0, 220), out: JSON.stringify(nb).slice(0, 220) });
  }

  const vol = (J) => (J.materials || []).filter(m => m.extensions?.KHR_materials_volume)
    .map(m => ({ name: m.name, t: m.extensions.KHR_materials_volume.thicknessFactor, a: m.extensions.KHR_materials_volume.attenuationDistance }));
  return {
    ms: Math.round(ms), params,
    size: { in: infoIn.total, out: infoOut.total, saved: (1 - infoOut.total / infoIn.total) * 100 },
    counts: { nodesIn: infoIn.nodes, nodesOut: infoOut.nodes, primsIn: infoIn.primitives, primsOut: infoOut.primitives,
              matsIn: infoIn.materials, matsOut: infoOut.materials, propsIn: infoIn.propEntries, propsOut: infoOut.propEntries },
    verifyPass: v.pass, rows: v.rows.map(x => ({ ok: x.ok, label: x.label, a: x.a, b: x.b })),
    geometry: g,
    volume: { in: vol(A), out: vol(B) },
    extIn: infoIn.extensions, extOut: infoOut.extensions, matDiff,
  };
});

const { size, counts, rows, geometry, volume } = r;
console.log(`\n耗时 ${(r.ms/1000).toFixed(1)} s   参数 ${JSON.stringify(r.params)}`);
console.log(`\n体积  ${(size.in/1048576).toFixed(2)} MB → ${(size.out/1048576).toFixed(2)} MB  (${size.saved >= 0 ? '−' : '+'}${Math.abs(size.saved).toFixed(1)}%)`);
console.log(`节点  ${counts.nodesIn} → ${counts.nodesOut}   图元 ${counts.primsIn} → ${counts.primsOut}`);
console.log(`材质  ${counts.matsIn} → ${counts.matsOut}   属性条目 ${counts.propsIn} → ${counts.propsOut}`);
console.log(`扩展  ${r.extIn.join(',')}  →  ${r.extOut.join(',')}`);
console.log(`\n校验 ${r.verifyPass ? '✓ 全部通过' : '✗ 有失败项'}`);
for (const x of rows) console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}${x.a !== '' ? '   ' + x.a : ''}${x.b ? '  |  ' + x.b : ''}`);
console.log(`\n几何（世界坐标）抽样 ${geometry.sampledPrims} 图元：包围盒最大偏移 ${geometry.maxBoxShift.toExponential(2)} 单位，均值 ${geometry.meanBoxShift.toExponential(2)}，整体尺度差 ${geometry.sizeDiffPercent.toFixed(4)}%`);
console.log(`\n材质差异（数值级）: ${r.matDiff.length}`);
for (const d of r.matDiff.slice(0, 3)) {
  if (d.why) console.log(`  ● ${d.name}: ${d.why}`);
  else { console.log(`  ● ${d.name}`); console.log(`    in : ${d.in}`); console.log(`    out: ${d.out}`); }
}
console.log(`\n体积散射材质：`);
for (const a of volume.in) {
  const b2 = volume.out.find(x => x.name === a.name);
  console.log(`  ${a.name}: thickness ${a.t} → ${b2 ? b2.t : '缺失'}   atten ${a.a} → ${b2 ? b2.a : '缺失'}`);
}
await b.close();
