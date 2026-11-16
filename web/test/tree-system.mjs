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
assert(names.join(',') === 'CN,CR,CWP,EAD,QQ,XX', `按缩写归类：${names.join(' / ')}`);

const byName = (n) => groups.find((g) => g.name === n);

// 中文名优先级 ①模型自带「系统类型」 —— 与属性面板的 系统类型 EAD-排风管 对齐
const ead = byName('EAD');
assert(ead.count === 2, `EAD 合并 2 个构件（EAD 5 / EAD 6），实际 ${ead?.count}`);
assert(ead.hint === '排风管' && ead.hintFrom === 'sysType', `EAD 显示「${ead?.hint}」（来自系统类型 EAD-排风管）`);

// ② 只有「系统分类」
const xx = byName('XX');
assert(xx.hint === '给水' && xx.hintFrom === 'sysCat', `XX 显示「${xx?.hint}」（来自系统分类）`);

// ③ 内置对照表
const cn = byName('CN');
assert(cn.hint === '冷凝水' && cn.hintFrom === 'dict', `CN 显示「${cn?.hint}」（内置对照）`);
const cwp = byName('CWP');
assert(cwp.hint === '冷却水泵' && cwp.hintFrom === 'dict', `CWP 显示「${cwp?.hint}」（内置对照）`);

// ④ 都没有 → 类型名兜底
const qq = byName('QQ');
assert(qq.hint === '特殊管' && qq.hintFrom === 'data', `QQ 显示「${qq?.hint}」（类型名兜底）`);

assert(cn.count === 4, `CN 合并了 4 个构件（CN 5 / CN 7 / CN 15 / cn-9），实际 ${cn?.count}`);
assert(cn.raws.length === 4, `CN 组保留了 4 种原始取值（悬浮可见），实际 ${cn?.raws.length}`);
assert(cn.kids.includes('风管') && cn.kids.includes('管道'), `CN 下按类别分层：${cn?.kids.join(' / ')}`);

const cr = groups.find((g) => g.name === 'CR');
assert(cr.count === 1 && cr.raws[0] === 'CR 30,CR 18', '多系统值 "CR 30,CR 18" 归到 CR，不另立类别');

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
