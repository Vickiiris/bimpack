/**
 * batch-default-mat.mjs —— glTF 里"没有材质索引"的图元不能变黑
 *
 * GLTFLoader 对这类图元会造默认材质：白 + metalness 1 + roughness 1 + 无名字。
 * 金属度 1 且没有环境贴图时几乎不出漫反射 → 渲出来纯黑。
 * 批处理会把它换成灰白素模材质，这里锁住这个行为。
 *
 * node test/batch-default-mat.mjs
 */
import * as THREE from 'three';
import { batchGLTFScene } from '../src/viewer/bim-batch.js';

const assert = (cond, msg) => {
  if (!cond) { console.error('✗ ' + msg); process.exitCode = 1; }
  else console.log('✓ ' + msg);
};

// 复刻 GLTFLoader.createDefaultMaterial 的参数
const defMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, emissive: 0x000000, metalness: 1, roughness: 1, transparent: false,
});
const scene = new THREE.Scene();
const m1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), defMat);
const m2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), defMat);
m2.position.x = 3;
// 一个正常材质做对照
const okMat = new THREE.MeshStandardMaterial({ color: 0x336699, metalness: 0, roughness: 0.6, name: 'Blue' });
const m3 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), okMat);
m3.position.x = 6;
scene.add(m1, m2, m3);

const batched = await batchGLTFScene(scene, { chunk: 1000 });

const fixed = batched.batches.find((b) => b.material.name === '默认材质');
assert(!!fixed, '无材质的图元收进「默认材质」批次');
assert(fixed.count === 2, `两个无材质件共用同一份默认材质（count=${fixed?.count}）`);
assert(fixed.material.metalness === 0, `默认材质 metalness 改为 0（原 1 → 黑），实际 ${fixed.material.metalness}`);
assert(fixed.material.roughness > 0.3, `默认材质 roughness 合理（${fixed.material.roughness}）`);
assert(fixed.material.color.getHexString() !== 'ffffff', `默认材质改成灰白素模色（#${fixed.material.color.getHexString()}）`);

const blue = batched.batches.find((b) => b.material.name === 'Blue');
assert(blue?.material.metalness === 0 && blue.material.color.getHexString() === '336699', '文件里显式定义的材质原样保留');

console.log(process.exitCode ? '\n有断言失败' : '\n全部通过');
