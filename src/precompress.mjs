/**
 * precompress.mjs —— 生成 .br / .gz 传输层压缩副本
 *
 * 关键：brotli q11 压 60MB 要一分钟级，只能在构建期做，绝不能放在 HTTP 请求期。
 */
import zlib from 'node:zlib';

export const DEFAULT_PRECOMPRESS = { brotli: { quality: 11, lgwin: 24 }, gzip: true, gzipLevel: 9 };

/**
 * @param {Buffer} buf
 * @param {object} opts  { brotli:{quality,lgwin}, gzip:boolean, gzipLevel:number, onStep }
 * @returns {{ brotli?: Buffer, gzip?: Buffer, ms: object }}
 */
export function precompress(buf, opts = {}) {
  const cfg = {
    ...DEFAULT_PRECOMPRESS,
    ...opts,
    brotli: { ...DEFAULT_PRECOMPRESS.brotli, ...(opts.brotli || {}) },
  };
  const ms = {};
  const out = {};

  if (cfg.brotli !== false) {
    const t = Date.now();
    out.brotli = zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: cfg.brotli.quality,
        [zlib.constants.BROTLI_PARAM_LGWIN]: cfg.brotli.lgwin,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
    ms.brotli = Date.now() - t;
    cfg.onStep?.('brotli', out.brotli.length);
  }

  if (cfg.gzip) {
    const t = Date.now();
    out.gzip = zlib.gzipSync(buf, { level: cfg.gzipLevel });
    ms.gzip = Date.now() - t;
    cfg.onStep?.('gzip', out.gzip.length);
  }

  return { ...out, ms };
}
