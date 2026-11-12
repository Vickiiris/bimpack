#!/usr/bin/env node
/**
 * stop.cjs —— 关掉处理台，把占着的端口释放掉
 *
 *   node stop.cjs          正常停止（读 .server.json 里的 PID）
 *   node stop.cjs --scan   额外扫描残留的本工具 node 进程一并清掉
 *
 * 为什么需要它：直接关掉 cmd 窗口有时杀不掉子进程（尤其是双击多次留下的孤儿），
 * 结果端口一直被占，下次启动只能顺延到 8081、8082……
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCK = path.join(ROOT, '.server.json');
const SCAN = process.argv.includes('--scan');

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
  }
}

/** 兜底：扫描命令行里带 bimpack + server.cjs 的 node 进程 */
function scanStray() {
  if (process.platform !== 'win32') {
    const r = spawnSync('pgrep', ['-f', 'bimpack.*server\\.cjs'], { encoding: 'utf8' });
    return (r.stdout || '').split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number);
  }
  const ps = [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ' +
      'Where-Object { $_.CommandLine -like \'*bimpack*server.cjs*\' } | ' +
      'Select-Object -ExpandProperty ProcessId',
  ];
  const r = spawnSync('powershell', ps, { encoding: 'utf8' });
  return (r.stdout || '').split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number);
}

const killed = [];

// 1) 按锁文件杀
let lock = null;
try { lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { /* 没有或损坏 */ }

if (lock && lock.pid) {
  if (alive(lock.pid)) {
    killTree(lock.pid);
    killed.push(lock.pid);
    console.log(`  已停止服务（PID ${lock.pid}，端口 ${lock.port ?? '?'}）`);
  } else {
    console.log(`  锁里的进程（PID ${lock.pid}）已不在，清理残留锁文件`);
  }
} else {
  console.log('  没有找到运行记录（.server.json），尝试扫描残留进程…');
}

// 2) 兜底扫描（锁丢了 / 之前双击出过孤儿）
if (SCAN || killed.length === 0) {
  const strays = scanStray().filter((pid) => !killed.includes(pid));
  for (const pid of strays) {
    killTree(pid);
    killed.push(pid);
    console.log(`  已清理残留进程（PID ${pid}）`);
  }
}

// 3) 删锁
try { fs.unlinkSync(LOCK); } catch { /* 本来就没有 */ }

// 4) 结论
if (killed.length) {
  console.log(`\n  ✓ 端口已释放，下次双击 start.cmd 会重新占用 8080。\n`);
} else {
  console.log('\n  没有发现正在运行的处理台。');
  console.log('  如果端口仍被占用，可能是别的程序在用：');
  console.log('    netstat -ano | findstr :8080      然后  taskkill /PID <号> /F\n');
}
