/**
 * main.js —— 页面编排：拖入 → 体检 → （可选）压缩 → 渲染 → 层级树/属性联动 → 下载
 *
 * 两条路径刻意分开：
 *   「直接查看」：只修 asset.version，不动几何，秒开；
 *   「压缩处理」：meshopt 重编码 + 19 项属性校验，慢但能出交付级文件。
 *
 * 交互约定（按使用反馈定的）：
 *   单击构件 = 高亮 + 出属性，**相机不动**；只有双击（或点「适应视图」）才移动相机。
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
import { createTree, GROUP_MODES } from './viewer/tree.js';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL || './';

const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB');
const num = (n) => Number(n || 0).toLocaleString('en-US');

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
  loadedOnce: false,
  inputCompressed: false, // 当前渲染的文件是否已压缩过（Draco / meshopt）
};

// ---------- 面板开关 ----------
// 三栏布局靠 #layout 上的 no-left / no-right 两个类控制，
// 顶栏按钮、面板右上角 ×、快捷键 1/2 都走这里，避免状态两处维护。
const layout = { left: false, right: false };

function applyLayout() {
  $('panelLeft').hidden = !layout.left;
  $('panelRight').hidden = !layout.right;
  const el = $('layout');
  el.classList.toggle('no-left', !layout.left);
  el.classList.toggle('no-right', !layout.right);
  $('btnTree').classList.toggle('active', layout.left);
  $('btnProps').classList.toggle('active', layout.right);
  // 视口宽度变了：让 renderer/camera 跟上；没被用户动过相机会自动重新取景
  requestAnimationFrame(() => viewer.resize());
}

function setPanel(which, on) {
  if (which === 'left') layout.left = on; else layout.right = on;
  applyLayout();
}

function togglePanel(which) {
  if (!state.loadedOnce) return;
  setPanel(which, !(which === 'left' ? layout.left : layout.right));
}

$('btnTree').onclick = () => togglePanel('left');
$('btnProps').onclick = () => togglePanel('right');
$('btnCloseLeft').onclick = () => setPanel('left', false);
$('btnShowAll').onclick = () => {
  if (!state.loadedOnce) return;
  tree.showAll();
  toast('已显示全部构件');
};
$('btnCloseRight').onclick = () => setPanel('right', false);

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
  onSelect: (node) => selectNode(node, { zoom: false }),
  onZoom: (node) => selectNode(node, { zoom: true }),
});

// 分组方式下拉：按 group 分组成 optgroup —— 主线（规范层级）与局部视图分开，
// 免得用户以为这是两套并行的树
const groups = new Map();
for (const [id, m] of Object.entries(GROUP_MODES)) {
  const gname = m.group || '其它';
  let og = groups.get(gname);
  if (!og) {
    og = document.createElement('optgroup');
    og.label = gname;
    groups.set(gname, og);
    $('treeGroup').appendChild(og);
  }
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = m.label;
  og.appendChild(opt);
}
$('treeGroup').value = tree.mode;
$('treeGroup').onchange = (e) => {
  if (!state.sceneRoot || !state.batched) return;
  const res = tree.setMode(e.target.value);
  if (res) updateTreeCount(res);
  // 树重建后选中态丢了，重新按当前选中回填
  if (lastRec?.object) tree.reveal(lastRec.object);
};

function updateTreeCount(res) {
  const el = $('treeCount');
  el.textContent = num(res.total);
  el.title = `${num(res.total)} 个构件${res.groups ? ` · ${res.groups} 个分组` : ''}`;
}

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

/**
 * @param {object} node 树节点
 * @param {{zoom:boolean}} opts 只有 zoom=true 才移动相机
 */
function selectNode(node, opts = {}) {
  const recs = collectRecs(node);

  for (const r of selectedRecs) setHighlight(r, false);
  selectedRecs = recs;
  for (const r of recs) setHighlight(r, true);
  lastRec = recs[0] || null;

  if (opts.zoom) {
    const box = recs.length ? unionBox(recs) : (node.obj ? new THREE.Box3().setFromObject(node.obj) : null);
    if (box && !box.isEmpty()) viewer.focusOn(box);
  }

  showProps(recs, node);
}

/** 3D 里点选：只高亮 + 出属性 + 在树里定位，相机保持不动 */
function selectRec(rec) {
  for (const r of selectedRecs) setHighlight(r, false);
  selectedRecs = [rec];
  setHighlight(rec, true);
  lastRec = rec;
  if (rec.object) tree.reveal(rec.object);
  showProps([rec], null);
}

/** 取消全部高亮 + 清树选中 + 属性面板复位（点空白处 / Esc） */
function clearSelection() {
  if (!selectedRecs.length && !lastRec) return;
  for (const r of selectedRecs) setHighlight(r, false);
  selectedRecs = [];
  lastRec = null;
  tree.clearSelection();
  showProps([], null);
}

// ---------- 属性面板 ----------
function showProps(recs, node) {
  const box = $('props');
  if (!recs || !recs.length) {
    const nm = node?.name ?? '';
    box.innerHTML =
      `<div class="prop-section"><div class="prop-section-title">分组</div>` +
      `<div class="prop-row"><span class="prop-key">名称</span><span class="prop-val">${esc(nm)}</span></div>` +
      `<div class="prop-row"><span class="prop-key">构件数</span><span class="prop-val num">${num(node?.count ?? 0)}</span></div>` +
      `</div>` +
      `<div class="empty">点选组内构件查看 BIM 属性</div>`;
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
    ['选中数量', recs.length > 1 ? `${num(recs.length)} 个` : '1 个'],
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
  else clearSelection(); // 点到空白处 = 取消高亮
});

viewer.onFrame((fps) => {
  $('hudFps').textContent = fps;
});

// ---------- 视图工具 ----------
$('btnFit').onclick = () => {
  if (viewer.fit()) toast('已适应视图');
};
$('btnTop').onclick = () => viewer.topView();
$('btnGrid').onclick = () => {
  const on = viewer.setGrid(!viewer.gridVisible);
  $('btnGrid').classList.toggle('on', on);
};

// ---------- 压缩按钮状态 ----------
// 压过头的文件不再让压：量化解回 float32 再编码必然变大（实测 63.63 → 115.34 MB）。
// 要更小只能回到原始导出重压，或换更低位深 —— 那是本地 Draco 工具的活。
const LOCAL_TOOL_HINT =
  'Draco 极限压缩请用本机的本地工具（不在本仓库）：local-tools\\draco-tool\\ 双击 start.cmd，拖入 3ds Max 导出的原始 .glb 即可。';

/**
 * 「已经压到极限，不该再压」的判据。
 *
 * 不能只看有没有 Draco：3ds Max 的原始导出本身就带 Draco，但用的是低压缩设置
 * （实测 25.5 字节/顶点），浏览器重压到 11 B/顶点是有收益的 —— 这正是主流程。
 * 真正压过的文件只有 4.5 B/顶点，再编码必然膨胀（实测 63.63 MB → 115.34 MB）。
 * 所以看的是每顶点字节数，不是扩展名。
 */
function isAlreadyTight(info) {
  if (!info) return false;
  if (info.hasMeshopt) return true;               // 本工具的产物，同算法重压无收益
  const bpv = info.bytesPerVertex || 0;
  return !!info.hasDraco && bpv > 0 && bpv <= 8;  // Draco 极限约 4.5 B
}

function tightReason(info) {
  if (!info) return '';
  if (info.hasMeshopt) return '这份文件已经用 meshopt 压过，同样算法再压一次没有收益。';
  return `这份文件已经压到 ${info.bytesPerVertex} 字节/顶点（Draco 极限约 4.5），再编码只会变大。`;
}

function updateProcessButton() {
  const btn = $('btnProcess');
  if (!state.loadedOnce) return;
  const info = state.info;
  const compressed = state.inputCompressed;

  if (compressed) {
    btn.textContent = '已压缩';
    btn.classList.add('is-done');
    btn.title = `${tightReason(info)}\n${LOCAL_TOOL_HINT}`;
  } else {
    btn.textContent = '压缩处理';
    btn.classList.remove('is-done');
    btn.title = `在浏览器里做「重排 + meshopt FILTER 编码」，不动顶点精度和材质（约 −45%）。当前 ${info?.bytesPerVertex ?? '?'} 字节/顶点`;
  }
  btn.disabled = state.busy || compressed;
}

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
  /** 出错时报给用户看是哪一步挂的 —— 光看 three 的原始报错根本猜不到 */
  let stage = '读取文件';

  try {
    progress('读取文件…', 4, `文件：${file.name}（${mb(file.size)}）`);
    const raw = new Uint8Array(await file.arrayBuffer());
    state.rawBytes = raw;

    // 1) 体检（只读 JSON，不解码几何）
    stage = '解析 GLB 结构';
    progress('解析 GLB 结构…', 12);
    state.info = inspectBytes(raw);
    state.inputCompressed = isAlreadyTight(state.info);

    // 2) 修版本 + 清掉非法的 null 字段（3ds Max 常写 2.1 和 "targets": null）
    stage = '修正元数据';
    progress('检查 asset.version…', 20);
    const fixed = fixAssetVersion(raw);
    state.fixedBytes = fixed.bytes;
    if (fixed.changed) progress(null, undefined, `已修正元数据（asset.version ${fixed.from} → 2.0${fixed.removedNulls ? `，清掉 ${fixed.removedNulls} 处 null` : ''}）`);

    // 3) 渲染
    stage = '解码并渲染';
    progress('解码并渲染…', 30);
    await renderBytes(fixed.bytes, baseName);

    progressDone();
    updateTopbar(file.name, file.size);
    if (state.inputCompressed) {
      toast(
        `已加载。${tightReason(state.info)}不用再压 —— 想更小请用本地 Draco 工具处理 3ds Max 原始导出`,
        'ok'
      );
    } else if (state.info.flatHierarchy) {
      toast('已加载。源文件节点是平铺的（无层级），已按 BIM 属性合成层级树', 'ok');
    } else {
      toast('已加载，可直接查看或点「压缩处理」', 'ok');
    }
  } catch (err) {
    console.error(err);
    progressDone(0);
    toast(`加载失败（${stage}）：${err?.message || err}`, 'err');
  } finally {
    state.busy = false;
    // 按钮在 renderBytes 里被设置过一次，那时 busy 还是 true；
    // 这里必须再刷一次，否则加载完按钮仍是禁用状态
    updateProcessButton();
  }
}

/**
 * GLTFLoader 会按 PropertyBinding 规则改写节点名（空格→下划线、去掉方括号等），
 * 层级树上就和 3ds Max 对不上了。用 parser.associations 找回 GLB 里的原始名。
 */
function makeNameResolver(gltf) {
  const assoc = gltf.parser?.associations;
  const json = gltf.parser?.json;
  if (!assoc || !json?.nodes) return null;
  const cache = new WeakMap();
  return (obj) => {
    if (cache.has(obj)) return cache.get(obj);
    let name;
    const a = assoc.get(obj);
    if (a && a.nodes !== undefined) {
      const raw = json.nodes[a.nodes]?.name;
      if (raw) name = String(raw).replace(/\s+/g, ' ').trim();
    }
    cache.set(obj, name);
    return name;
  };
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

  const nameOf = makeNameResolver(gltf);
  const batched = await batchGLTFScene(gltf.scene, {
    onProgress: ({ done, total, phase }) => {
      if (phase === 'batch') progress(null, 46 + (done / Math.max(1, total)) * 44);
    },
    chunk: 200,
    nameOf,
  });
  state.batched = batched;

  // 先把面板摆好再取景：面板开合会改宽高比，早了会按旧视口算距离
  if (!state.loadedOnce) {
    layout.left = true;
    layout.right = true;
  }
  applyLayout();
  state.loadedOnce = true;

  viewer.setModel(batched.group, batched.box);

  // 层级树用「原始 scene 结构」，批处理只是把几何搬进 BatchedMesh，Object3D 仍在
  const res = tree.setModel(gltf.scene, batched.objectToRecs);
  updateTreeCount(res);

  $('dropzone').classList.add('hidden');
  $('hud').hidden = false;
  $('viewTools').hidden = false;
  $('btnTree').hidden = false;
  $('btnProps').hidden = false;
  $('btnProcess').hidden = false;
  $('btnDownload').hidden = false;
  updateProcessButton();

  updateHud(batched, gltf);

  progress(null, 92, `批处理完成：${batched.stats.meshes} 个几何 → ${batched.stats.drawCalls} 个 draw call（${batched.stats.buildMs} ms）`);
}

function updateHud(batched) {
  const info = state.info;
  $('hudDraw').textContent = num(batched.stats.drawCalls);
  $('hudTri').textContent = num(info?.triangles || 0);
  $('hudParts').textContent = num(batched.stats.meshes);
  $('hudBatch').textContent = `${num(batched.stats.meshes)} → ${num(batched.stats.drawCalls)}`;
}

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
  }
}

// ---------- 压缩处理 ----------
$('btnProcess').onclick = async () => {
  if (state.busy || !state.fixedBytes) return;

  // 已压缩的文件不让再压：量化后再解回 float32 只会更大（实测 63.6 → 115 MB）
  if (state.inputCompressed) {
    toast(`${tightReason(state.info)}${LOCAL_TOOL_HINT}`, 'err');
    return;
  }

  state.busy = true;
  updateProcessButton();

  const t0 = performance.now();
  try {
    progress('准备编码器…', 4, '模式：reorder + FILTER（不动顶点精度、不动材质）');

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
    state.inputCompressed = true; // 输出已是 meshopt，别再压一次

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
    updateProcessButton();
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
        updateTreeCount(tree.setModel(state.sceneRoot, state.batched.objectToRecs));
      }
      return;
    }
    const hits = tree.search(q);
    if (hits) {
      const el = $('treeCount');
      el.textContent = num(hits.length);
      el.title = `${num(hits.length)} 个匹配`;
    }
  }, 180);
};

// ---------- 快捷键 ----------
window.addEventListener('keydown', (e) => {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  if (e.key === 'Escape') clearSelection();
  if (!state.loadedOnce) return;
  if (e.key === '1') togglePanel('left');
  if (e.key === '2') togglePanel('right');
  if (e.key === 'f' || e.key === 'F') viewer.fit();
});

// 便于自动化测试/排查：控制台里可以直接拿到核心对象
window.__bim = { viewer, state, layout, tree };
