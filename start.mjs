#!/usr/bin/env node
/**
 * start.mjs —— 一键启动（双击 start.cmd 就是跑这个）
 *
 * 做四件事：
 *   1. 检查 Node 版本
 *   2. 第一次运行时自动 npm i
 *   3. 找一个没被占用的端口（8080 起）
 *   4. 起服务并自动打开浏览器（NO_OPEN=1 可关闭）
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NO_OPEN = process.env.NO_OPEN === '1';
const LOCK = path.join(ROOT, '.server.json');
const ARGS = process.argv.slice(2);
const RESTART = ARGS.includes('--restart') || ARGS.includes('-r');
const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

// 1. Node 版本
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(C.r(`\n  Node.js 版本过低（当前 ${process.versions.node}），需要 18 或更高。`));
  console.error('  下载： https://nodejs.org/\n');
  process.exit(1);
}

// 2. 依赖
if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  console.log(C.y('\n  首次运行，正在安装依赖（约 30 秒）…\n'));
  const r = spawnSync('npm', ['i', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(C.r('\n  依赖安装失败，请检查网络后重试。\n'));
    process.exit(1);
  }
}

// 3. 已经在运行就不重复启动（避免每次双击都多占一个端口）
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(900) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
}

const lock = readLock();
if (lock && lock.pid && pidAlive(lock.pid)) {
  const info = await ping(lock.port);
  if (info) {
    if (!RESTART) {
      console.log('');
      console.log(`  ${C.g('处理台已经在运行')}： ${C.b(lock.url || 'http://localhost:' + lock.port)}`);
      console.log(`  ${C.dim('端口 ' + lock.port + ' 正被它使用，本次不再重复启动。')}`);
      console.log(`  ${C.dim('要重启：双击 stop.cmd 关掉后再开，或运行 node start.mjs --restart')}`);
      console.log('');
      if (!NO_OPEN) openBrowser(lock.url || `http://localhost:${lock.port}`);
      process.exit(0);
    }
    console.log(`\n  重启：先停掉正在运行的实例（PID ${lock.pid}）…`);
    killTree(lock.pid);
    await new Promise((r) => setTimeout(r, 800));
  }
}
try { fs.unlinkSync(LOCK); } catch { /* 没有锁文件 */ }

// 4. 找空闲端口
function findPort(p) {
  return new Promise((resolve) => {
    if (p > 8099) return resolve(8080);
    const srv = net.createServer();
    srv.once('error', () => resolve(findPort(p + 1)));
    srv.once('listening', () => srv.close(() => resolve(p)));
    srv.listen(p, '127.0.0.1');
  });
}
const port = await findPort(Number(process.env.PORT) || 8080);
const url = `http://localhost:${port}`;

// 4. 起服务
const child = spawn(process.execPath, [path.join(ROOT, 'viewer', 'server.cjs')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port) },
});

function openBrowser(target) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开就算了，URL 已经打印出来了 */ }
}

setTimeout(() => {
  console.log(`  ${C.dim('地址')}  ${C.b(url)}${NO_OPEN ? '' : C.dim('   （已自动打开浏览器）')}`);
  console.log(`  ${C.dim('停止服务：本窗口按 Ctrl+C，或直接关掉窗口')}`);
  console.log('');
  if (!NO_OPEN) openBrowser(url);
}, 900);

// 关键：本进程无论怎么退出（Ctrl+C / 关窗口 / 崩溃），都要把子进程带走，
// 否则会留下孤儿进程继续占着端口 —— 这正是"每开一次就多占一个端口"的根源。
let childGone = false;
let stopping = false;

/** 子进程被 taskkill /F 强杀时来不及清锁，由父进程兜底（只删自己那把孩子） */
function removeOwnLock() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (child && j.pid === child.pid) fs.unlinkSync(LOCK);
  } catch { /* 没有锁文件，或不属于本次会话 */ }
}

function cleanupChild() {
  if (childGone || !child || !child.pid || child.exitCode !== null) return;
  childGone = true;
  stopping = true;
  killTree(child.pid);
  removeOwnLock();
}
process.on('exit', cleanupChild);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    cleanupChild();
    // 给 taskkill 一点时间落地，再退出，避免端口还没释放就返回
    setTimeout(() => process.exit(0), 150);
  });
}

child.on('close', (code) => {
  childGone = true;
  removeOwnLock();
  // 主动停止 / 被信号杀掉（SIGTERM=143、SIGINT=130、taskkill=1）都算正常停止
  if (stopping || code === 0 || (code !== 3 && !fs.existsSync(LOCK))) {
    console.log(C.dim('\n  服务已停止。\n'));
    process.exit(0);
  }
  if (code === 3) {
    console.log(C.y('\n  端口被占用。若确认是本工具上次没关干净，双击 stop.cmd 清理后再启动。\n'));
  } else {
    console.log(C.r(`\n  服务意外退出（代码 ${code}）。`));
    console.log(C.dim('  如果反复出现，把上面的报错发出来；或双击 stop.cmd 清理后重试。\n'));
  }
  process.exit(code ?? 1);
});
