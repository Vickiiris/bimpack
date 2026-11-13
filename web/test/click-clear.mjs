/**
 * click-clear.mjs —— 点构件高亮，点空白处取消高亮
 * node test/click-clear.mjs [glb 路径]
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || 'C:/Users/sjzn/WorkBuddy/2026-11-11-16-13-06/bimpack/test/fixture.glb';
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
await p.waitForFunction(() => document.querySelectorAll('#tree .node').length > 0, null, { timeout: 120000 });
await p.waitForTimeout(800);

const assert = (cond, msg) => {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; }
  else console.log('✓ ' + msg);
};

/** 在画布上找一个能命中构件的像素（NDC 网格扫描），返回 {x, y, name} */
const target = await p.evaluate(() => {
  const { viewer, state } = window.__bim;
  const canvas = viewer.renderer.domElement;
  const r = canvas.getBoundingClientRect();
  for (let i = -9; i <= 9; i++) {
    for (let j = -9; j <= 9; j++) {
      const x = r.left + r.width * (0.5 + i * 0.045);
      const y = r.top + r.height * (0.5 + j * 0.045);
      const hit = viewer.pick(x, y, (rc) => state.batched.pick(rc));
      if (hit?.rec) {
        return { x: Math.round(x), y: Math.round(y), name: hit.rec.name };
      }
    }
  }
  return null;
});
assert(target, `找到可点选像素 (${target?.x},${target?.y}) 构件「${target?.name}」`);
if (!target) { await b.close(); process.exit(1); }

// 1) 点构件 → 应出现选中态
await p.mouse.click(target.x, target.y);
await p.waitForTimeout(400);
let sel = await p.evaluate(() => ({
  treeSel: document.querySelectorAll('#tree .node.selected').length,
  propName: document.querySelector('.prop-row .prop-val')?.textContent || '',
  count: document.getElementById('propCount').textContent,
}));
assert(sel.treeSel >= 1, '点构件后层级树出现选中行');
assert(sel.propName && sel.propName !== '', `属性面板显示构件（${sel.propName}）`);

// 2) 点空白处 → 高亮与选中态都应清掉。注意画布四周有面板和 HUD 覆盖，
//    必须选一个「elementFromPoint 是画布本身、且拾取不到构件」的像素。
const corner = await p.evaluate(() => {
  const { viewer, state } = window.__bim;
  const canvas = viewer.renderer.domElement;
  const r = canvas.getBoundingClientRect();
  for (let fx = 0.12; fx <= 0.9; fx += 0.13) {
    for (let fy = 0.12; fy <= 0.9; fy += 0.13) {
      const x = Math.round(r.left + r.width * fx);
      const y = Math.round(r.top + r.height * fy);
      const el = document.elementFromPoint(x, y);
      if (el !== canvas && !canvas.contains(el)) continue;
      const hit = viewer.pick(x, y, (rc) => state.batched.pick(rc));
      if (!hit?.rec) return { x, y };
    }
  }
  return null;
});
assert(corner, `找到空白画布像素 (${corner?.x},${corner?.y})`);
if (!corner) { await b.close(); process.exit(1); }
await p.mouse.click(corner.x, corner.y);
await p.waitForTimeout(400);
sel = await p.evaluate(() => ({
  treeSel: document.querySelectorAll('#tree .node.selected').length,
  propName: document.querySelector('.prop-row .prop-val')?.textContent || '',
  empty: !!document.querySelector('#props .empty'),
}));
assert(sel.treeSel === 0, '点空白后树选中行清空');
assert(sel.empty, '属性面板复位为空状态');

// 3) 再点构件、Esc 键，确认原快捷键仍有效
await p.mouse.click(target.x, target.y);
await p.waitForTimeout(300);
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
sel = await p.evaluate(() => document.querySelectorAll('#tree .node.selected').length);
assert(sel === 0, 'Esc 取消选中仍有效');

assert(errs.length === 0, `无页面报错${errs.length ? '：' + errs.join(' | ') : ''}`);
await b.close();
