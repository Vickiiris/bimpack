/**
 * tree-disc-equip.mjs —— 新增的两级视图「专业›设备分类」
 *
 * 断言：
 *   - 下拉里有 discEquip 这一档，切过去后**只有两层**：专业 → 设备分类 → 构件
 *   - 暖通空调下就是它的设备：空调机柜 / 新风机组 / 风机盘管 / 水泵（不再分系统）
 *   - 电气：配电柜 / 其他设备；给排水：水箱
 *   - **智能化单独成一级**：名称带「智能 / 智慧」的设备全收在这里，第二层按系统名分组
 *     （智能照明 / 智慧安防，与主干视图的系统层同名），不再散在电气 / 安防下面
 *   - **管综单独成一级、排最后**，内部先分**专业方向**（暖通空调 / 给排水 / 电气 / 安防…，
 *     与第 1 层同名同色），再按 Revit 类别细分（风管 / 管道 / 电缆桥架 / 管道附件）
 *   - 建筑构件不并进设备分类：建筑 → 墙
 *   - 一级按业务序排（暖通 → 给排水 → 电气 → 建筑 → 智能化 → 管综），不是拼音序
 *   - 与其它档同源：叶子总数 = 构件总数（18），切换视图不重不漏
 *
 * node test/tree-disc-equip.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'fixture-equipment.glb');
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

const modes = await p.evaluate(() => [...document.querySelectorAll('#treeGroup option')].map((o) => o.value));
assert(modes.includes('discEquip'), `下拉里有两级视图：${modes.join(' / ')}`);

// 先记下主干视图的构件总数，用来对照「切换视图不重不漏」
const totalOf = () => p.evaluate(() => {
  const { tree, state } = window.__bim;
  let n = 0;
  const walk = (x) => { if (!x.isGroup) n++; for (const c of x.children) walk(c); };
  walk(tree.root);
  return { leaves: n, recs: state.batched.batches.reduce((s, x) => s + x.count, 0) };
});
const base = await totalOf();

await p.selectOption('#treeGroup', 'discEquip');
await p.waitForTimeout(700);

const info = await p.evaluate(() => {
  const { tree } = window.__bim;
  const walk = (n, out = []) => { if (!n.isGroup) out.push(n); for (const c of n.children) walk(c, out); return out; };
  const leaves = walk(tree.root);
  const dump = (n) => ({ name: n.name, count: n.count, depth: n.depth, kids: n.children.map(dump) });
  return {
    top: tree.root.children.map((n) => ({ name: n.name, count: n.count, disc: n.discCode || '', kids: n.children.map((c) => c.name) })),
    tree: tree.root.children.map(dump),
    leafCount: leaves.length,
    leafNames: leaves.map((l) => l.name),
    maxGroupDepth: Math.max(0, ...leaves.map((l) => l.depth - 1)),
  };
});

const order = info.top.map((t) => t.name);
assert(order.join(' / ') === '暖通空调 / 给排水 / 电气 / 建筑 / 智能化 / 管综',
  `第 1 层按业务序：${order.join(' / ')}`);
assert(order[order.length - 1] === '管综', '管综单独成一级、排最后');
assert(order[order.length - 2] === '智能化', '智能化单独成一级、紧挨着排在管综之前');
assert(info.top.at(-1).disc === '' && info.top.at(-2).disc === '',
  '智能化 / 管综都不挂专业颜色（它们不是专业）');
assert(info.maxGroupDepth === 3,
  `设备分支两层（专业 / 设备分类）、管综分支三层（管综 / 专业 / 类别），实际最深 ${info.maxGroupDepth}`);

const byName = (n) => info.top.find((t) => t.name === n);
assert(byName('暖通空调')?.kids.join(' / ') === '空调机柜 / 新风机组 / 风机盘管 / 水泵',
  `暖通空调下是设备分类：${byName('暖通空调')?.kids.join(' / ')}`);
assert(byName('暖通空调')?.count === 4, `暖通空调 4 件，实际 ${byName('暖通空调')?.count}`);
assert(byName('给排水')?.kids.join(' / ') === '水箱', '给排水 → 水箱');
assert(byName('电气')?.kids.join(' / ') === '配电柜 / 其他设备',
  `电气下只剩常规设备（智能化已单独成一级）：${byName('电气')?.kids.join(' / ')}`);
assert(!byName('安防'), '安防里只有智能设备，已整体并入「智能化」一级');
assert(byName('智能化')?.kids.slice().sort().join(' / ') === '智慧安防 / 智能照明'.split(' / ').sort().join(' / '),
  `智能化下按系统名分组：${byName('智能化')?.kids.join(' / ')}`);
assert(byName('建筑')?.kids.join(' / ') === '墙', '建筑构件不并进设备分类：建筑 → 墙');
// 管综：先按专业方向拆（与第 1 层同名同色），再按 Revit 类别细分
assert(byName('管综')?.kids.join(' / ') === '暖通空调 / 给排水 / 电气 / 安防',
  `管综下先分专业方向（按业务序）：${byName('管综')?.kids.join(' / ')}`);

const nodeAt = (...names) => {
  let cur = { kids: info.tree };
  for (const n of names) cur = cur?.kids?.find((k) => k.name === n);
  return cur;
};
assert(nodeAt('管综', '暖通空调')?.kids.map((k) => k.name).join(' / ') === '风管 / 管道',
  `管综 › 暖通空调 下按 Revit 类别：${nodeAt('管综', '暖通空调')?.kids.map((k) => k.name).join(' / ')}`);
assert(nodeAt('管综', '暖通空调', '风管')?.count === 1
  && nodeAt('管综', '暖通空调', '管道')?.count === 1, '管综 › 暖通空调 › 风管 / 管道 各 1 件');
assert(nodeAt('管综', '给排水', '管道附件')?.count === 1, '管综 › 给排水 › 管道附件 1 件（压力传感器）');
assert(nodeAt('管综', '电气', '电缆桥架')?.count === 1, '管综 › 电气 › 电缆桥架 1 件（强电桥架）');
assert(nodeAt('管综', '安防', '其他分类')?.count === 1,
  '管综 › 安防 › 其他分类 1 件（手工模型没有 Revit 类别）');

// 专业方向与第 1 层「同名同色」：名字取自同一张 DISCIPLINES 表，色点也是同一套 disc-XXX
const pipeDiscs = await p.evaluate(() => {
  const top = window.__bim.tree.root.children;
  const pipe = top.find((n) => n.name === '管综');
  const codeOf = (name) => top.find((n) => n.name === name)?.discCode || '';
  return {
    pipeCode: pipe?.discCode || '',
    hvac: codeOf('暖通空调'),
    hvacInPipe: pipe?.children.find((n) => n.name === '暖通空调')?.discCode || '',
    plumbInPipe: pipe?.children.find((n) => n.name === '给排水')?.discCode || '',
    elecInPipe: pipe?.children.find((n) => n.name === '电气')?.discCode || '',
  };
});
assert(!pipeDiscs.pipeCode, '管综一级自身不挂专业色（中性灰点）');
assert(pipeDiscs.hvac === 'HVAC' && pipeDiscs.hvacInPipe === 'HVAC',
  `管综 › 暖通空调 与第 1 层「暖通空调」同色（${pipeDiscs.hvacInPipe}）`);
assert(pipeDiscs.plumbInPipe === 'PLUMB' && pipeDiscs.elecInPipe === 'ELEC',
  `专业方向各自用本专业的色（给排水 ${pipeDiscs.plumbInPipe} / 电气 ${pipeDiscs.elecInPipe}）`);

// 计数细项
const at = (pathStr) => {
  const [a, b2] = pathStr.split(' > ');
  return info.tree.find((n) => n.name === a)?.kids.find((k) => k.name === b2);
};
assert(at('电气 > 配电柜')?.count === 2, '电气 > 配电柜 2 件');
assert(at('智能化 > 智能照明')?.count === 1, '智能化 > 智能照明 1 件（手工筒灯，按系统名）');
assert(at('智能化 > 智慧安防')?.count === 1, '智能化 > 智慧安防 1 件（手工摄像头）');
assert(byName('智能化')?.count === 2, `智能化一级共 2 件，实际 ${byName('智能化')?.count}`);
assert(at('暖通空调 > 风机盘管')?.count === 1, '暖通空调 > 风机盘管 1 件');

// 建筑构件不被「电梯」抓走：电梯井道轻质隔墙仍在「建筑 > 墙」
// 名字带「防火」的 3H 防火板墙同理 —— 墙就是墙，不进消防专业
assert(at('建筑 > 墙')?.count === 3,
  `建筑 > 墙 3 件（含电梯井道隔墙与 3H 防火板墙），实际 ${at('建筑 > 墙')?.count}`);
assert(!info.top.some((t) => t.name === '消防'), '消防里没有墙 —— 防火板墙没被「防火」二字拉走');
assert(!info.top.some((t) => t.name === '电梯设备'), '没有凭空出现「电梯设备」分类');

// 悬浮提示：管综下的两层各是什么（专业方向 / Revit 类别），别把「专业」说成「设备分类」
const pipeTitles = await p.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const nm = (r) => r.querySelector('.node-name')?.textContent;
  const row = (name, depth) => [...document.querySelectorAll('#tree .node')]
    .find((r) => nm(r) === name && r.__node?.depth === depth);
  row('管综', 1)?.querySelector('.node-caret')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(250);
  const sub = row('暖通空调', 2);
  const subTitle = sub?.title || '';
  sub?.querySelector('.node-caret')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(250);
  return { subTitle, catTitle: row('风管', 3)?.title || '' };
});
assert(pipeTitles.subTitle.startsWith('专业：暖通空调'),
  `管综下的第 2 层标成「专业」（${pipeTitles.subTitle.split('\n')[0]}）`);
assert(pipeTitles.catTitle.startsWith('类别：风管'),
  `管综 › 专业下的第 3 层标成「类别」（${pipeTitles.catTitle.split('\n')[0]}）`);

// 手工件（无 extras）路径：专业 > 设备分类 > 构件
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
assert(lampPath.join(' > ') === '智能化 > 智能照明 > 智能照明_筒灯001',
  `手工智能化模型路径：${lampPath.join(' > ')}`);

// 与其它视图同源：叶子数 = 构件数，且与主干视图一致
assert(info.leafCount === 18 && info.leafCount === base.leaves,
  `叶子 ${info.leafCount} 个 = 主干视图 ${base.leaves} 个 = 构件 ${base.recs} 个（切换视图不重不漏）`);
assert(info.leafNames.includes('送风管 SF 1') && info.leafNames.includes('生活水箱 30m³'),
  '管综与设备的构件都还在树里');

// 管综单独成一级的意义：取消勾选 → 只剩设备
const hidden = await p.evaluate(() => {
  const row = [...document.querySelectorAll('#tree .node')].find((r) => r.querySelector('.node-name')?.textContent === '管综');
  row?.querySelector('input.node-vis')?.click();
  return !!row;
});
assert(hidden, '找到「管综」行的勾选框');

// 格式一致：管综这一行要和上面各专业一样带圆点（.node.disc），文字才对齐
const dots = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('#tree .node')];
  const pick = (name) => rows.find((r) => r.querySelector('.node-name')?.textContent === name);
  const left = (r) => r?.querySelector('.node-name')?.getBoundingClientRect().left;
  const pipe = pick('管综');
  const smart = pick('智能化');
  const hvac = pick('暖通空调');
  return {
    pipeDisc: !!pipe?.classList.contains('disc'),
    hvacDisc: !!hvac?.classList.contains('disc'),
    smartDisc: !!smart?.classList.contains('disc'),
    smartCls: !!smart?.classList.contains('disc-smart'),
    pipeNameLeft: left(pipe),
    hvacNameLeft: left(hvac),
    smartNameLeft: left(smart),
  };
});
assert(dots.hvacDisc && dots.pipeDisc && dots.smartDisc,
  '「智能化」「管综」与专业行同一套格式（带圆点）');
assert(dots.smartCls, '「智能化」用自己的淡紫点（不借专业色）');

// 悬浮提示：说明这一级收的是什么、为什么单独成一级、展开后看什么
const smartTitle = await p.evaluate(() => [...document.querySelectorAll('#tree .node')]
  .find((r) => r.querySelector('.node-name')?.textContent === '智能化')?.title || '');
assert(smartTitle.includes('智能 / 智慧 / 智控') && smartTitle.includes('管综'),
  `「智能化」的悬浮提示说明收录口径与管综边界（${smartTitle.split('\n')[1] || '空'}）`);
assert(Math.abs(dots.pipeNameLeft - dots.hvacNameLeft) < 1.5
  && Math.abs(dots.smartNameLeft - dots.hvacNameLeft) < 1.5,
  `文字左缘对齐（管综 ${dots.pipeNameLeft} / 智能化 ${dots.smartNameLeft} / 暖通 ${dots.hvacNameLeft}）`);
await p.waitForTimeout(400);
const st = await p.evaluate(() => {
  let on = 0; const off = [];
  const walk = (n) => {
    if (n.recs) for (const r of n.recs) { if (r.visible === false) off.push(n.name); else on++; }
    for (const c of n.children) walk(c);
  };
  walk(window.__bim.tree.root);
  return { on, off };
});
assert(st.off.length === 5 && st.on === 13, `隐藏 5 件管综，剩 13 件设备：${st.off.join('、')}`);
assert(st.off.includes('智能化_电缆桥架001'), '带「智能」的桥架仍归管综，跟着一起隐藏');
assert(!st.off.includes('智能照明_筒灯001'), '智能化设备留在「智能化」一级里，没被管综带走');
assert(!st.off.includes('生活水箱 30m³') && !st.off.includes('低压配电柜 GCS-1'), '设备没有被误隐藏');

assert(errs.length === 0, `无页面报错${errs.length ? '：' + errs[0] : ''}`);

await p.screenshot({ path: path.join(HERE, 'shot-tree-disc-equip.png'), clip: { x: 0, y: 60, width: 340, height: 520 } });
await b.close();
console.log(process.exitCode ? '\n有断言失败' : '\n全部通过');
