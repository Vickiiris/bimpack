#!/usr/bin/env node
/**
 * server.mjs —— 本地 Draco 压缩小工具（零配置，双击 start.cmd 即用）
 *
 * 为什么单独做一个：浏览器里没有可用的 Draco 编码器（npm 包只有 Node glue，
 * three 自带的 asm.js 版一初始化就崩），所以「Draco 级」的压缩只能在本地跑。
 * 这个服务复用仓库里已验证的 src/compress.mjs（glTF-Transform + draco3dgltf），
 * 参数与 `node src/cli.mjs build` 完全一致，只是把命令行换成了拖放界面。
 *
 * 三个原则：
 *   1. 只重编码几何，不 weld / 不 simplify / 不 prune / 不 join —— BIM 构件必须一一对应
 *   2. 已 Draco 的文件直接拒绝：量化后再解回 float32 重压必然膨胀（实测 63.6 → 115 MB）
 *   3. 压完自动跑属性校验，不通过也要在界面上说清楚
 *
 * 用法：node server.mjs   （默认 http://localhost:8099，被占用则顺延）
 *       NO_OPEN=1 node server.mjs   不自动开浏览器
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { fixAssetVersion } from '../src/glb.mjs';
import { inspect } from '../src/inspect.mjs';
import { compressDraco, PRESETS } from '../src/compress.mjs';
import { compareJSON } from '../src/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const PORT0 = Number(process.env.PORT || 8099);
const NO_OPEN = process.env.NO_OPEN === '1';
const HOST = '127.0.0.1'; // 只监听本机：这是本地工具，不要暴露到局域网

fs.mkdirSync(OUT, { recursive: true });

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB');

// ---------- 小工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.json': 'application/json; charset=utf-8',
};

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': 'no-store',
  });
  res.end(b);
}

/** 文件名净化：只留安全字符，杜绝 ../ 之类的路径穿越 */
function safeName(raw, fallback = 'model') {
  const base = path.basename(String(raw || '').replace(/\\/g, '/'));
  const cleaned = base
    .replace(/\.glb$/i, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || fallback;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 2 * 1024 * 1024 * 1024) { // 2 GB 上限，防止误传超大文件把内存打爆
        reject(new Error('文件超过 2 GB 上限'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- 核心：压缩一个文件 ----------
async function handleCompress(req, res, query) {
  const t0 = Date.now();
  const body = await readBody(req);
  if (!body.length) return json(res, 400, { ok: false, error: 'empty', message: '没有收到文件内容' });

  const infoIn = inspect(body);
  const bpv = infoIn.geometry?.bytesPerVertex ?? 0;

  // 判据不能只看「有没有 Draco」：3ds Max 的原始导出本身就带 Draco，
  // 但那是低压缩设置（实测 25.5 字节/顶点），重压能到 4.5 —— 属于主要使用场景。
  // 真正的「已经压够了」是每顶点字节数已经接近 Draco 极限（≈4.5 B），此时再压必然更大。
  const TIGHT_BPV = 8;
  if (infoIn.alreadyDraco && bpv > 0 && bpv <= TIGHT_BPV) {
    console.log(`  ${C.yellow('·')} 跳过 ${query.get('name') || ''}：已压到 ${bpv} 字节/顶点，再压只会更大`);
    return json(res, 200, {
      ok: false,
      error: 'already-compressed',
      message: `这份文件已经压到约 ${bpv} 字节/顶点（Draco 极限约 4.5），再编码只会变大 —— 量化后的整型解回浮点没有收益。请用 3ds Max 导出的原始 .glb，或直接使用这份文件。`,
      input: { size: body.length, dracoPrims: infoIn.dracoPrims, bytesPerVertex: bpv },
    });
  }

  const preset = PRESETS[query.get('preset')] ? query.get('preset') : 'balance';
  const name = safeName(query.get('name'));
  console.log(`  ${C.cyan('→')} ${name}.glb  ${mb(body.length)}  preset=${preset}`);

  // 3ds Max 会写出非法的 asset.version "2.1"，不修的话下游全部打不开
  const fixed = fixAssetVersion(body);
  if (fixed.changed) console.log(`    ${C.dim(`asset.version ${fixed.from} → 2.0`)}`);

  const { buf: out, params } = await compressDraco(fixed.buf, { preset });
  const infoOut = inspect(out);

  // 属性零丢失校验：19 项，只要 extras / 层级 / 材质有一项不对就说出来
  let verify = null;
  try {
    verify = compareJSON(fixed.buf, out, { transformTolerance: 0.01 });
  } catch (e) {
    console.log(`    ${C.yellow('校验异常')} ${e.message}`);
  }

  const suffix = `_draco${preset === 'balance' ? '' : '_' + preset}`;
  const outName = `${name}${suffix}.glb`;
  const outPath = path.join(OUT, outName);
  fs.writeFileSync(outPath, out);

  const saved = body.length ? (1 - out.length / body.length) * 100 : 0;
  const ms = Date.now() - t0;
  console.log(
    `    ${C.green('✓')} ${mb(body.length)} → ${mb(out.length)}  ` +
    `(${(saved >= 0 ? '−' : '+') + Math.abs(saved).toFixed(1)}%)  ${(ms / 1000).toFixed(1)} s  ` +
    `${verify ? (verify.pass ? C.green('校验通过') : C.red('校验有失败项')) : ''}`
  );

  return json(res, 200, {
    ok: true,
    outName,
    input: {
      name: `${name}.glb`,
      size: body.length,
      version: fixed.from,
      versionFixed: fixed.changed,
      nodes: infoIn.counts.nodes,
      primitives: infoIn.counts.primitives,
      materials: infoIn.counts.materials,
      propEntries: infoIn.extras?.propEntries ?? null,
      triangles: infoIn.geometry?.triangles ?? null,
      bytesPerVertex: bpv,
      // 源文件自带 Draco（3ds Max 的低压缩设置）→ 这次属于二次编码，压缩率主要来自换边断裂编码
      reencoded: infoIn.alreadyDraco,
    },
    output: {
      size: out.length,
      nodes: infoOut.counts.nodes,
      primitives: infoOut.counts.primitives,
      materials: infoOut.counts.materials,
      propEntries: infoOut.extras?.propEntries ?? null,
      bytesPerVertex: infoOut.geometry?.bytesPerVertex ?? null,
    },
    savedPercent: +saved.toFixed(2),
    params,
    ms,
    verify: verify ? { pass: verify.pass, rows: verify.rows } : null,
  });
}

// ---------- 路由 ----------
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/ping') {
    return json(res, 200, { ok: true, pid: process.pid, port: server.address()?.port });
  }

  if (p === '/api/compress' && req.method === 'POST') {
    try {
      return await handleCompress(req, res, url.searchParams);
    } catch (e) {
      console.error('  压缩失败:', e.message);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'failed', message: e.message });
      return;
    }
  }

  if (p === '/api/files') {
    const files = fs.readdirSync(OUT)
      .filter((f) => f.toLowerCase().endsWith('.glb'))
      .map((f) => {
        const st = fs.statSync(path.join(OUT, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return json(res, 200, files);
  }

  if (p === '/api/download') {
    const name = path.basename(url.searchParams.get('f') || '');
    const file = path.join(OUT, name);
    if (!name || !file.startsWith(OUT) || !fs.existsSync(file)) return json(res, 404, { error: '文件不存在' });
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'model/gltf-binary',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
    return res.end(data);
  }

  // 静态文件：只放行 index.html
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.join(HERE, rel);
  if (file.startsWith(HERE) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    return res.end(data);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end('server error');
  });
});

// 端口占用就顺延，别让用户去改配置
function listen(port, tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 12) {
      listen(port + 1, tries + 1);
    } else {
      console.error(C.red(`  端口 ${port} 不可用：${e.message}`));
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const actual = server.address().port;
    const url = `http://localhost:${actual}`;
    console.log('');
    console.log(C.bold('  Draco 本地压缩') + C.dim('   ——  文件只在本机处理，不上传'));
    console.log(`  ${C.dim('地址')}  ${C.cyan(url)}`);
    console.log(`  ${C.dim('产物')}  ${OUT}`);
    console.log(`  ${C.dim('停止服务：本窗口按 Ctrl+C，或双击 stop.cmd')}`);
    console.log('');
    if (!NO_OPEN) {
      const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* 打不开就算了 */ }
    }
  });
}

process.on('SIGINT', () => {
  console.log(C.dim('\n  已停止。\n'));
  process.exit(0);
});

listen(PORT0);
