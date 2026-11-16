/**
 * tree-system.mjs —— 层级树「系统（缩写）」分组：编号不参与归属
 * node test/tree-system.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'fixture-systems.glb');
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

// 切到「系统（缩写） → 类别」
await p.selectOption('#treeGroup', 'system');
await p.waitForTimeout(600);

const groups = await p.evaluate(() => {
  const { tree } = window.__bim;
  return tree.root.children.map((n) => ({
    name: n.name,
    count: n.count,
    raws: n.raws ? [...n.raws] : [],
    kids: n.children.map((c) => c.name),
    hint: n.hint || '',
    hintFrom: n.hintFrom || '',
  }));
});
console.log('系统分组', JSON.stringify(groups, null, 1));

const names = groups.map((g) => g.name).sort();
assert(names.join(',') === 'CN,CR,CWP,QQ', `按缩写归类：${names.join(' / ')}（CN 变体 + cn-9 合并为 CN）`);

// 缩写后面要跟中文系统名：内置对照命中 + 表里没有时用类型名兜底
const cnHint = groups.find((g) => g.name === 'CN');
assert(cnHint.hint === '冷凝水' && cnHint.hintFrom === 'dict', `CN 后显示中文名「${cnHint?.hint}」（内置对照）`);
const cwpHint = groups.find((g) => g.name === 'CWP');
assert(cwpHint.hint === '冷却水泵' && cwpHint.hintFrom === 'dict', `CWP 后显示「${cwpHint?.hint}」`);
const qqHint = groups.find((g) => g.name === 'QQ');
assert(qqHint.hint === '特殊管' && qqHint.hintFrom === 'data', `未登记缩写 QQ 用类型名兜底显示「${qqHint?.hint}」`);

const cn = groups.find((g) => g.name === 'CN');
assert(cn.count === 4, `CN 合并了 4 个构件（CN 5 / CN 7 / CN 15 / cn-9），实际 ${cn?.count}`);
assert(cn.raws.length === 4, `CN 组保留了 4 种原始取值（悬浮可见），实际 ${cn?.raws.length}`);
assert(cn.kids.includes('风管') && cn.kids.includes('管道'), `CN 下按类别分层：${cn?.kids.join(' / ')}`);

const cr = groups.find((g) => g.name === 'CR');
assert(cr.count === 1 && cr.raws[0] === 'CR 30,CR 18', '多系统值 "CR 30,CR 18" 归到 CR，不另立类别');

const cwp = groups.find((g) => g.name === 'CWP');
assert(cwp.count === 1 && cwp.raws[0] === 'CWP 3', 'CWP 3 归 CWP（编号不参与判定）');

// 三级模式也存在且能建出三层
await p.selectOption('#treeGroup', 'systemType');
await p.waitForTimeout(600);
const depth3 = await p.evaluate(() => {
  const g = window.__bim.tree.root.children.find((n) => n.name === 'CN');
  return { l1: g?.name, l2: g?.children.map((c) => c.name), l3: g?.children[0]?.children.map((c) => c.name) };
});
console.log('三级分组', JSON.stringify(depth3));
assert(depth3.l2?.includes('风管') && depth3.l3?.length > 0, '「系统 → 类别 → 类型」三级可用');

assert(errs.length === 0, `无页面报错${errs.length ? '：' + errs.join(' | ') : ''}`);
await b.close();
