/**
 * pbr-metal.mjs —— PBR 金属材质不能渲成纯黑
 *
 * 回归背景：PBR 的金属（metalness=1）几乎没有漫反射，颜色全靠**环境反射**。
 * 早先视口只有平行光、没有 IBL，用户上传 PBR 模型看到的就是一整片黑
 * （见 fixture-metal.glb：左边金属块、右边粗糙灰块）。
 *
 * 现在：scene.js 用 RoomEnvironment 生成 PMREM 贴图，bim-batch 只把它挂给
 * 金属 / 透射玻璃材质（电介质不挂，否则灰墙会被洗白）。
 *
 * node test/pbr-metal.mjs   （需先 npm run dev）
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'fixture-metal.glb');
const URL = process.env.URL || 'http://localhost:5173/';

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.setInputFiles('#fileInput', FILE);
await p.waitForFunction(() => document.querySelectorAll('#tree .node').length > 0, null, { timeout: 120000 });
await p.waitForTimeout(1200);

const assert = (cond, msg) => {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; }
  else console.log('✓ ' + msg);
};

// 1) 材质层面：金属挂了环境贴图，电介质没挂
const mats = await p.evaluate(() => window.__bim.state.batched.batches.map((x) => ({
  name: x.batch.material.name,
  metalness: x.batch.material.metalness,
  hasEnv: !!x.batch.material.envMap,
  intensity: x.batch.material.envMapIntensity,
})));
const metal = mats.find((m) => m.name === 'PolishedMetal');
const plaster = mats.find((m) => m.name === 'Plaster');
assert(metal?.hasEnv === true, `金属材质挂上了环境贴图（envMapIntensity=${metal?.intensity}）`);
assert(plaster?.hasEnv === false, '电介质材质不挂环境贴图（避免灰墙被洗白）');

// 2) 像素层面：画布上不能出现大片纯黑
const box = await p.evaluate(() => {
  const c = document.querySelector('#viewport canvas') || document.querySelector('canvas');
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});
const shot = await p.screenshot({ clip: box });
const { data, info } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
let dark = 0, sum = 0;
const n = info.width * info.height;
for (let i = 0; i < data.length; i += info.channels) {
  const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  sum += l;
  if (l < 40) dark++;
}
const darkPct = dark / n * 100;
const mean = sum / n;
console.log(`  画布 ${info.width}×${info.height}，平均亮度 ${mean.toFixed(1)}，近黑像素 ${darkPct.toFixed(2)}%`);
assert(darkPct < 1, `没有大片纯黑（近黑像素 ${darkPct.toFixed(2)}% < 1%）`);
assert(mean > 150, `整幅画面没有被压暗（平均亮度 ${mean.toFixed(1)} > 150）`);

assert(errs.length === 0, `无页面报错${errs.length ? '：' + errs.join(' | ') : ''}`);
await p.screenshot({ path: path.join(HERE, 'shot-metal.png'), clip: { x: 250, y: 50, width: 540, height: 500 } });
await b.close();
console.log(process.exitCode ? '\n有断言失败' : '\n全部通过');
