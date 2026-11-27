/**
 * camera-return.mjs —— 双击聚焦后能回到初始视角 + 过渡是平滑的
 *
 * 断言：
 *   1. 双击树节点 → 相机平滑飞过去（中途有插值帧，不是瞬移）
 *   2. 再双击同一节点 → 飞回双击前的视角（误差 < 模型尺度的 0.1%）
 *   3. 聚焦后按 Esc → 同样回到初始视角
 *   4. 3D 里双击构件 → 同样聚焦；双击空白 → 回到初始视角
 *   5. 「适应视图」仍然可用，并清掉返回点
 *
 * node test/camera-return.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.MODEL || path.resolve(HERE, '../../test/fixture.glb');
const URL = process.env.URL || 'http://localhost:5173/';

const b = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=8192'],
});
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.setInputFiles('#fileInput', FILE);
await p.waitForFunction(() => document.querySelectorAll('#tree .node').length > 0, null, { timeout: 180000 });
await p.waitForTimeout(1200);

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('✗ ' + msg); }
  else console.log('✓ ' + msg);
};
const cam = () => p.evaluate(() => {
  const { viewer } = window.__bim;
  return {
    pos: viewer.camera.position.toArray(),
    target: viewer.controls.target.toArray(),
    canRestore: viewer.canRestore,
    animating: viewer.animating,
  };
});
const dist = (a, b2) => Math.hypot(a[0] - b2[0], a[1] - b2[1], a[2] - b2[2]);

const scale = await p.evaluate(() => window.__bim.viewer.modelBox.getSize(new (window.__bim.viewer.camera.position.constructor)()).length());
const tol = scale * 1e-3;
const home = await cam();

// 展开到构件行（分组树默认只展开到第一层）
await p.evaluate(() => {
  for (let i = 0; i < 8; i++) {
    if ([...document.querySelectorAll('#tree .node')].some((r) => r.__node && !r.__node.isGroup)) return;
    const closed = [...document.querySelectorAll('#tree .node')]
      .filter((r) => r.classList.contains('is-group') && r.__node?.depth >= 1
        && !(r.__wrap && r.__wrap.classList.contains('open')));
    if (!closed.length) return;
    closed[0].querySelector('.node-caret')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});

const leaf = await p.evaluate(() => {
  const row = [...document.querySelectorAll('#tree .node')].find((r) => r.__node && !r.__node.isGroup);
  return row ? { name: row.__node.name, rows: document.querySelectorAll('#tree .node').length } : null;
});
assert(leaf, `展开到构件行（${leaf?.name}）`);

// ---- 1) 双击树节点：平滑飞过去 ----
await p.evaluate(() => {
  const row = [...document.querySelectorAll('#tree .node')].find((r) => r.__node && !r.__node.isGroup);
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
});
await p.waitForTimeout(120);
const mid = await cam();
await p.waitForTimeout(120);
const mid2 = await cam();
await p.waitForTimeout(900);
const focused = await cam();

const movedFromHome = dist(focused.pos, home.pos);
assert(movedFromHome > scale * 0.01, `双击后相机确实移动了（${movedFromHome.toFixed(2)} 单位）`);
assert(focused.canRestore, '双击后记下了返回点（canRestore）');
// 平滑：动画进行中采样点应当既不是起点也不是终点
const midMoved = dist(mid.pos, home.pos);
assert(!mid.animating || midMoved > 0, '过渡期间处于动画中');
assert(midMoved > scale * 1e-4 && dist(mid.pos, focused.pos) > scale * 1e-4,
  `中间帧不在起终点上（已走 ${midMoved.toFixed(2)} / 共 ${movedFromHome.toFixed(2)}）`);
assert(dist(mid2.pos, focused.pos) < dist(mid.pos, focused.pos) + 1e-6,
  '相机是逐步逼近终点，不是瞬移');

// ---- 1b) 聚焦后滚轮必须能拉远（不能「顶住」回不到全景）----
const wheelInfo = await p.evaluate(() => {
  const { viewer } = window.__bim;
  const box = viewer.modelBox.clone();
  // 用对角线一半当包围球半径，避免依赖 THREE 命名空间
  const size = box.max.clone().sub(box.min);
  return {
    homeDist: viewer.camera.position.distanceTo(viewer.controls.target),
    maxDistance: viewer.controls.maxDistance,
    modelRadius: size.length() / 2,
    far: viewer.camera.far,
  };
});
assert(wheelInfo.maxDistance > wheelInfo.homeDist * 0.95,
  `聚焦后仍可拉远到全景（maxDistance ${Math.round(wheelInfo.maxDistance)} ≥ 全景距离 ${Math.round(wheelInfo.homeDist)}）`);
assert(wheelInfo.far > wheelInfo.modelRadius * 1.5,
  `远裁面覆盖整模型（far ${Math.round(wheelInfo.far)} > 半径 ${Math.round(wheelInfo.modelRadius)}）`);

// 真滚轮：往下滚（拉远）若干格，相机应明显后退
const canvasBox = await p.locator('#canvas').boundingBox();
await p.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
for (let i = 0; i < 6; i++) {
  await p.mouse.wheel(0, 900);
  await p.waitForTimeout(80);
}
await p.waitForTimeout(400);
const wheeled = await p.evaluate(() => {
  const { viewer } = window.__bim;
  const cam = viewer.camera;
  const box = viewer.modelBox.clone();
  let maxAbs = 0;
  for (let i = 0; i < 8; i++) {
    const v = new (cam.position.constructor)(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z
    ).clone().project(cam);
    maxAbs = Math.max(maxAbs, Math.abs(v.x), Math.abs(v.y));
  }
  return { dist: cam.position.distanceTo(viewer.controls.target), ndc: +maxAbs.toFixed(3) };
});
assert(wheeled.dist > wheelInfo.homeDist * 0.8,
  `滚轮能明显拉远（${Math.round(wheeled.dist)} vs 全景 ${Math.round(wheelInfo.homeDist)}）`);
assert(wheeled.ndc <= 1.2,
  `拉远后整模型不被裁掉（8 角点 NDC 最大 ${wheeled.ndc}）`);

// 拉远后再双击同一节点 = 飞回初始视角
// ---- 2) 再双击同一节点 = 飞回 ----
await p.evaluate(() => {
  const row = [...document.querySelectorAll('#tree .node')].find((r) => r.__node && !r.__node.isGroup);
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
});
await p.waitForTimeout(900);
const back1 = await cam();
assert(dist(back1.pos, home.pos) < tol && dist(back1.target, home.target) < tol,
  `再双击同一节点回到初始视角（偏差 ${dist(back1.pos, home.pos).toExponential(1)}）`);
assert(!back1.canRestore, '返回后返回点已清空（不会反复往返）');

// ---- 3) 聚焦后按 Esc 返回 ----
await p.evaluate(() => {
  const row = [...document.querySelectorAll('#tree .node')].find((r) => r.__node && !r.__node.isGroup);
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
});
await p.waitForTimeout(900);
const focused2 = await cam();
assert(dist(focused2.pos, home.pos) > scale * 0.01, `再次聚焦成功（位移 ${dist(focused2.pos, home.pos).toFixed(2)}）`);
await p.keyboard.press('Escape');
await p.waitForTimeout(800);
const back2 = await cam();
assert(dist(back2.pos, home.pos) < tol, `Esc 回到初始视角（偏差 ${dist(back2.pos, home.pos).toExponential(1)}）`);

// ---- 4) 3D 里双击构件 ----
const hit = await p.evaluate(() => {
  const { viewer, state } = window.__bim;
  const canvas = viewer.renderer.domElement;
  const r = canvas.getBoundingClientRect();
  for (let i = -9; i <= 9; i++) {
    for (let j = -9; j <= 9; j++) {
      const x = Math.round(r.left + r.width * (0.5 + i * 0.045));
      const y = Math.round(r.top + r.height * (0.5 + j * 0.045));
      const h = viewer.pick(x, y, (rc) => state.batched.pick(rc));
      if (h?.rec) return { x, y, name: h.rec.name };
    }
  }
  return null;
});
assert(hit, `找到可双击的构件像素（${hit?.name}）`);
if (hit) {
  await p.mouse.dblclick(hit.x, hit.y);
  await p.waitForTimeout(900);
  const focused3 = await cam();
  assert(dist(focused3.pos, home.pos) > scale * 0.01,
    `3D 双击构件也聚焦（位移 ${dist(focused3.pos, home.pos).toFixed(2)}）`);
  const selName = await p.evaluate(() => document.querySelector('.prop-row .prop-val')?.textContent || '');
  assert(selName.length > 0, `双击同时选中构件（${selName}）`);

  // 双击空白 = 回初始视角
  const blank = await p.evaluate(() => {
    const { viewer, state } = window.__bim;
    const canvas = viewer.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    for (let fx = 0.12; fx <= 0.9; fx += 0.13) {
      for (let fy = 0.12; fy <= 0.9; fy += 0.13) {
        const x = Math.round(r.left + r.width * fx);
        const y = Math.round(r.top + r.height * fy);
        const el = document.elementFromPoint(x, y);
        if (el !== canvas && !canvas.contains(el)) continue;
        if (!viewer.pick(x, y, (rc) => state.batched.pick(rc))?.rec) return { x, y };
      }
    }
    return null;
  });
  assert(blank, `找到空白像素 (${blank?.x},${blank?.y})`);
  if (blank) {
    await p.mouse.dblclick(blank.x, blank.y);
    await p.waitForTimeout(800);
    const back3 = await cam();
    assert(dist(back3.pos, home.pos) < tol,
      `双击空白回到初始视角（偏差 ${dist(back3.pos, home.pos).toExponential(1)}）`);
  }
}

// ---- 5) 适应视图仍可用，并清掉返回点 ----
await p.evaluate(() => {
  const row = [...document.querySelectorAll('#tree .node')].find((r) => r.__node && !r.__node.isGroup);
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
});
await p.waitForTimeout(900);
await p.evaluate(() => document.getElementById('btnFit').click());
await p.waitForTimeout(800);
const fitState = await cam();
assert(dist(fitState.pos, home.pos) < tol, `「适应视图」回到同一初始视角（偏差 ${dist(fitState.pos, home.pos).toExponential(1)}）`);
assert(!fitState.canRestore, '「适应视图」清掉返回点');

assert(errs.length === 0, `无页面报错${errs.length ? '：' + errs[0] : ''}`);

await b.close();
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
