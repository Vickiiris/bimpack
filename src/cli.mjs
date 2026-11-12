#!/usr/bin/env node
/**
 * bimpack —— BIM GLB 处理工具链
 *
 *   node src/cli.mjs inspect <file.glb>            体检（秒级，不解码几何）
 *   node src/cli.mjs build   <file.glb> [选项]     全流程：修版本 → Draco → 校验 → 预压缩 → 报告
 *   node src/cli.mjs verify  <a.glb> <b.glb>       只比两个文件（属性 + 可选几何）
 *   node src/cli.mjs serve   [--run <名字>]        起 viewer 演示
 *
 * build 选项：
 *   --preset high|balance|small   量化位深预设（默认 balance；源已是 Draco 时自动升为 high）
 *   --out <dir>                   输出根目录（默认 ./out）
 *   --name <slug>                 输出目录名（默认取文件名净化）
 *   --no-geo                      跳过解码级几何比对（快，但少了保真度数据）
 *   --no-gzip                     不生成 .gz（只要 .br 时用）
 *   --force                       即使目标已存在也重跑
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { parseGLB, fixAssetVersion, readJSON } from './glb.mjs';
import { inspect } from './inspect.mjs';
import { compressDraco } from './compress.mjs';
import { compareJSON, compareGeometry } from './verify.mjs';
import { precompress } from './precompress.mjs';
import { renderReport } from './report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB');
const pct = (a, b) => {
  if (!b) return '—';
  const d = (1 - a / b) * 100;
  return (d >= 0 ? '−' : '+') + Math.abs(d).toFixed(1) + '%';
};
const ms = (t) => (t < 1000 ? `${t} ms` : `${(t / 1000).toFixed(1)} s`);

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

/** 文件名 → 目录名/URL 安全 slug（保留中文，去掉 & ? # 等） */
export function slugify(name) {
  return name
    .replace(/\.glb$/i, '')
    .replace(/^\d{14}-/, '')          // 去掉上传时加的时间戳前缀（20261111192728-xxx.glb）
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'model';
}

function readConfig() {
  const p = path.join(ROOT, 'bim.config.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return {};
}

/**
 * 大文件在默认堆下会 OOM，这里用子进程重跑自己并放大堆。
 * 只做一次（靠环境变量防递归），用户无感。
 */
function ensureHeap(minMB = 8192) {
  if (process.env.BIMPACK_HEAP === '1') return false;
  const heapFlag = process.execArgv.find((a) => a.startsWith('--max-old-space-size'));
  if (heapFlag && Number(heapFlag.split('=')[1]) >= minMB) return false;
  const r = spawnSync(
    process.execPath,
    [`--max-old-space-size=${minMB}`, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, BIMPACK_HEAP: '1' } }
  );
  process.exit(r.status ?? 0);
}

// ---------- 命令：inspect ----------
function cmdInspect(args) {
  const file = args._[1];
  if (!file) return fail('用法: bimpack inspect <file.glb>');
  const buf = fs.readFileSync(file);
  const r = inspect(buf, file);
  if (args.json) return console.log(JSON.stringify(r, null, 2));

  console.log(C.bold(`\n体检：${path.basename(file)}  ${mb(r.total)}`));
  console.log(C.dim('─'.repeat(64)));
  console.log(`  导出器       ${r.asset.generator || '未知'}`);
  console.log(`  glTF 版本    ${r.asset.version}${r.asset.version === '2.0' ? '' : C.yellow('  ← 非法值，需修正')}`);
  console.log(`  扩展         ${r.extensionsUsed.join(', ') || '（无）'}`);
  console.log(`  已 Draco     ${r.alreadyDraco ? C.yellow(`是（${r.dracoPrims}/${r.counts.primitives} 图元）`) : '否'}`);
  console.log();
  console.log(`  节点 / 网格 / 图元   ${r.counts.nodes} / ${r.counts.meshes} / ${r.counts.primitives}`);
  console.log(`  顶点 / 三角面        ${r.geometry.vertices.toLocaleString()} / ${r.geometry.triangles.toLocaleString()}`);
  console.log(`  材质表 / 实际分组    ${r.counts.materials} / ${C.cyan(r.counts.materialGroups)}  ← draw call 数`);
  console.log(`  贴图 / 带 UV 图元    ${r.counts.textures} / ${r.geometry.uvPrims}`);
  console.log();
  console.log(`  BIM 属性节点         ${r.extras.nodesWithExtras}（${r.extras.propEntries.toLocaleString()} 条 / ${r.extras.distinctKeys} 键）`);
  console.log(`  属性占 JSON          ${r.extras.percentOfJSON}%（键名 ${mb(r.extras.keyBytes)}）`);
  console.log();
  if (r.warnings.length) {
    console.log(C.yellow('  注意事项：'));
    for (const w of r.warnings) console.log(`   ${C.yellow('!')} ${w}`);
  } else console.log(C.green('  未发现风险项'));
  console.log();
  return r;
}

// ---------- 命令：build ----------
async function cmdBuild(args) {
  const file = args._[1];
  if (!file || !fs.existsSync(file)) return fail(`找不到文件: ${file}`);

  const cfg = readConfig();
  const t0 = Date.now();
  const base = path.basename(file);
  const slug = slugify(args.name || base);
  const outRoot = path.resolve(ROOT, args.out || cfg.outDir || 'out');
  const outDir = path.join(outRoot, slug);
  const outFile = path.join(outDir, `${slug}.glb`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(C.bold(`\n▶ build  ${base}  ${mb(fs.statSync(file).size)}`));
  console.log(C.dim('─'.repeat(64)));

  // 1. 体检
  const raw = fs.readFileSync(file);
  const inspIn = inspect(raw, file);
  console.log(`  ${C.green('✓')} 体检          节点 ${inspIn.counts.nodes} / 图元 ${inspIn.counts.primitives} / 材质组 ${inspIn.counts.materialGroups}`);
  if (inspIn.warnings.length) for (const w of inspIn.warnings) console.log(`    ${C.yellow('!')} ${w}`);

  // 2. 修 asset.version（3ds Max 会写 "2.1"）
  const fixed = fixAssetVersion(raw);
  let inputBuf = fixed.buf;
  console.log(
    `  ${C.green('✓')} 版本修正      ${fixed.changed ? `${fixed.from} → 2.0` : '无需修正（已是 2.0）'}`
  );

  // 3. Draco 重编码
  //    源已是 Draco 时自动升 high：二次编码不可逆，位深不能再省
  let preset = args.preset || cfg.preset || 'balance';
  if (!args.preset && inspIn.alreadyDraco) preset = 'high';
  const tC = Date.now();
  const { buf: dracoBuf, params } = await compressDraco(inputBuf, { preset });
  console.log(
    `  ${C.green('✓')} Draco 编码     ${mb(raw.length)} → ${mb(dracoBuf.length)}  (${pct(dracoBuf.length, raw.length)}, ` +
      `pos ${params.quantizePosition}bit, ${ms(Date.now() - tC)})`
  );
  fs.writeFileSync(outFile, dracoBuf);

  // 4. 结构 + 属性校验（拿"修过版本"的输入比，避免把版本号差异算成失败）
  const tV = Date.now();
  const verify = compareJSON(inputBuf, dracoBuf, { transformTolerance: Number(cfg.transformTolerance ?? 0.01) });
  const fails = verify.rows.filter((r) => !r.ok);
  console.log(
    `  ${fails.length ? C.red('✗') : C.green('✓')} 属性校验      ${verify.rows.length} 项 · ` +
      (fails.length ? C.red(`失败 ${fails.length} 项`) : '全部通过') +
      C.dim(`  · 变换位移 ${verify.info.maxTransformDisplacement.toExponential(1)} 单位  (${ms(Date.now() - tV)})`)
  );
  for (const f of fails) console.log(`    ${C.red('✗')} ${f.label}: ${f.a} ≠ ${f.b}`);

  // 5. 几何保真（解码级，可选）
  let geo = null;
  if (!args['no-geo']) {
    try {
      const tG = Date.now();
      const { getIO } = await import('./compress.mjs');
      const io = await getIO();
      geo = await compareGeometry(io, inputBuf, dracoBuf, Number(args.samples) || cfg.geoSamples || 350);
      const scale = inspIn.bbox?.extent ? Math.max(...inspIn.bbox.extent) : 0;
      console.log(
        `  ${C.green('✓')} 几何保真      最大偏差 ${geo.maxDeviation.toFixed(3)} 单位` +
          (scale ? ` (模型跨度 ${Math.round(scale)})` : '') +
          ` · 面积差 ${geo.areaDiffPercent.toFixed(4)}%  (${ms(Date.now() - tG)})`
      );
    } catch (e) {
      console.log(`  ${C.yellow('!')} 几何保真跳过  ${e.message}`);
    }
  }

  // 6. 传输层预压缩（校验没过就不产出任何交付物，省时间也省得误发）
  const ok = verify.pass;
  let pc = { ms: {} };
  if (ok) {
    const tP = Date.now();
    const pcCfg = cfg.precompress || {};
    pc = precompress(dracoBuf, {
      ...pcCfg,
      brotli: pcCfg.brotli === false ? false : { ...(pcCfg.brotli || {}) },
      gzip: args['no-gzip'] ? false : (pcCfg.gzip ?? true),
    });
    if (pc.brotli) fs.writeFileSync(outFile + '.br', pc.brotli);
    if (pc.gzip) fs.writeFileSync(outFile + '.gz', pc.gzip);
    console.log(
      `  ${C.green('✓')} 预压缩        ${pc.brotli ? `br ${mb(pc.brotli.length)}` : ''}` +
        `${pc.gzip ? ` · gz ${mb(pc.gzip.length)}` : ''}  (${ms(Date.now() - tP)})`
    );
  } else {
    console.log(`  ${C.yellow('·')} 预压缩        跳过（校验未通过，不产出 .br/.gz 与 manifest）`);
  }

  // 7. 输出体检 + manifest + 报告
  const inspOut = inspect(dracoBuf, outFile);
  const manifest = {
    name: slug,
    title: base.replace(/\.glb$/i, '').replace(/^\d{14}-/, ''),
    model: path.basename(outFile),
    generatedAt: new Date().toISOString(),
    source: file,
    hasTextures: inspOut.counts.textures > 0,
    stats: {
      nodes: inspOut.counts.nodes,
      meshes: inspOut.counts.meshes,
      primitives: inspOut.counts.primitives,
      vertices: inspOut.geometry.vertices,
      triangles: inspOut.geometry.triangles,
      materials: inspOut.counts.materials,
      drawCalls: inspOut.counts.materialGroups,
      bytes: inspOut.total,
      bytesBrotli: pc.brotli?.length ?? null,
    },
    bbox: inspOut.bbox,
    batchGroups: inspOut.batches.map((b) => ({
      name: b.name, geometryCount: b.geometryCount, vertices: b.vertices,
    })),
    draco: params,
    verify: { pass: verify.pass, rows: verify.rows.length },
  };
  if (ok) fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  else {
    // 失败时删掉已写出的模型文件，只留 report.md 供排查
    for (const f of [outFile, outFile + '.br', outFile + '.gz']) fs.existsSync(f) && fs.unlinkSync(f);
  }

  const report = renderReport({
    name: slug,
    source: file,
    output: outFile,
    inspIn,
    inspOut,
    params: { ...params, preset },
    verify,
    geo,
    transferred: pc,
    warnings: inspIn.warnings,
  });
  fs.writeFileSync(path.join(outDir, 'report.md'), report);

  console.log(C.dim('─'.repeat(64)));
  console.log(`  ${C.bold('产出目录')}     ${outDir}`);
  console.log(`  文件          ${path.basename(outFile)}  ${mb(inspOut.total)}` +
    `${pc.brotli ? `  ·  线上传输 ${C.cyan(mb(pc.brotli.length))}` : ''}`);
  console.log(`  报告          report.md / manifest.json`);
  console.log(`  总耗时        ${ms(Date.now() - t0)}`);
  if (!verify.pass) {
    console.log(C.red(`\n✗ 属性校验未通过，此文件不应交付。\n`));
    process.exitCode = 2;
  } else {
    console.log(C.green(`\n✓ 完成。viewer 预览： node src/cli.mjs serve --run ${slug}\n`));
  }
  return { outDir, verify, geo, manifest };
}

// ---------- 命令：verify ----------
async function cmdVerify(args) {
  const [a, b] = [args._[1], args._[2]];
  if (!a || !b) return fail('用法: bimpack verify <a.glb> <b.glb> [--geo]');
  const bufA = fs.readFileSync(a);
  const bufB = fs.readFileSync(b);
  const vr = compareJSON(bufA, bufB);

  console.log(C.bold(`\n校验  ${path.basename(a)}  ↔  ${path.basename(b)}`));
  console.log(C.dim('─'.repeat(72)));
  for (const r of vr.rows) {
    const fmt = (x) => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x ?? ''));
    console.log(`  ${r.ok ? C.green('PASS') : C.red('FAIL')}  ${r.label.padEnd(30)} ${fmt(r.a)}${r.b !== '' ? '  →  ' + fmt(r.b) : ''}`);
  }
  console.log(C.dim('─'.repeat(72)));
  console.log(`  结论：${vr.pass ? C.green('全部通过') : C.red('存在差异')}`);

  if (args.geo) {
    const { getIO } = await import('./compress.mjs');
    const io = await getIO();
    const g = await compareGeometry(io, bufA, bufB, Number(args.samples) || 350);
    console.log(`  几何：最大偏差 ${g.maxDeviation.toFixed(4)} · 平均 ${g.meanDeviation.toFixed(5)} · 面积差 ${g.areaDiffPercent.toFixed(4)}%`);
  }
  if (!vr.pass) process.exitCode = 2;
}

// ---------- 命令：serve ----------
function cmdServe(args) {
  const env = { ...process.env, PORT: String(args.port || 8080) };
  if (args.run) env.RUN = String(args.run);
  const script = path.join(ROOT, 'viewer', 'server.cjs');
  const r = spawnSync(process.execPath, [script], { stdio: 'inherit', env });
  process.exit(r.status ?? 0);
}

function fail(msg) {
  console.error(C.red(msg));
  process.exitCode = 1;
}

// ---------- 入口 ----------
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const needHeap = ['build', 'verify'].includes(cmd);
if (needHeap) ensureHeap();

switch (cmd) {
  case 'inspect': cmdInspect(args); break;
  case 'build': await cmdBuild(args); break;
  case 'verify': await cmdVerify(args); break;
  case 'serve': cmdServe(args); break;
  default:
    console.log(`
${C.bold('bimpack')} —— BIM GLB 处理工具链

  ${C.cyan('inspect')} <file.glb>            体检（秒级，不解码几何）
  ${C.cyan('build')}   <file.glb> [选项]     修版本 → Draco → 属性校验 → 几何保真 → 预压缩 → 报告
  ${C.cyan('verify')}  <a.glb> <b.glb>       只比两个文件
  ${C.cyan('serve')}   [--run 名字]          起 viewer

build 选项：
  --preset high|balance|small    位深预设（默认 balance；源已是 Draco 时自动 high）
  --out <dir>                    输出根目录（默认 ./out）
  --name <slug>                  输出目录名
  --no-geo                       跳过解码级几何比对
  --no-gzip                      不生成 .gz
  --port <n>                     serve 端口（默认 8080）
`);
}
