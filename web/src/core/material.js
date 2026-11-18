/**
 * material.js —— 材质扩展的体检与修补
 *
 * 为什么需要：three 的 GLTFLoader **不是什么都认**。
 *   1. `KHR_materials_pbrSpecularGlossiness`（旧版高光-光泽度）早在 r157 就被移除支持。
 *      带这个扩展的模型（3ds Max / 早期 Substance 常见）读进来后拿不到 baseColor/金属度，
 *      three 只能退回「白 + metalness 1」的默认材质 —— 看上去发黑或惨白。
 *   2. 其余 `KHR_materials_*`（如 diffuse_transmission、variants）也有支持与不支持的差别。
 *
 * 这里做两件事：
 *   - `auditMaterialExtensions(json)`：读 GLB 的 extensionsUsed，列出不支持的材质扩展；
 *   - `convertSpecGloss(bytes)`：用 gltf-transform 把旧版高光材质转成金属-粗糙度
 *     （PBR 的唯一通用口径），在进 GLTFLoader 之前就地修好。
 *
 * 转换只动材质描述，不动几何、不动贴图像素（图片原样拷贝）。
 */

import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { metalRough } from '@gltf-transform/functions';

export const SPEC_GLOSS = 'KHR_materials_pbrSpecularGlossiness';

/**
 * GLTFLoader（three r170）已实现的材质扩展。
 * 这张表只用于「要不要提醒用户」，不在表里也不会崩，只是可能按默认材质显示。
 */
const SUPPORTED_MATERIAL_EXTS = new Set([
  'KHR_materials_anisotropy',
  'KHR_materials_clearcoat',
  'KHR_materials_dispersion',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_iridescence',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_materials_volume',
  'EXT_materials_bump',
]);

/** 读 JSON 里的扩展声明（extensionsUsed 可能为空） */
export function auditMaterialExtensions(json) {
  const used = Array.isArray(json?.extensionsUsed) ? json.extensionsUsed : [];
  const required = Array.isArray(json?.extensionsRequired) ? json.extensionsRequired : [];
  const all = [...new Set([...used, ...required])];
  const specGloss = all.includes(SPEC_GLOSS);
  const unsupported = all.filter((e) => /materials/i.test(e) && e !== SPEC_GLOSS && !SUPPORTED_MATERIAL_EXTS.has(e));
  return { specGloss, unsupported, extensions: all };
}

/**
 * 旧版高光-光泽度 → 金属-粗糙度。
 * @param {Uint8Array} bytes 已修过 asset.version 的 GLB
 * @returns {Promise<{bytes: Uint8Array, converted: number}>}
 */
export async function convertSpecGloss(bytes) {
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(bytes);
  const total = doc.getRoot().listMaterials().length;
  await doc.transform(metalRough());
  const left = doc.getRoot().listMaterials()
    .filter((m) => m.getExtension(SPEC_GLOSS)).length;
  const out = await io.writeBinary(doc);
  return { bytes: new Uint8Array(out), converted: total - left };
}
