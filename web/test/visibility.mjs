/**
 * visibility.mjs —— 层级树显示/隐藏功能
 *   复选框勾选=显示、取消=隐藏；组三态；右键菜单隐藏；「全部显示」按钮
 * node test/visibility.mjs [glb 路径]
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

// 0) 每行都有复选框
const ncb = await p.evaluate(() => document.querySelectorAll('#tree .node-vis').length);
assert(ncb > 0, `树行带复选框（${ncb} 个）`);

// 1) 取消勾选一个构件 → rec 隐藏 + 行变灰（全部在页面内完成，
//    THREE.Object3D 不能在 evaluate 进出传引用，序列化后 === 会失效）
const hideRes = await p.evaluate(() => {
  const { state, tree } = window.__bim;
  // 拿第一个有 rec 的 mesh 对象
  let target = null;
  for (const list of state.batched.objectToRecs.values()) { target = list[0].object; break; }
  if (!target) return { ok: false, why: 'no rec' };
  // 在树上找对应节点
  let tn = null;
  (function walk(n) { if (n.obj === target) tn = n; for (const c of n.children) walk(c); })(tree.root);
  if (!tn) return { ok: false, why: 'tree node not found' };
  tree.reveal(target); // 展开祖先链，行渲染出来才有复选框
  const cb = [...document.querySelectorAll('#tree .node-vis')].find((c) => c.closest('.node').__node === tn);
  if (!cb) return { ok: false, why: 'checkbox not rendered' };
  cb.click(); // 取消勾选 → 隐藏
  return {
    ok: true,
    rowHidden: cb.closest('.node').classList.contains('hidden'),
    recVisible: tn.recs[0].visible,
  };
});
assert(hideRes.ok, `找到树节点${hideRes.ok ? '' : '（' + hideRes.why + '）'}`);
assert(hideRes.rowHidden, '取消勾选后行进入隐藏态（变灰）');
assert(hideRes.recVisible === false, 'rec.visible = false');

// 2) 重新勾选 → 恢复显示
const showRes = await p.evaluate(() => {
  const { state, tree } = window.__bim;
  let target = null;
  for (const list of state.batched.objectToRecs.values()) { target = list[0].object; break; }
  let tn = null;
  (function walk(n) { if (n.obj === target) tn = n; for (const c of n.children) walk(c); })(tree.root);
  tree.reveal(target);
  const cb = [...document.querySelectorAll('#tree .node-vis')].find((c) => c.closest('.node').__node === tn);
  cb.click();
  return { rowHidden: cb.closest('.node').classList.contains('hidden'), recVisible: tn.recs[0].visible };
});
assert(showRes.recVisible === true && !showRes.rowHidden, '重新勾选后恢复显示');

// 3) 组三态：隐藏组内一个构件，组的复选框应变 indeterminate；全隐藏变 unchecked
const groupRes = await p.evaluate(() => {
  const { tree } = window.__bim;
  // 找一个有多个构件子项的分组节点
  let g = null;
  (function walk(n) {
    if (!g && n.isGroup && n.children.filter((c) => !c.isGroup).length >= 2) g = n;
    for (const c of n.children) walk(c);
  })(tree.root);
  if (!g) return { ok: false };
  const rowCb = (n) => [...document.querySelectorAll('#tree .node-vis')].find((c) => c.closest('.node').__node === n);
  const leaf0 = g.children.find((c) => !c.isGroup);
  const gcb = rowCb(g);
  if (!gcb || !leaf0) return { ok: false, why: 'rows not rendered' };
  rowCb(leaf0).click(); // 隐藏一个构件
  const mixed = gcb.indeterminate;
  rowCb(leaf0).click(); // 再隐藏一个……不，恢复
  return { ok: true, mixed };
});
assert(groupRes.ok && groupRes.mixed, '隐藏组内一个构件后，组复选框为 indeterminate（部分隐藏）');

// 4) 隐藏整个组 → 子树全部隐藏
const grpHide = await p.evaluate(() => {
  const { tree } = window.__bim;
  let g = null;
  (function walk(n) {
    if (!g && n.isGroup && n.children.filter((c) => !c.isGroup).length >= 2) g = n;
    for (const c of n.children) walk(c);
  })(tree.root);
  if (!g) return { ok: false };
  const allRecs = [];
  (function walk(n) { if (n.recs) allRecs.push(...n.recs); for (const c of n.children) walk(c); })(g);
  const gcb = [...document.querySelectorAll('#tree .node-vis')].find((c) => c.closest('.node').__node === g);
  gcb.click(); // 取消勾选组 → 全隐藏
  return {
    ok: true,
    recsOff: allRecs.every((r) => r.visible === false),
    gChecked: gcb.checked,
    hiddenClass: gcb.closest('.node').classList.contains('hidden'),
  };
});
assert(grpHide.ok && grpHide.recsOff && !grpHide.gChecked && grpHide.hiddenClass, '取消勾选组 → 整棵子树隐藏，组行变灰');

// 5) 右键菜单：隐藏 / 全部显示
const menu = await p.locator('#tree .node.is-group').first();
await menu.click({ button: 'right' });
await p.waitForTimeout(200);
const menuShown = await p.evaluate(() => !!document.querySelector('.ctx-menu'));
assert(menuShown, '右键行弹出菜单');
await p.evaluate(() => [...document.querySelectorAll('.ctx-item')].find((i) => i.textContent === '全部显示').click());
await p.waitForTimeout(200);
const allShown = await p.evaluate(() => {
  const { state } = window.__bim;
  let total = 0, on = 0;
  for (const list of state.batched.objectToRecs.values()) for (const r of list) { total++; if (r.visible !== false) on++; }
  return { total, on, hiddenRows: document.querySelectorAll('#tree .node.hidden').length };
});
assert(allShown.total === allShown.on && allShown.hiddenRows === 0, `「全部显示」恢复所有构件（${allShown.on}/${allShown.total}）`);

// 6) Esc 关闭右键菜单
await menu.click({ button: 'right' });
await p.waitForTimeout(150);
await p.keyboard.press('Escape');
await p.waitForTimeout(150);
const menuGone = await p.evaluate(() => !document.querySelector('.ctx-menu'));
assert(menuGone, 'Esc 关闭右键菜单');

assert(errs.length === 0, `无页面报错${errs.length ? '：' + errs.join(' | ') : ''}`);
await b.close();
