/**
 * draco.js —— 只加载 Draco「解码器」（用于读入已经 Draco 压缩过的源文件）
 *
 * 为什么没有编码器：官方 npm 包的 draco3d 只带 Node 版 glue（require('fs') 在浏览器里直接炸）；
 * three.js 自带的 draco_encoder.js 是 asm.js 版，实测在 Chrome 157 里一初始化就
 * 让渲染进程崩溃（Target crashed），换 TOTAL_MEMORY 等参数也救不回来。
 * 所以编码改用 meshopt（见 process.js），解码继续用 asm.js decoder（实测正常）。
 */
const BASE = import.meta.env.BASE_URL || './';
let cache = null;

function injectScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-draco="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.draco = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`加载失败：${src}`));
    document.head.appendChild(s);
  });
}

/** @returns {Promise<object>} Emscripten 模块实例 */
export function loadDracoDecoder(onProgress = () => {}) {
  if (cache) return cache;

  cache = (async () => {
    onProgress('加载 Draco 解码器…');
    await injectScript(`${BASE}draco/draco_decoder.js`);
    if (typeof globalThis.DracoDecoderModule !== 'function') {
      throw new Error('DracoDecoderModule 未注册（draco_decoder.js 加载异常）');
    }
    return globalThis.DracoDecoderModule();
  })();

  cache.catch(() => { cache = null; });
  return cache;
}
