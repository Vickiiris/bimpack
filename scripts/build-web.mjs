/**
 * CI/部署用的根构建命令（Cloudflare Pages 等平台执行 `npm run build` 时走到这里）。
 *
 * 为什么不是直接 `npm --prefix web run build`：
 *  1. 部署环境只在根目录跑一次 npm clean-install，web/ 的依赖（vite 等）没装；
 *  2. web/ 的 devDependencies 里有 playwright，安装时会默认下载三套浏览器内核
 *     （几百 MB，部署里用不到），所以这里显式跳过浏览器下载。
 *
 * 跨平台：不写 `VAR=1 cmd` 这种 sh 语法（Windows 的 npm script 走 cmd 会挂），
 * 统一用 spawnSync 注入环境变量。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };

function run(args) {
  const r = spawnSync('npm', args, { stdio: 'inherit', shell: true, env, cwd: ROOT });
  if (r.status !== 0) {
    console.error(`\n✗ 命令失败: npm ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

run(['--prefix', 'web', 'install', '--no-audit', '--no-fund']);
run(['--prefix', 'web', 'run', 'build']);
console.log('\n✓ web/ 构建完成，产物在 web/dist/');
