#!/usr/bin/env node
/**
 * viewer/server.cjs —— 上传 + 处理 + 预览 一体的本地服务
 *
 *   node src/cli.mjs serve          （推荐，从 CLI 起）
 *   node viewer/server.cjs          PORT=8080
 *
 * 路由：
 *   GET  /                  上传页（拖文件 → 自动处理 → 一键预览）
 *   GET  /view?run=<楼层>    3D 预览页
 *   GET  /model.glb?run=…   模型（自动发 .br / .gz）
 *   GET  /manifest.json?run=…
 *   GET  /api/runs          已处理楼层列表
 *   PUT  /api/upload?name=… 流式接收上传（不经过 multipart，直接落盘）
 *   POST /api/build         启动处理任务
 *   GET  /api/job/:id       任务进度与日志
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');
const OUTROOT = path.join(ROOT, 'out');
const INBOX = path.join(ROOT, 'inbox');
// 单实例锁：记录当前服务进程，供 start.mjs / stop.cjs 判断"已经在跑"和"怎么杀掉"
const LOCK = path.join(ROOT, '.server.json');
fs.mkdirSync(OUTROOT, { recursive: true });
fs.mkdirSync(INBOX, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

/** 和 src/cli.mjs 的 slugify 保持一致（那边是 ESM 且有副作用，这里独立实现） */
function slugify(name) {
  return String(name)
    .replace(/\.glb$/i, '')
    .replace(/^\d{14}-/, '')          // 去掉上传时加的时间戳前缀（20261111192728-xxx.glb）
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'model';
}

function listRuns() {
  if (!fs.existsSync(OUTROOT)) return [];
  return fs.readdirSync(OUTROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(OUTROOT, d.name);
      const mp = path.join(dir, 'manifest.json');
      let m = null;
      try { m = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch { /* 处理中断的目录 */ }
      const hasReport = fs.existsSync(path.join(dir, 'report.md'));
      const model = path.join(dir, (m && m.model) || `${d.name}.glb`);
      return {
        run: d.name,
        mtime: fs.statSync(dir).mtimeMs,
        manifest: m,
        hasReport,
        hasModel: fs.existsSync(model),
        // ok = 处理完整；incomplete = 有目录但没跑完（中断或校验未通过）
        status: m ? 'ok' : 'incomplete',
        reason: m ? null : (hasReport ? '处理未通过校验' : '处理中断（未生成 manifest）'),
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** 严格按名字找楼层；没有 name 就返回 null —— 不再"自动兜底最新一层"，
 *  这样 /view 和 /model.glb 不带参数时不会莫名其妙加载上次的模型。 */
function resolveRun(want) {
  const name = want || null;
  if (!name) return null;
  return listRuns().find((r) => r.run === name) || null;
}

function pickEncoding(req, file) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (ae.includes('br') && fs.existsSync(file + '.br')) return { file: file + '.br', encoding: 'br' };
  if (ae.includes('gzip') && fs.existsSync(file + '.gz')) return { file: file + '.gz', encoding: 'gzip' };
  return { file, encoding: null };
}

function sendFile(req, res, file, opts = {}) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const { file: send, encoding } = opts.compress === false
    ? { file, encoding: null }
    : pickEncoding(req, file);
  const size = fs.statSync(send).size;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': size,
    Vary: 'Accept-Encoding',
    'Cache-Control': opts.cache || 'no-cache',
    'Access-Control-Allow-Origin': '*',
  };
  if (encoding) headers['Content-Encoding'] = encoding;
  res.writeHead(200, headers);
  fs.createReadStream(send).pipe(res);
}

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    // 关键：列表类接口绝不能缓存，否则页面会一直显示旧的一层
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(b);
}

// ---------- 任务管理 ----------
const jobs = new Map();
let jobSeq = 0;

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function startJob(filePath, { preset, geo = true }) {
  const id = 'j' + ++jobSeq;
  const job = { id, status: 'running', lines: [], run: null, startedAt: Date.now(), file: filePath };
  jobs.set(id, job);

  if (!fs.existsSync(filePath)) {
    job.status = 'failed';
    job.lines.push('✗ 找不到上传的文件：' + filePath);
    return job;
  }

  const args = [path.join(ROOT, 'src', 'cli.mjs'), 'build', filePath];
  if (preset && preset !== 'auto') args.push('--preset', preset);
  if (!geo) args.push('--no-geo');

  const child = spawn(process.execPath, args, { cwd: ROOT });
  const push = (buf) => {
    for (const line of stripAnsi(buf.toString('utf8')).split(/\r?\n/)) {
      if (line.trim()) job.lines.push(line);
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'failed';
    job.finishedAt = Date.now();
    // 处理成功：按 slug 找产出目录（时间最新的那个一定是本次）
    const slug = slugify(path.basename(filePath).replace(/^\d{14}-/, ''));
    const dir = path.join(OUTROOT, slug);
    job.run = fs.existsSync(dir) ? slug : (listRuns()[0]?.run ?? null);
    if (job.status === 'failed') job.lines.push(`✗ 处理失败（退出码 ${code}）`);
  });
  return job;
}

// ---------- 服务 ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  const runParam = u.searchParams.get('run');

  // ---- API ----
  if (p === '/api/ping') {
    return json(res, 200, { ok: true, pid: process.pid, port: PORT, runs: listRuns().length });
  }

  if (p === '/api/runs' && req.method === 'GET') {
    return json(res, 200, listRuns().map((r) => ({
      run: r.run,
      at: new Date(r.mtime).toISOString(),
      stats: r.manifest?.stats ?? null,
      title: r.manifest?.title ?? r.run.replace(/^\d{14}-/, ''),
      status: r.status,
      reason: r.reason,
    })));
  }

  if (p === '/api/upload' && req.method === 'PUT') {
    const rawName = u.searchParams.get('name') || 'upload.glb';
    const safe = path.basename(rawName).replace(/[\\/:*?"<>|]/g, '_');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // 20261111192643
    const dest = path.join(INBOX, `${stamp}-${safe}`);
    const ws = fs.createWriteStream(dest);
    let received = 0;
    req.on('data', (c) => { received += c.length; });
    req.pipe(ws);
    ws.on('finish', () => {
      console.log(`  ↑ 收到 ${safe}  ${(received / 1048576).toFixed(2)} MB`);
      json(res, 200, { file: dest, name: path.basename(dest), size: received });
    });
    ws.on('error', (e) => json(res, 500, { error: e.message }));
    return;
  }

  if (p.startsWith('/api/runs/') && req.method === 'DELETE') {
    const name = decodeURIComponent(p.slice('/api/runs/'.length));
    if (!/^[\p{L}\p{N}._-]+$/u.test(name) || name.includes('..')) return json(res, 400, { error: '非法名称' });
    const dir = path.join(OUTROOT, name);
    if (!dir.startsWith(OUTROOT) || !fs.existsSync(dir)) return json(res, 404, { error: '不存在' });
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  × 已删除楼层 ${name}`);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/build' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let opt = {};
      try { opt = JSON.parse(body || '{}'); } catch { /* 空体 */ }
      if (!opt.file || !fs.existsSync(opt.file)) return json(res, 400, { error: '文件不存在' });
      const job = startJob(opt.file, opt);
      console.log(`  ▶ 开始处理 ${path.basename(opt.file)}  (job ${job.id})`);
      json(res, 200, { id: job.id });
    });
    return;
  }

  if (p.startsWith('/api/job/') && req.method === 'GET') {
    const job = jobs.get(p.slice('/api/job/'.length));
    if (!job) return json(res, 404, { error: 'job 不存在' });
    return json(res, 200, {
      status: job.status, run: job.run, lines: job.lines,
      ms: (job.finishedAt || Date.now()) - job.startedAt,
    });
  }

  // ---- 页面 ----
  if (p === '/' || p === '/upload') return sendFile(req, res, path.join(HERE, 'upload.html'));
  if (p === '/view' || p === '/index.html') {
    // 没指定楼层、或指定的楼层不存在 → 一律回上传页，避免默认打开一个"上次的模型"
    if (!runParam) return res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }).end();
    const target = resolveRun(runParam);
    if (!target || target.status !== 'ok') {
      return res.writeHead(302, { Location: '/?missing=' + encodeURIComponent(runParam), 'Cache-Control': 'no-store' }).end();
    }
    return sendFile(req, res, path.join(HERE, 'index.html'));
  }

  if (p === '/model.glb' || p === '/manifest.json') {
    if (!runParam) return json(res, 400, { error: '请先上传模型（缺少 run 参数）' });
    const r = resolveRun(runParam);
    if (!r) return json(res, 404, { error: `找不到楼层 ${runParam}，请回上传页重新选择` });
    const f = p === '/manifest.json' ? path.join(OUTROOT, r.run, 'manifest.json')
      : path.join(OUTROOT, r.run, r.manifest?.model || `${r.run}.glb`);
    return sendFile(req, res, f);
  }

  // ---- 静态 ----
  const rel = path.normalize(p).replace(/^([/\\])+/, '');
  const file = path.join(HERE, rel);
  if (!file.startsWith(HERE)) return res.writeHead(403).end('403');
  return sendFile(req, res, file);
});

function clearLock() {
  try {
    if (!fs.existsSync(LOCK)) return;
    const j = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (j.pid === process.pid) fs.unlinkSync(LOCK);   // 只删自己的，别误删别人的
  } catch { /* 锁文件损坏，忽略 */ }
}
process.on('exit', clearLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { console.log('\n  已停止服务。'); clearLock(); process.exit(0); });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。`);
    console.error(`  可能已有一个处理台在跑：先双击 stop.cmd，或换个端口 PORT=8081 再启动。\n`);
    process.exit(3);
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, () => {
  try {
    fs.writeFileSync(LOCK, JSON.stringify(
      { pid: process.pid, port: PORT, url: `http://localhost:${PORT}`, startedAt: new Date().toISOString() }, null, 2));
  } catch { /* 写不了锁不影响使用 */ }
  const runs = listRuns();
  console.log(`\n  BIM 处理台  http://localhost:${PORT}`);
  console.log(`  已有楼层    ${runs.length} 个${runs.length ? '（打开页面后可选择，不再自动加载）' : ''}`);
  console.log(`  上传目录    ${INBOX}`);
  console.log(`\n  打开浏览器 → 把 .glb 拖进去 → 等它跑完 → 点"查看模型"\n`);
});
