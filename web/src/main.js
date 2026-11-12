/**
 * main.js —— 页面编排：拖入 → 体检 → （可选）压缩 → 渲染 → 层级树/属性联动 → 下载
 *
 * 两条路径刻意分开：
 *   「直接查看」：只修 asset.version，不动几何，秒开；
 *   「压缩处理」：Draco 重编码 + 19 项属性校验，慢但能出交付级文件。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

import { MeshoptDecoder } from 'meshoptimizer';
import { fixAssetVersion, download } from './core/glb.js';
import { inspect as inspectBytes, compressGeometry, getIO, heapMB } from './core/process.js';
import { compareJSON, compareGeometry } from './core/verify.js';
import { createViewer } from './viewer/scene.js';
import { batchGLTFScene, setHighlight, unionBox } from './viewer/bim-batch.js';
import { createTree } from './viewer/tree.js';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL || './';

const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB');
const num = (n) => Number(n || 0).toLocaleString('en-US');

$('layout').classList.add('no-left', 'no-right');

const state = {
  fileName: '',
  rawBytes: null,      // 原始文件
  fixedBytes: null,    // 修过 asset.version
  info: null,          // inspect 结果
  batched: null,       // batchGLTFScene 返回值
  sceneRoot: null,     // gltf.scene（给层级树用）
  currentBytes: null,  // 当前渲染的是哪份字节（用于下载）
  processed: null,     // 处理结果 { bytes, params, verify }
  busy: false,
};

// ---------- 视口 ----------
const viewer = createViewer($('canvas'));
const dracoLoader = new DRACOLoader()
  .setDecoderPath(`${BASE}draco/`)
  .setDecoderConfig({ type: 'js' }) // 我们只放了 asm.js 版 decoder，别让 three 去找 wasm
  .setWorkerLimit(2);

// 输出文件用 EXT_meshopt_compression，读回来需要给 loader 装上 decoder
await MeshoptDecoder.ready;
const loader = new GLTFLoader().setDRACOLoader(dracoLoader).setMeshoptDecoder(MeshoptDecoder);

// ---------- 层级树 ----------
const tree = createTree($('tree'), {
  onSelect: (node) => {
    const recs = collectRecs(node);
    if (!recs.length) {
      // 纯分组：只飞相机过去
      if (node.obj) viewer.focusOn(new THREE.Box3().setFromObject(node.obj));
      showProps(null, node);
      return;
    }
    selectRecs(recs, node);
  },
});

function collectRecs(node) {
  if (node.recs?.length) return node.recs;
  const out = [];
  const walk = (n) => {
    if (n.recs) out.push(...n.recs);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

// ---------- 选中 ----------
let selectedRecs = [];
let lastRec = null;

function selectRecs(recs, node) {
  for (const r of selectedRecs) setHighlight(r, false);
  selectedRecs = recs;
  for (const r of recs) setHighlight(r, true);
  lastRec = recs[0] || null;

  if (recs.length) {
    const box = unionBox(recs);
    if (!box.isEmpty()) viewer.focusOn(box);
    if (node) tree.reveal(node.obj);
    else if (lastRec?.object) tree.reveal(lastRec.object);
  }
  showProps(recs, node);
}

function selectRec(rec) {
  selectRecs([rec], null);
}

// ---------- 属性面板 ----------
function showProps(recs, node) {
  const box = $('props');
  if (!recs || !recs.length) {
    const nm = node?.name ?? '';
    box.innerHTML =
      `<div class="prop-section"><div class="prop-section-title">分组</div>` +
      `<div class="prop-row"><span class="prop-key">名称</span><span class="prop-val">${esc(nm)}</span></div>` +
      `<div class="prop-row"><span class="prop-key">子节点</span><span class="prop-val num">${node?.children?.length ?? 0}</span></div>` +
      `</div>`;
    $('propCount').textContent = '';
    return;
  }

  const rec = recs[0];
  const props = rec.props || {};
  const keys = Object.keys(props);
  const v = rec.object?.geometry?.attributes?.position?.count ?? 0;

  const base = [
    ['构件名称', rec.name],
    ['顶点数', num(v)],
    ['材质', rec.batch.material?.name || '(默认)'],
    ['选中数量', recs.length > 1 ? `${recs.length} 个` : '1 个'],
  ];

  let html = '<div class="prop-section"><div class="prop-section-title">基本信息</div>';
  for (const [k, val] of base) {
    html += `<div class="prop-row"><span class="prop-key">${k}</span><span class="prop-val${typeof val === 'number' ? ' num' : ''}">${esc(String(val))}</span></div>`;
  }
  html += '</div>';

  if (keys.length) {
    html += `<div class="prop-section"><div class="prop-section-title">BIM 属性 · ${keys.length} 条</div>`;
    for (const k of keys) {
      const val = props[k];
      const text = val === null || val === undefined ? '' : String(val);
      html += `<div class="prop-row"><span class="prop-key">${esc(k)}</span><span class="prop-val">${esc(text)}</span></div>`;
    }
    html += '</div>';
  } else {
    html += '<div class="empty">该构件没有 user 属性（extras）</div>';
  }

  box.innerHTML = html;
  box.scrollTop = 0;
  $('propCount').textContent = keys.length ? `${keys.length} 条` : '';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- 3D 点选 ----------
viewer.onClick((x, y) => {
  if (!state.batched) return;
  const hit = viewer.pick(x, y, (rc) => state.batched.pick(rc));
  if (hit?.rec) selectRec(hit.rec);
});

viewer.onFrame((fps) => {
  $('hudFps').textContent = fps;
});

// ---------- 进度 ----------
function progress(title, pct, log) {
  const card = $('progressCard');
  card.hidden = false;
  if (title) $('pcTitle').textContent = title;
  if (pct !== undefined) {
    $('pcPct').textContent = Math.round(pct) + '%';
    $('pcFill').style.width = Math.max(2, Math.min(100, pct)) + '%';
  }
  if (log) {
    const el = $('pcLog');
    el.textContent += (el.textContent ? '\n' : '') + log;
    el.scrollTop = el.scrollHeight;
  }
}

function progressDone(delay = 900) {
  setTimeout(() => {
    $('progressCard').hidden = true;
    $('pcLog').textContent = '';
    $('pcFill').style.width = '0%';
  }, delay);
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ---------- 打开文件 ----------
$('btnOpen').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  const f = e.target.files?.[0];
  if (f) loadFile(f);
  e.target.value = '';
};

$('dropzone').onclick = () => $('fileInput').click();

let dragDepth = 0;
const dz = $('dropzone');
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) dz.classList.add('hover');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dz.classList.remove('hover');
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dz.classList.remove('hover');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

async function loadFile(file) {
  if (state.busy) return toast('正在处理上一个文件，稍候…', 'err');
  if (!/\.(glb|gltf)$/i.test(file.name)) return toast('请选择 .glb 文件', 'err');

  state.busy = true;
  state.fileName = file.name;
  const baseName = file.name.replace(/\.(glb|gltf)$/i, '');

  try {
    progress('读取文件…', 4, `文件：${file.name}（${mb(file.size)}）`);
    const raw = new Uint8Array(await file.arrayBuffer());
    state.rawBytes = raw;

    // 1) 体检（只读 JSON，不解码几何）
    progress('解析 GLB 结构…', 12);
    state.info = inspectBytes(raw);

    // 2) 修版本（3ds Max 常写 2.1，three 会拒绝加载）
    progress('检查 asset.version…', 20);
    const fixed = fixAssetVersion(raw);
    state.fixedBytes = fixed.bytes;
    if (fixed.changed) progress(null, undefined, `asset.version ${fixed.from} → 2.0（已修正）`);

    // 3) 渲染
    progress('解码并渲染…', 30);
    await renderBytes(fixed.bytes, baseName);

    progressDone();
    updateTopbar(file.name, file.size);
    toast('已加载，可直接查看或点「压缩处理」', 'ok');
  } catch (err) {
    console.error(err);
    progressDone(0);
    toast('加载失败：' + (err?.message || err), 'err');
  } finally {
    state.busy = false;
  }
}

/** 把字节渲染出来：GLTFLoader → 批处理 → 挂到场景 → 建树 */
async function renderBytes(bytes, baseName) {
  // 独占 buffer 时零拷贝；否则才 slice（slice 会复制整个文件，200MB 文件上很致命）
  const ab = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(ab, '', resolve, reject);
  });

  state.sceneRoot = gltf.scene;
  state.currentBytes = bytes;

  progress(null, 46, `节点 ${num(gltf.scene.children.length)} 个根 · 开始批处理…`);

  const batched = await batchGLTFScene(gltf.scene, {
    onProgress: ({ done, total, phase }) => {
      if (phase === 'batch') progress(null, 46 + (done / Math.max(1, total)) * 44);
    },
    chunk: 200,
  });
  state.batched = batched;

  viewer.setModel(batched.group);

  // 层级树用「原始 scene 结构」，批处理只是把几何搬进 BatchedMesh，Object3D 仍在
  const { total } = tree.setModel(gltf.scene, batched.objectToRecs);

  $('dropzone').classList.add('hidden');
  $('panelLeft').hidden = false;
  $('panelRight').hidden = false;
  $('hud').hidden = false;
  $('layout').classList.remove('no-left', 'no-right');
  $('btnProcess').hidden = false;
  $('btnDownload').hidden = false;

  updateHud(batched, gltf);
  $('treeCount').textContent = `${num(total)} 节点`;

  progress(null, 92, `批处理完成：${batched.stats.meshes} 个几何 → ${batched.stats.drawCalls} 个 draw call（${batched.stats.buildMs} ms）`);

}

function updateHud(batched, gltf) {
  const info = state.info;
  $('hudDraw').textContent = num(batched.stats.drawCalls);
  $('hudTri').textContent = num(info?.triangles || 0);
  $('hudParts').textContent = num(batched.stats.meshes);
  $('hudBatch').textContent = `${num(batched.stats.meshes)} → ${num(batched.stats.drawCalls)}`;
}

let verChip = null;

function updateTopbar(name, size) {
  $('fileInfo').hidden = false;
  $('fileName').textContent = name;
  $('fileName').title = name;
  $('chipSize').textContent = mb(size);

  const info = state.info;
  if (info) {
    $('chipVerts').textContent = `${(info.vertices / 1e6).toFixed(2)}M 顶点`;
    const chip = $('chipDraco');
    if (info.hasDraco) {
      chip.textContent = '已含 Draco';
      chip.className = 'chip accent';
    } else {
      chip.textContent = '未压缩';
      chip.className = 'chip warn';
    }
    if (info.gltfVersion !== '2.0') {
      if (!verChip) {
        verChip = document.createElement('span');
        verChip.className = 'chip accent';
        $('fileInfo').appendChild(verChip);
      }
      verChip.textContent = `版本 ${info.gltfVersion} → 2.0`;
    }
  }
}

// ---------- 压缩处理 ----------
$('btnProcess').onclick = async () => {
  if (state.busy || !state.fixedBytes) return;
  state.busy = true;
  $('btnProcess').disabled = true;

  const t0 = performance.now();
  try {
    const info = state.info;
    progress('准备编码器…', 4, '模式：reorder + FILTER（不动顶点精度、不动材质）');
    const heapStart = heapMB();

    const tEnc = performance.now();
    const { bytes: out, params } = await compressGeometry(state.fixedBytes, {
      preset: 'standard',
      onProgress: (m) => progress(null, undefined, m),
    });
    const encMs = performance.now() - tEnc;

    progress(null, 55, `编码完成：${mb(state.fixedBytes.length)} → ${mb(out.length)}（${(encMs / 1000).toFixed(1)} s）`);

    // 校验
    progress('校验 BIM 属性…', 66);
    const verify = compareJSON(state.fixedBytes, out, { transformTolerance: 0.01 });
    const failed = verify.rows.filter((r) => !r.ok);
    progress(
      null,
      78,
      verify.pass
        ? `属性校验 ${verify.rows.length} 项全部通过（变换位移 ${verify.info.maxTransformDisplacement.toExponential(1)} 单位）`
        : `属性校验失败：${failed.map((f) => f.label).join('、')}`
    );

    let geo = null;
    if (verify.pass) {
      progress('几何保真检查…', 86);
      const io = await getIO();
      geo = await compareGeometry(io, state.fixedBytes, out, 400);
      progress(null, 90, `几何（世界坐标）：抽样 ${geo.sampledPrims} 图元，包围盒最大偏移 ${geo.maxBoxShift.toExponential(2)} 单位，整体尺度差 ${geo.sizeDiffPercent.toFixed(4)}%`);
    }

    state.processed = { bytes: out, params, verify, geo, encMs };

    // 用压缩版重新渲染（顺便验证它真的能被 three 解开）
    progress('用压缩结果重建场景…', 94);
    await renderBytes(out, state.fileName.replace(/\.(glb|gltf)$/i, ''));

    updateTopbar(state.fileName + ' （已压缩）', out.length);
    $('chipSize').textContent = `${mb(state.rawBytes.length)} → ${mb(out.length)}`;
    const c = $('chipDraco');
    c.textContent = '已压缩 meshopt';
    c.className = 'chip accent';

    const totalMs = performance.now() - t0;
    progress(null, 100, `总耗时 ${(totalMs / 1000).toFixed(1)} s${heapMB() ? ` · 堆 ${heapMB().toFixed(0)} MB` : ''}`);
    progressDone(1600);
    const ratio = (1 - out.length / state.rawBytes.length) * 100;
    const pctText = (ratio >= 0 ? '−' : '+') + Math.abs(ratio).toFixed(1) + '%';
    toast(`压缩完成：${mb(state.rawBytes.length)} → ${mb(out.length)}（${pctText}）`, 'ok');
  } catch (err) {
    console.error(err);
    progressDone(0);
    toast('处理失败：' + (err?.message || err), 'err');
  } finally {
    state.busy = false;
    $('btnProcess').disabled = false;
  }
};

// ---------- 下载 ----------
$('btnDownload').onclick = () => {
  const bytes = state.processed?.bytes || state.currentBytes;
  if (!bytes) return;
  const base = state.fileName.replace(/\.(glb|gltf)$/i, '');
  const suffix = state.processed ? '_opt' : '_fixed';
  download(bytes, `${base}${suffix}.glb`);
  toast(`已下载 ${base}${suffix}.glb（${mb(bytes.length)}）`, 'ok');
};

// ---------- 搜索 ----------
let searchTimer = 0;
$('treeSearch').oninput = (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  searchTimer = setTimeout(() => {
    if (!q.trim()) {
      if (state.sceneRoot && state.batched) {
        const { total } = tree.setModel(state.sceneRoot, state.batched.objectToRecs);
        $('treeCount').textContent = `${num(total)} 节点`;
      }
      return;
    }
    const hits = tree.search(q);
    if (hits) $('treeCount').textContent = `${num(hits.length)} 个匹配`;
  }, 180);
};

// 键盘：Esc 取消选中
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    for (const r of selectedRecs) setHighlight(r, false);
    selectedRecs = [];
  }
});
