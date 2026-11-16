/**
 * tree-unified.mjs —— 「规范层级」合并后的树结构
 *
 * 断言：专业 → 系统 → 类别 → 类型 五级主干、消防优先、同类别跨专业不合并、
 *       空层自动折叠、叶子不重不漏。
 *
 * node test/tree-unified.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'fixture-unified.glb');
const URL = process.env.URL || 'http://localhost:5173/';

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.setInputFiles('#fileInput', FILE);
await p.waitForFunction(() => document.querySelectorAll('#tree .node').length > 0, null, { timeout: 120000 });
await p.waitForTimeout(600);

const assert = (cond, msg) => {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; }
  else console.log('✓ ' + msg);
};

const defMode = await p.evaluate(() => document.getElementById('treeGroup').value);
assert(defMode === 'unified', `默认就是规范层级（当前 ${defMode}）`);

const info = await p.evaluate(() => {
  const { tree, state } = window.__bim;
  const walk = (n, out = []) => { if (!n.isGroup) out.push(n); for (const c of n.children) walk(c, out); return out; };
  const leaves = walk(tree.root);
  const dump = (n) => ({
    name: n.name,
    count: n.count,
    hint: n.hint || '',
    hintFrom: n.hintFrom || '',
    kids: n.children.map(dump),
  });
  const recTotal = state.batched.batches.reduce((s, x) => s + x.count, 0);
  return {
    top: tree.root.children.map((n) => ({ name: n.name, count: n.count, disc: n.discCode })),
    tree: tree.root.children.map(dump),
    leafCount: leaves.length,
    recTotal,
    leafNames: leaves.map((l) => l.name),
  };
});

const names = info.top.map((t) => t.name).sort();
assert(names.join('|') === '消防|暖通空调|给排水|电气|智能化|建筑'.split('|').sort().join('|'),
  `第一层是专业：${names.join(' / ')}`);

const byName = (n) => info.top.find((t) => t.name === n);
assert(byName('消防')?.count === 4, `消防 4 件（PY×2 + 喷淋 + 消火栓），实际 ${byName('消防')?.count}`);
assert(byName('暖通空调')?.count === 3, `暖通空调 3 件（送风 + 冷冻水 + 板式换热器），实际 ${byName('暖通空调')?.count}`);
assert(!names.includes('结构'), `机械设备没有被归进结构（结构组${names.includes('结构') ? '存在' : '不存在'}）`);
assert(byName('给排水')?.count === 5, `给排水 5 件（NW 凝结水+雨水 1 + 特殊部件 4），实际 ${byName('给排水')?.count}`);
// 「同类别多数」兜底：特殊部件 D 没有任何系统信息，但同类 3 件都是给排水 → 跟同类走
const plumbLeaves = await p.evaluate(() => {
  const walk = (n, out = []) => { if (!n.isGroup) out.push(n.name); for (const c of n.children) walk(c, out); return out; };
  const g = window.__bim.tree.root.children.find((n) => n.name === '给排水');
  return g ? walk(g) : [];
});
assert(plumbLeaves.some((n) => n.includes('特殊部件 D')), '无系统信息的「特殊部件 D」跟同类归到给排水');
assert(byName('电气')?.count === 1 && byName('智能化')?.count === 1, '电气 / 智能化各 1 件（同类别桥架，按专业分开）');

// 回归：缩写 NW 在别处常指 network，但这套模型的系统类型写明是空调凝结水+坡道雨水
const plumb = info.tree.find((t) => t.name === '给排水');
assert(plumb.kids.some((c) => c.name === 'NW'), `给排水下有 NW 系统：${plumb.kids.map((c) => c.name).join(' / ')}`);
assert(!info.tree.find((t) => t.name === '智能化').kids.some((c) => c.name === 'NW'), 'NW 没有被缩写表拉进智能化');
assert(byName('建筑')?.count === 1, '建筑 1 件（无系统字段的墙）');

// 消防优先：排烟风管进消防，不因「类别=风管」被拉去暖通
const fire = info.tree.find((t) => t.name === '消防');
const fireSys = fire.kids.map((c) => c.name).sort();
assert(fireSys.join('|') === 'PY|SP|XH', `消防下按系统分：${fireSys.join(' / ')}`);
const py = fire.kids.find((c) => c.name === 'PY');
assert(py.hint === '排烟风管', `PY 的中文名「${py.hint}」来自系统类型（${py.hintFrom}）`);

// 五级主干：专业 → 系统 → 类别 → 类型
const path1 = [];
let cur = py;
while (cur) { path1.push(cur.name); cur = cur.kids?.[0]; }
assert(path1.join(' > ').startsWith('PY > 风管 > 镀锌铁皮'),
  `PY 分支为 系统 > 类别 > 类型：${path1.slice(0, 3).join(' > ')}`);

// 同类别跨专业：风管 在两处各有一份，不合并
const hvac = info.tree.find((t) => t.name === '暖通空调');
const hvacCats = hvac.kids.flatMap((c) => c.kids.map((k) => k.name));
assert(hvacCats.includes('风管') && fire.kids.some((c) => c.name === 'PY'),
  '「风管」在暖通与消防下各有一份（跨专业同类别不合并）');

// 空层折叠：建筑构件没有系统字段，路径里不该出现 (未分类)
const arch = info.tree.find((t) => t.name === '建筑');
assert(arch.kids[0]?.name === '墙', `建筑下直接是类别：${arch.kids[0]?.name}（系统层已折叠）`);

// 不重不漏
assert(info.leafCount === 15 && info.recTotal === 15,
  `叶子 ${info.leafCount} 个 = 构件 ${info.recTotal} 个（不重不漏）`);

assert(errs.length === 0, `无页面报错${errs.length ? '：' + errs.join(' | ') : ''}`);

await p.screenshot({ path: path.join(HERE, 'shot-tree-unified.png'), clip: { x: 0, y: 60, width: 320, height: 460 } });
await b.close();
console.log(process.exitCode ? '\n有断言失败' : '\n全部通过');
