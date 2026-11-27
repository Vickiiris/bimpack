/**
 * verify-view.mjs —— 校验「取景 / 层级树 / 面板收起」三件事
 * node test/verify-view.mjs <glb 路径>
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FILE = process.argv[2] || 'C:/Users/sjzn/WorkBuddy/2026-11-11-16-13-06/bimpack/test/fixture.glb';
const URL = process.env.URL || 'http://localhost:5173/';

const b = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=8192'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.setInputFiles('#fileInput', FILE);
await p.waitForFunction(() => document.querySelectorAll('#tree .node').length > 0, null, { timeout: 600000 });
await p.waitForTimeout(1200);

/** 相机是否把整个模型放进视锥：8 个角点投影到 NDC 必须都在 [-1,1] */
const view = await p.evaluate(() => {
  const { viewer } = window.__bim;
  const box = viewer.modelBox.clone();
  const cam = viewer.camera;
  cam.updateMatrixWorld(true);
  const pts = [];
  for (let i = 0; i < 8; i++) {
    pts.push(new (box.min.constructor)(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z
    ).clone());
  }
  const out = pts.map((v) => {
    const q = v.clone().project(cam);
    return { x: +q.x.toFixed(3), y: +q.y.toFixed(3), z: +q.z.toFixed(3) };
  });
  const maxAbs = Math.max(...out.flatMap((o) => [Math.abs(o.x), Math.abs(o.y)]));
  return {
    size: box.getSize(new (box.min.constructor)()).toArray().map((n) => Math.round(n)),
    camPos: cam.position.toArray().map((n) => Math.round(n)),
    target: viewer.controls.target.toArray().map((n) => Math.round(n)),
    dist: Math.round(cam.position.distanceTo(viewer.controls.target)),
    maxDistance: Math.round(viewer.controls.maxDistance),
    aspect: +cam.aspect.toFixed(2),
    ndcMaxAbs: +maxAbs.toFixed(3),
    insideFrame: maxAbs <= 1,
    corners: out,
  };
});
console.log('\n=== 取景 ===');
console.log(`  模型尺寸 ${view.size.join(' × ')}  相机距离 ${view.dist}  (maxDistance ${view.maxDistance}, aspect ${view.aspect})`);
console.log(`  8 角点 NDC 最大 |值| = ${view.ndcMaxAbs}  →  ${view.insideFrame ? '✓ 全在画面内' : '✗ 被裁切'}`);

/** 层级树结构 */
const treeInfo = await p.evaluate(() => {
  const { tree } = window.__bim;
  const root = tree.root;
  const top = root.children.slice(0, 8).map((n) => ({ name: n.name, count: n.count, group: n.isGroup }));
  const first = root.children.find((n) => n.isGroup);
  const second = first ? first.children.slice(0, 5).map((n) => ({ name: n.name, count: n.count, group: n.isGroup })) : [];
  return {
    mode: tree.mode,
    rootName: root.name,
    topCount: root.children.length,
    top,
    firstGroup: first?.name,
    firstGroupChildren: second,
    total: document.getElementById('treeCount').textContent,
    rows: document.querySelectorAll('#tree .node').length,
    depths: [...document.querySelectorAll('#tree .node')].slice(0, 6).map((r) => r.style.paddingLeft),
  };
});
console.log('\n=== 层级树 ===');
console.log(`  模式 ${treeInfo.mode}　根「${treeInfo.rootName}」顶层 ${treeInfo.topCount} 组　${treeInfo.total}`);
treeInfo.top.forEach((t) => console.log(`   · ${t.name}${t.group ? `（${t.count}）` : ''}`));
console.log(`  「${treeInfo.firstGroup}」下：${treeInfo.firstGroupChildren.map((c) => `${c.name}${c.group ? `(${c.count})` : ''}`).join(' / ') || '（无）'}`);
console.log(`  已渲染行数 ${treeInfo.rows}　缩进 ${treeInfo.depths.join(', ')}`);

/** 单击构件：相机不应移动 */
const before = await p.evaluate(() => window.__bim.viewer.camera.position.toArray());
const clicked = await p.evaluate(() => {
  // 逐层展开，直到出现叶子行（分组是 类别 → 类型 → 构件 三层）
  for (let guard = 0; guard < 6; guard++) {
    const hasLeaf = [...document.querySelectorAll('#tree .node')].some((r) => r.__node && !r.__node.isGroup);
    if (hasLeaf) break;
    const closed = [...document.querySelectorAll('#tree .node')].filter(
      (r) => r.classList.contains('is-group') && r.__node?.depth >= 1
        && !(r.__wrap && r.__wrap.classList.contains('open'))
    );
    if (!closed.length) break;
    closed[0].querySelector('.node-caret')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  const leaf = [...document.querySelectorAll('#tree .node')].find((r) => r.__node && !r.__node.isGroup);
  leaf?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { leaf: leaf?.__node?.name, propRows: document.querySelectorAll('#props .prop-row').length, rows: document.querySelectorAll('#tree .node').length };
});
await p.waitForTimeout(400);
const after = await p.evaluate(() => window.__bim.viewer.camera.position.toArray());
const moved = Math.hypot(...before.map((v, i) => v - after[i]));
console.log('\n=== 单击构件 ===');
console.log(`  点「${clicked.leaf}」→ 属性 ${clicked.propRows} 行　相机位移 ${moved.toFixed(3)}  →  ${moved < 1 ? '✓ 没动' : '✗ 动了'}`);

/** 双击：应该定位过去 */
await p.evaluate(() => {
  const leaf = [...document.querySelectorAll('#tree .node')].find((r) => r.__node && !r.__node.isGroup);
  leaf?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
});
await p.waitForTimeout(900);   // 相机是平滑过渡（约 620ms），等动画结束再量
const afterDbl = await p.evaluate(() => window.__bim.viewer.camera.position.toArray());
const movedDbl = Math.hypot(...after.map((v, i) => v - afterDbl[i]));
console.log(`  双击 → 相机位移 ${movedDbl.toFixed(1)}  →  ${movedDbl > 1 ? '✓ 已定位' : '✗ 没动'}`);

/** 面板收起（先回到"适应视图"，否则测的是刚才双击放大后的画面） */
await p.evaluate(() => document.getElementById('btnFit').click());
await p.waitForTimeout(800);
const panels = await p.evaluate(async () => {
  const snap = () => ({
    left: !document.getElementById('panelLeft').hidden,
    right: !document.getElementById('panelRight').hidden,
    cols: getComputedStyle(document.getElementById('layout')).gridTemplateColumns,
    canvasW: document.getElementById('canvas').clientWidth,
    fit: (() => {
      const { viewer } = window.__bim;
      const cam = viewer.camera;
      const box = viewer.modelBox.clone();
      let m = 0;
      for (let i = 0; i < 8; i++) {
        const v = new (box.min.constructor)(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z
        ).clone().project(cam);
        m = Math.max(m, Math.abs(v.x), Math.abs(v.y));
      }
      return +m.toFixed(3);
    })(),
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = snap();
  document.getElementById('btnTree').click();
  await wait(500);
  const b2 = snap();
  document.getElementById('btnProps').click();
  await wait(500);
  const c = snap();
  return { both: a, noLeft: b2, none: c };
});
console.log('\n=== 面板收起 ===');
console.log(`  初始   左${panels.both.left ? '开' : '关'}/右${panels.both.right ? '开' : '关'}  画布 ${panels.both.canvasW}px  NDC ${panels.both.fit}`);
console.log(`  关树   左${panels.noLeft.left ? '开' : '关'}/右${panels.noLeft.right ? '开' : '关'}  画布 ${panels.noLeft.canvasW}px  NDC ${panels.noLeft.fit}  ${panels.noLeft.fit <= 1 ? '✓' : '✗'}`);
console.log(`  全关   左${panels.none.left ? '开' : '关'}/右${panels.none.right ? '开' : '关'}  画布 ${panels.none.canvasW}px  NDC ${panels.none.fit}  ${panels.none.fit <= 1 ? '✓' : '✗'}`);

/** 适应视图按钮 */
await p.evaluate(() => document.getElementById('btnFit').click());
await p.waitForTimeout(800);
const fitAgain = await p.evaluate(() => {
  const { viewer } = window.__bim;
  const box = viewer.modelBox.clone();
  let m = 0;
  for (let i = 0; i < 8; i++) {
    const v = new (box.min.constructor)(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z
    ).clone().project(viewer.camera);
    m = Math.max(m, Math.abs(v.x), Math.abs(v.y));
  }
  return +m.toFixed(3);
});
console.log(`  适应视图 → NDC ${fitAgain}  ${fitAgain <= 1 ? '✓' : '✗'}`);

try {
  await p.screenshot({ path: path.join(ROOT, 'test/shot-view.png'), timeout: 120000 });
  console.log('\n截图 test/shot-view.png');
} catch { console.log('\n截图跳过（渲染慢）'); }

console.log('\n=== 报错 ===');
errs.slice(0, 8).forEach((e) => console.log('  ' + e));
if (!errs.length) console.log('  （无）');
await b.close();
