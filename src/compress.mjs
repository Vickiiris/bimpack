/**
 * compress.mjs —— 用 Draco 重编码几何（glTF-Transform + draco3dgltf）
 *
 * 只做「几何重编码」一件事：不 weld、不 simplify、不 prune、不 join。
 * 任何拓扑或图元结构的改动都会破坏 BIM 构件的一一对应关系，这是属性零丢失的前提。
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

/** 三档预设：位深越高越保真，体积差通常在 5% 以内，所以默认走 balance */
export const PRESETS = {
  // 二次编码（源文件已 Draco）或要求毫米级保真时用
  high: { quantizePosition: 16, quantizeNormal: 10, quantizeTexcoord: 12, quantizeColor: 8, quantizeGeneric: 12 },
  // 通用默认：14 bit 位置，对 30m 尺度 ≈ 3.6mm 误差，建筑构件不可见
  balance: { quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeColor: 8, quantizeGeneric: 12 },
  // 只要体积：12 bit 位置，适合远观总图，不要用于单体交付
  small: { quantizePosition: 12, quantizeNormal: 8, quantizeTexcoord: 10, quantizeColor: 8, quantizeGeneric: 10 },
};

let ioPromise;
/** IO 复用：draco 的 wasm 模块初始化一次就好，别每个文件都重新编译 */
export async function getIO() {
  if (!ioPromise) {
    ioPromise = (async () => {
      const [decoder, encoder] = await Promise.all([
        draco3d.createDecoderModule({}),
        draco3d.createEncoderModule({}),
      ]);
      return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
        'draco3d.decoder': decoder,
        'draco3d.encoder': encoder,
      });
    })();
  }
  return ioPromise;
}

/**
 * @param {Buffer} buf  已经修过 asset.version 的 GLB 字节
 * @param {object} opts { preset:'high'|'balance'|'small', encodeSpeed, decodeSpeed, overrides }
 * @returns {Promise<{buf: Buffer, params: object}>}
 */
export async function compressDraco(buf, opts = {}) {
  const { preset = 'balance', encodeSpeed = 5, decodeSpeed = 5, overrides = {} } = opts;
  const q = { ...(PRESETS[preset] || PRESETS.balance), ...overrides };
  const params = { method: 'edgebreaker', encodeSpeed, decodeSpeed, ...q };

  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(buf));
  await doc.transform(draco(params));
  const out = await io.writeBinary(doc);
  return { buf: Buffer.from(out), params };
}
