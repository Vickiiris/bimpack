/**
 * vc-glass.mjs —— 「带顶点色的半透明材质」不能变黑
 *
 * 复现背景：玻璃材质若在图元里带 COLOR_0，GLTFLoader 会把材质标成
 * vertexColors = true。早期批处理把 color 属性剥掉，着色器采样不到顶点色
 * 就取默认 0，基色乘 0 → 整块纯黑。这里验证修复后顶点色被完整保留。
 *
 * node test/vc-glass.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'fixture-vc-glass.glb');
const URL = process.env.URL || 'http://localhost:5173/';

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 900, height: 700 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.setInputFiles('#fileInput', FILE);
await p.waitForFunction(() => document.querySelectorAll('#tree .node').length > 0, null, { timeout: 120000 });
await p.waitForTimeout(800);

const assert = (cond, msg) => {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; }
  else console.log('✓ ' + msg);
};

const r = await p.evaluate(() => {
  const { state } = window.__bim;
  const b0 = state.batched.batches[0];
  const g = b0.batch.geometry;
  const col = g.attributes.color;
  const sample = [];
  if (col) {
    const rec = [...b0.batch.userData.byInstance.values()][0];
    const info = b0.batch._geometryInfo?.[rec.geometryId];
    const start = info ? info.vertexStart : 0;
    for (let k = 0; k < 3; k++) sample.push(+col.getX(start).toFixed(3), +col.getY(start).toFixed(3), +col.getZ(start).toFixed(3));
  }
  return {
    vertexColors: b0.material.vertexColors === true,
    transparent: b0.material.transparent === true,
    opacity: b0.material.opacity,
    hasColorAttr: !!col,
    sample,
    batchColor: b0.material.color?.getHexString(),
  };
});

console.log('批内材质状态', JSON.stringify(r));
assert(r.vertexColors, '材质 vertexColors = true（GLTFLoader 因 COLOR_0 自动开启）');
assert(r.hasColorAttr, '批内几何保留了 color 属性（否则采样为 0 → 全黑）');
assert(r.sample[0] > 0.5 && r.sample[1] > 0.7, `顶点色数值正确（${r.sample.slice(0, 3).join(', ')}）`);
assert(r.transparent && r.opacity < 1, `半透明参数保留（opacity=${r.opacity.toFixed(2)}）`);

// 截图存证：正对玻璃面（-Z 方向），画面中央应是淡青色，不是黑块
await p.evaluate(() => {
  const { viewer } = window.__bim;
  viewer.camera.position.set(0, 0, 2.2);
  viewer.controls.target.set(0, 0, 0);
  viewer.controls.update();
});
await p.waitForTimeout(500);
await p.screenshot({ path: path.join(HERE, 'shot-vc-glass.png') });

assert(errs.length === 0, `无页面报错${errs.length ? '：' + errs.join(' | ') : ''}`);
await b.close();
