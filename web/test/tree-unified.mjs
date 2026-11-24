/**
 * tree-unified.mjs —— 「规范层级」合并后的树结构
 *
 * 断言：专业 → 系统 → 类别 → 类型 五级主干、消防优先、同类别跨专业不合并、
 *       空层自动折叠、叶子不重不漏、手工命名模型按「系统名_设备名+编号」归位。
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
assert(names.join('|') === '消防|暖通空调|给排水|电气|安防|建筑|其他分类'.split('|').sort().join('|'),
  `第一层是专业：${names.join(' / ')}`);

const byName = (n) => info.top.find((t) => t.name === n);
assert(byName('消防')?.count === 5, `消防 5 件（PY×2 + 喷淋 + 消火栓 + 手工喷淋头），实际 ${byName('消防')?.count}`);
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
assert(byName('电气')?.count === 2 && byName('安防')?.count === 1,
  `电气 2（桥架 + 手工筒灯）/ 安防 1（同类别桥架按专业分开），实际 ${byName('电气')?.count} / ${byName('安防')?.count}`);

// 回归：缩写 NW 在别处常指 network，但这套模型的系统类型写明是空调凝结水+坡道雨水
const plumb = info.tree.find((t) => t.name === '给排水');
assert(plumb.kids.some((c) => c.name === 'NW'), `给排水下有 NW 系统：${plumb.kids.map((c) => c.name).join(' / ')}`);
assert(!info.tree.find((t) => t.name === '安防').kids.some((c) => c.name === 'NW'), 'NW 没有被缩写表拉进安防（ELV）');
assert(byName('建筑')?.count === 1, '建筑 1 件（无系统字段的墙）');

// 消防优先：排烟风管进消防，不因「类别=风管」被拉去暖通
const fire = info.tree.find((t) => t.name === '消防');
const fireSys = fire.kids.map((c) => c.name).sort();
assert(fireSys.join('|') === 'PY|SP|XH|消防', `消防下按系统分：${fireSys.join(' / ')}`);
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

// 空层折叠：建筑构件没有系统字段，路径里不该出现 其他分类
const arch = info.tree.find((t) => t.name === '建筑');
assert(arch.kids[0]?.name === '墙', `建筑下直接是类别：${arch.kids[0]?.name}（系统层已折叠）`);

// 手工添加的非 BIM 模型：没有 extras，只能靠「系统名_设备名+编号」归类
const elec = info.tree.find((t) => t.name === '电气');
const elecSys = elec.kids.map((c) => c.name).sort();
assert(elecSys.join('|') === 'AL|智能照明', `电气下系统层：${elecSys.join(' / ')}（手工模型的系统名来自命名）`);
const lamp = await p.evaluate(() => {
  const walk = (n, out = []) => { if (!n.isGroup) out.push({ name: n.name, depth: n.depth }); for (const c of n.children) walk(c, out); return out; };
  const g = window.__bim.tree.root.children.find((n) => n.name === '电气');
  return g ? walk(g) : [];
});
assert(lamp.some((l) => l.name === '智能照明_筒灯001'), '「智能照明_筒灯001」归到电气');

// 命名规则认不出的 → 留在「其他分类」，且不额外造假层级
const other = info.tree.find((t) => t.name === '其他分类');
const otherLeaf = other?.kids?.[0];
assert(otherLeaf?.name === '构件甲_未知设备001', `其他分类下是认不出的手工模型：${otherLeaf?.name}`);
assert(other.count === 1, `其他分类 1 件，实际 ${other.count}`);

// 手工模型没有类别 / 类型，路径应是「专业 > 系统 > 构件」，不多造空层
const lampPath = await p.evaluate(() => {
  const find = (n) => {
    if (!n.isGroup && n.name === '智能照明_筒灯001') return n;
    for (const c of n.children) { const r = find(c); if (r) return r; }
    return null;
  };
  const leaf = find(window.__bim.tree.root);
  const out = [];
  for (let n = leaf; n && n !== window.__bim.tree.root; n = n.parent) out.push(n.name);
  return out.reverse();
});
assert(lampPath.join(' > ') === '电气 > 智能照明 > 智能照明_筒灯001',
  `手工模型路径：${lampPath.join(' > ')}`);

// 悬浮提示要说清「为什么进其他分类」
const otherTitle = await p.evaluate(() => {
  const row = [...document.querySelectorAll('#tree .node')].find((r) => r.querySelector('.node-name')?.textContent === '其他分类');
  return row?.title || '';
});
assert(otherTitle.includes('命名规则') || otherTitle.includes('认不出'),
  `其他分类的悬浮提示说明了进桶原因（${otherTitle.split('\n')[1] || '空'}）`);

// 不重不漏
assert(info.leafCount === 18 && info.recTotal === 18,
  `叶子 ${info.leafCount} 个 = 构件 ${info.recTotal} 个（不重不漏）`);

assert(errs.length === 0, `无页面报错${errs.length ? '：' + errs.join(' | ') : ''}`);

await p.screenshot({ path: path.join(HERE, 'shot-tree-unified.png'), clip: { x: 0, y: 60, width: 320, height: 460 } });
await b.close();
console.log(process.exitCode ? '\n有断言失败' : '\n全部通过');
