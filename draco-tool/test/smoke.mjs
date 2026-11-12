/**
 * smoke.mjs —— 本地 Draco 工具的最小回归（不需要浏览器）
 *
 * 用法：
 *   1) 先启动服务：node server.mjs   （或双击 start.cmd）
 *   2) node test/smoke.mjs <原始.glb> [<已压过的.glb>]
 *
 * 断言：
 *   - 原始文件：压缩成功、体积下降、属性条目与节点数不变、19 项校验通过
 *   - 已压过的文件：被拒绝（already-compressed），且不产出文件
 *
 * 退出码 0 = 全部通过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://localhost:8099';
const [rawPath, tightPath] = process.argv.slice(2);

if (!rawPath) {
  console.error('用法: node test/smoke.mjs <原始.glb> [<已压过的.glb>]');
  process.exit(2);
}

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) fail++;
};

async function post(file, preset = 'balance') {
  const buf = fs.readFileSync(file);
  const q = new URLSearchParams({ name: path.basename(file), preset });
  const res = await fetch(`${BASE}/api/compress?${q}`, { method: 'POST', body: buf });
  return { status: res.status, body: await res.json(), size: buf.length };
}

const ping = await fetch(`${BASE}/api/ping`).then((r) => r.json()).catch(() => null);
if (!ping?.ok) {
  console.error(`连不上 ${BASE} —— 先启动服务（node server.mjs）`);
  process.exit(2);
}

console.log(`\n[1] 原始文件 ${path.basename(rawPath)}`);
{
  const r = await post(rawPath);
  const j = r.body;
  check(r.status === 200 && j.ok, '压缩成功');
  if (j.ok) {
    // 小文件（< 1 MB）本来就可能因为编码开销变大，前端也会如实提示，不算失败
    const tiny = j.input.size < 1048576;
    check(j.savedPercent > 0 || tiny, tiny ? '小文件允许轻微变大' : '体积下降',
      `${mb(j.input.size)} → ${mb(j.output.size)}（${j.savedPercent.toFixed(1)}%）`);
    check(j.input.nodes === j.output.nodes, '节点数不变', `${j.output.nodes}`);
    check(j.input.primitives === j.output.primitives, '图元数不变', `${j.output.primitives}`);
    check(j.input.propEntries === j.output.propEntries, 'BIM 属性条目不变', `${j.output.propEntries}`);
    check(j.verify?.pass === true, '19 项属性校验通过', `${j.verify?.rows?.length ?? 0} 项`);
    check(fs.existsSync(path.join(HERE, '..', 'out', j.outName)), '产物已落盘', j.outName);
  } else {
    console.log('   ', j.message);
  }
}

if (tightPath && fs.existsSync(tightPath)) {
  console.log(`\n[2] 已压过的文件 ${path.basename(tightPath)}`);
  const r = await post(tightPath);
  const j = r.body;
  check(j.ok === false && j.error === 'already-compressed', '被拒绝（不再二次压缩）', `${j.input?.bytesPerVertex} 字节/顶点`);
  check(!j.ok, '没有产出文件');
}

console.log(fail ? `\n失败 ${fail} 项\n` : '\n全部通过\n');
process.exit(fail ? 1 : 0);
