/**
 * e2e.mjs —— 用真实 Chrome 走一遍前端流程
 *
 *   node test/e2e.mjs                    测小文件（默认 test/fixture.glb）
 *   node test/e2e.mjs <某个.glb>          测指定文件
 *   node test/e2e.mjs <file> --no-process 只测查看，不跑压缩
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || path.join(ROOT, '../test/fixture.glb');
const doProcess = !args.includes('--no-process');
const URL = process.env.URL || 'http://localhost:5173/';

const log = (...a) => console.log(...a);
const errors = [];
const consoleErrs = [];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--js-flags=--max-old-space-size=8192'],
});

const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });

page.on('pageerror', (e) => { errors.push(e.message); });
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrs.push(m.text());
});

const t0 = Date.now();
log(`\n打开 ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#dropzone', { state: 'visible', timeout: 15000 });

log(`上传 ${path.basename(file)}（${(fs.statSync(file).size / 1048576).toFixed(2)} MB）`);
await page.setInputFiles('#fileInput', file);

// 等左右面板出现 = 模型已渲染完
let ok = true;
try {
  await page.waitForSelector('#fileInfo', { state: 'visible', timeout: 600000 });
  await page.waitForFunction(() => document.querySelectorAll('#tree .node').length > 0, null, { timeout: 600000 });
} catch {
  ok = false;
  log('✗ 模型未在 180 秒内渲染完成');
}

const shot = async (name) => {
  const p = path.join(ROOT, 'test', `shot-${name}.png`);
  try {
    // 软件渲染 700 万顶点时截图很慢，失败也不影响结论
    await page.screenshot({ path: p, fullPage: false, timeout: 120000, animations: 'disabled' });
    log(`  截图 ${p}`);
  } catch {
    log('  截图跳过（渲染太慢，非功能问题）');
  }
};

if (ok) {
  await page.waitForTimeout(1200);

  const stats = await page.evaluate(() => ({
    file: document.getElementById('fileName')?.textContent,
    chips: [...document.querySelectorAll('.chip')].map((c) => c.textContent),
    draw: document.getElementById('hudDraw')?.textContent,
    tri: document.getElementById('hudTri')?.textContent,
    parts: document.getElementById('hudParts')?.textContent,
    treeCount: document.getElementById('treeCount')?.textContent,
    treeRows: document.querySelectorAll('#tree .node').length,
    progress: document.getElementById('pcLog')?.textContent || '',
  }));

  log('\n— 渲染结果 —');
  log(`  文件      ${stats.file}`);
  log(`  标签      ${stats.chips.join(' | ')}`);
  log(`  draw call ${stats.draw}`);
  log(`  三角面    ${stats.tri}`);
  log(`  构件      ${stats.parts}`);
  log(`  层级树    ${stats.treeCount} / 已渲染 ${stats.treeRows} 行`);

  // 分组树默认只展开到「类别」，先逐层展开到出现构件行（◆）再点
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 6; i++) {
      if (document.querySelector('#tree .node .node-icon.mesh')) return;
      const closed = [...document.querySelectorAll('#tree .node.is-group')]
        .filter((r) => r.__node?.depth >= 1 && !(r.__wrap && r.__wrap.classList.contains('open')));
      if (!closed.length) return;
      closed[0].querySelector('.node-caret')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await wait(60);
    }
  });
  await page.waitForTimeout(200);
  const meshRow = page.locator('#tree .node', { has: page.locator('.node-icon.mesh') }).first();
  const hasMeshRow = await meshRow.count();
  if (hasMeshRow) {
    await meshRow.click();
    await page.waitForTimeout(700);
    const prop = await page.evaluate(() => ({
      count: document.getElementById('propCount')?.textContent,
      rows: document.querySelectorAll('#props .prop-row').length,
      first: document.querySelector('#props .prop-row .prop-val')?.textContent,
    }));
    log(`\n— 点选构件 —`);
    log(`  属性面板 ${prop.rows} 行，标题计数 ${prop.count}，首个值 ${prop.first}`);
    await shot('tree-select');
  } else {
    log('  ⚠ 树上没有找到 mesh 节点');
  }

  if (doProcess) {
    log('\n— 压缩处理 —');
    const tP = Date.now();
    await page.evaluate(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); });
    await page.click('#btnProcess');
    await page.waitForSelector('.toast', { timeout: 900000 });
    await page.waitForTimeout(500);
    const proc = await page.evaluate(() => ({
      chips: [...document.querySelectorAll('.chip')].map((c) => c.textContent),
      draw: document.getElementById('hudDraw')?.textContent,
      parts: document.getElementById('hudParts')?.textContent,
      treeCount: document.getElementById('treeCount')?.textContent,
      toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
    }));
    log(`  耗时 ${((Date.now() - tP) / 1000).toFixed(1)} s`);
    log(`  结果 ${proc.toast.join(' / ')}`);
    log(`  标签 ${proc.chips.join(' | ')}`);
    log(`  draw call ${proc.draw} · 构件 ${proc.parts} · 树 ${proc.treeCount}`);
    await shot('after-process');
  }
}

log('\n— 报错 —');
log(`  pageerror: ${errors.length}${errors.length ? '\n    ' + errors.join('\n    ') : ''}`);
log(`  console.error: ${consoleErrs.length}${consoleErrs.length ? '\n    ' + consoleErrs.slice(0, 8).join('\n    ') : ''}`);
log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s`);

await browser.close();
process.exit(ok && errors.length === 0 ? 0 : 1);
