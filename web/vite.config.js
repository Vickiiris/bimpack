import { defineConfig } from 'vite';

export default defineConfig({
  // './' 让产物可以直接放到任意子路径（GitHub Pages / OSS / 内网目录）
  base: './',
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    // draco 的 asm.js 有 1.5MB，单独拆包，避免拖慢首屏
    chunkSizeWarningLimit: 2000,
  },
  // draco 的 js 放在 public 下用 <script> 注入，不参与打包
  optimizeDeps: { exclude: ['draco3d'] },
});
