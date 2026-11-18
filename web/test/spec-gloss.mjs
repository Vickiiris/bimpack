/**
 * spec-gloss.mjs —— 旧版高光-光泽度材质（KHR_materials_pbrSpecularGlossiness）
 *
 * 这类材质在 3ds Max / 早期 Substance 导出里很常见，three r157 之后**不再支持**：
 * GLTFLoader 读不到 baseColor，只能退回「白 + metalness 1」的默认材质 ——
 * 表现出来就是模型发黑或惨白（与「PBR 全黑」的投诉很像，但成因不同）。
 *
 * 现在加载时会先体检扩展、再就地转成金属-粗糙度（gltf-transform 的 metalRough），
 * 所以进渲染器时已经是标准 PBR。
 *
 * node test/spec-gloss.mjs   （需先 npm run dev）
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMaterialExtensions, convertSpecGloss } from '../src/core/material.js';
import { readJSON } from '../src/core/glb.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'fixture-specgloss.glb');
const URL = process.env.URL || 'http://localhost:5173/';

const assert = (cond, msg) => {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; }
  else console.log('✓ ' + msg);
};

// ---------- 1) 纯 Node：体检 + 转换 ----------
const bytes = new Uint8Array(readFileSync(FILE));
const before = auditMaterialExtensions(readJSON(bytes));
assert(before.specGloss === true, '体检认出了旧版高光材质扩展');

const conv = await convertSpecGloss(bytes);
const afterJson = readJSON(conv.bytes);
const after = auditMaterialExtensions(afterJson);
assert(conv.converted === 1 && after.specGloss === false, `转换完成：${conv.converted} 个材质，扩展已移除`);
const m = afterJson.materials[0];
assert(m.pbrMetallicRoughness?.metallicFactor === 0 && m.pbrMetallicRoughness?.roughnessFactor > 0,
  `转成金属-粗糙度（metallic=${m.pbrMetallicRoughness?.metallicFactor}, roughness=${m.pbrMetallicRoughness?.roughnessFactor}）`);
const base = m.pbrMetallicRoughness?.baseColorFactor || [];
assert(base[0] > 0.7 && base[0] > base[1] * 3, `漫反射颜色保留（baseColor=${base.map((v) => v.toFixed(2)).join(',')}）`);

// ---------- 2) 浏览器：加载后材质正确、不报错 ----------
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.setInputFiles('#fileInput', FILE);
await p.waitForFunction(() => document.querySelectorAll('#tree .node').length > 0, null, { timeout: 120000 });
await p.waitForTimeout(900);

const info = await p.evaluate(() => {
  const mat = window.__bim.state.batched.batches[0].batch.material;
  return {
    note: window.__bim.state.matNote || '',
    color: mat.color ? mat.color.getHexString() : '',
    metalness: mat.metalness,
    hasEnv: !!mat.envMap,
  };
});
console.log('  页面状态', JSON.stringify(info));
assert(info.note.includes('转为金属-粗糙度'), `加载时就地转换并提示：「${info.note}」`);
const r = parseInt(info.color.slice(0, 2), 16);
const g = parseInt(info.color.slice(2, 4), 16);
assert(r > 120 && r > g + 40, `材质颜色是红色系而不是默认白（#${info.color}）`);
assert(info.metalness === 0, `金属度已归零（metalness=${info.metalness}）`);

await p.screenshot({ path: path.join(HERE, 'shot-specgloss.png'), clip: { x: 250, y: 50, width: 540, height: 500 } });
assert(errs.length === 0, `无页面报错${errs.length ? '：' + errs.join(' | ') : ''}`);
await b.close();
console.log(process.exitCode ? '\n有断言失败' : '\n全部通过');
