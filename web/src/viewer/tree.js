/**
 * tree.js —— 模型层级树
 *
 * 两种模式：
 *   1. 原始结构：照 GLTFLoader 的 scene 图原样铺开（源文件真有层级时才用得上）
 *   2. 分组结构（默认）：3ds Max / Revit 导出的 GLB 常常是**完全平铺**的
 *      （本例 12,244 个节点全在根上、零子节点），照原样铺只能给出一条一万多行的平列表。
 *      所以按 BIM 属性合成层级：类别 → 类型 → 构件，和 Max 里"图层/族类型"两层是一个意思。
 *
 * 12,244 个节点不能一次全塞进 DOM，所以：初始只渲染根的子节点，展开时才插入子节点；
 * 单个节点子项超过上限时只渲染前 N 个，其余提示用搜索定位。
 * 搜索走全树遍历，命中后显示扁平列表并自动展开祖先链。
 *
 * 显示/隐藏：
 *   - 每行一个复选框：勾选 = 显示，取消 = 隐藏；组是三态（全显 / 全隐 / 部分 = indeterminate）
 *   - 隐藏组 = 隐藏整棵子树；隐藏的构件不可见、也不可被拾取（BatchedMesh 拾取会跳过隐藏实例）
 *   - 右键行 → 菜单：隐藏 / 显示 / 全部显示
 */

import { setVisible } from './bim-batch.js';
import { systemName } from './system-names.js';
import { DISCIPLINES, classifyLeaves, disciplineCode, disciplineName } from './discipline.js';
import { cleanText as clean, systemAbbr, systemKey, stripAbbrPrefix } from './system-key.js';

// 兼容既有引用（测试与其它模块一直从 tree.js 取这几个函数）
export { systemAbbr, systemKey, stripAbbrPrefix };

const MAX_CHILDREN_RENDER = 800;

/**
 * 分组方式。
 *
 * 主线只有一套（unified）：专业 → 系统 → 类别 → 类型 → 构件。
 * 其余是**同一批构件的局部视图**（单轴展开），不是平行的第二套层级 ——
 * 因此构件不会在多棵树里重复出现，计数永远一致。
 */
export const GROUP_MODES = {
  unified: {
    label: '专业→系统→类别→类型', group: '规范层级（主线）',
    fields: [
      { key: '专业', map: (raw, props) => disciplineName(disciplineCode(props)), code: (props) => disciplineCode(props), bulk: (leaves) => classifyLeaves(leaves), label: '专业' },
      { key: '系统名称', map: (raw, props) => systemKey(props || { 系统名称: raw }), label: '系统', optional: true },
      { key: 'Category Name' },
      { key: 'Type Name' },
    ],
  },
  unifiedFamily: {
    label: '专业→系统→类别→族→类型', group: '规范层级（主线）',
    fields: [
      { key: '专业', map: (raw, props) => disciplineName(disciplineCode(props)), code: (props) => disciplineCode(props), bulk: (leaves) => classifyLeaves(leaves), label: '专业' },
      { key: '系统名称', map: (raw, props) => systemKey(props || { 系统名称: raw }), label: '系统', optional: true },
      { key: 'Category Name' },
      { key: '族', optional: true },
      { key: 'Type Name' },
    ],
  },
  system: {
    label: '系统→类别', group: '局部视图',
    fields: [
      { key: '系统名称', map: (raw, props) => systemKey(props || { 系统名称: raw }), label: '系统' },
      { key: 'Category Name' },
    ],
  },
  systemType: {
    label: '系统→类别→类型', group: '局部视图',
    fields: [
      { key: '系统名称', map: (raw, props) => systemKey(props || { 系统名称: raw }), label: '系统' },
      { key: 'Category Name' },
      { key: 'Type Name' },
    ],
  },
  category: {
    label: '类别→类型', group: '局部视图',
    fields: [{ key: 'Category Name' }, { key: 'Type Name' }],
  },
  family: {
    label: '族→类型', group: '局部视图',
    fields: [{ key: '族' }, { key: 'Type Name' }],
  },
  level: {
    label: '标高→类别', group: '局部视图',
    fields: [{ key: '参照标高' }, { key: 'Category Name' }],
  },
  raw: { label: '原始结构', group: '局部视图', fields: null },
};

function cmpName(a, b) {
  // 「未分类」永远排最后，别挡住有类别的构件
  const ua = a.name === '(未分类)';
  const ub = b.name === '(未分类)';
  if (ua !== ub) return ua ? 1 : -1;
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
}

/** 递归建「原始结构」轻量树（不碰 DOM） */
function buildRaw(obj, depth, objectToRecs) {
  const recs = objectToRecs.get(obj);
  let verts = 0;
  if (recs) for (const r of recs) verts += r.object?.geometry?.attributes?.position?.count || 0;

  const kids = [];
  for (const child of obj.children || []) {
    kids.push(buildRaw(child, depth + 1, objectToRecs));
  }

  const hasMesh = !!(obj.isMesh || (recs && recs.length));
  return {
    obj,
    name: obj.name || (hasMesh ? '(未命名构件)' : '(分组)'),
    depth,
    children: kids,
    recs: recs || null,
    verts,
    hasMesh,
    isGroup: !hasMesh,
    count: kids.length,
  };
}

/**
 * 合成分组树：类别 → 类型 → 构件
 *
 * @param {THREE.Object3D} sceneRoot
 * @param {Map} objectToRecs Object3D → rec[]
 * @param {Array<{key:string, map?:(v:string)=>string, label?:string}>} fields 逐层的属性定义
 *        map 用于把原始值归一到分类键（例如「系统名称」→「系统缩写」）
 */
function buildGrouped(sceneRoot, objectToRecs, fields) {
  const leaves = [];
  sceneRoot.traverse((o) => {
    const recs = objectToRecs.get(o);
    if (!recs || !recs.length) return;
    let verts = 0;
    for (const r of recs) verts += r.object?.geometry?.attributes?.position?.count || 0;
    leaves.push({
      obj: o,
      name: recs[0].name || o.name || '(未命名构件)',
      depth: fields.length + 1,
      children: [],
      recs,
      verts,
      hasMesh: true,
      isGroup: false,
      count: 1,
      props: recs[0].props || {},
    });
  });

  leaves.sort(cmpName);

  // 每层先算好每个叶子的分类键，用两件事：
  //   (a) 折叠「整层只有一个取值」的空层 —— 没有系统字段的建筑/结构模型不该多出
  //       一层全是「(未分类)」的假层级；整份模型同属一个专业时同理
  //   (b) 后面建立树时不用重复调 map（map 可能读多个字段，不便宜）
  const labelOf = (leaf, f) => {
    const key = typeof f === 'string' ? f : f.key;
    const rawVal = clean(leaf.props[key]);
    // 分类键：有 map 就用归一化结果（如系统缩写），否则用原值
    const label = (typeof f === 'string' || !f.map ? rawVal : clean(f.map(rawVal, leaf.props))) || '(未分类)';
    return { key, rawVal, label };
  };
  // 需要「整批上下文」的层（如专业：要参考同类别其它构件）先算一遍
  const bulkVals = fields.map((f) => (typeof f !== 'string' && f.bulk ? f.bulk(leaves) : null));
  const grid = leaves.map((leaf) => fields.map((f, i) => {
    const bv = bulkVals[i]?.get(leaf);
    if (!bv) return labelOf(leaf, f);
    return { key: typeof f === 'string' ? f : f.key, rawVal: '', label: bv.label, code: bv.code, from: bv.from };
  }));
  const activeIdx = fields
    .map((_, i) => i)
    .filter((i) => {
      if (fields.length === 1 || i === 0) return true; // 顶层永远保留，单层模式不折叠
      const first = grid[0]?.[i]?.label;
      return grid.some((row) => row[i].label !== first);
    });

  const root = {
    obj: sceneRoot, name: '模型', depth: 0, children: [],
    recs: null, hasMesh: false, isGroup: true, count: leaves.length,
  };

  const maps = new Map(); // 父节点 → (标签 → 子节点)
  for (let li = 0; li < leaves.length; li++) {
    const leaf = leaves[li];
    let parent = root;
    let depth = 0;
    for (let d = 0; d < activeIdx.length; d++) {
      const i = activeIdx[d];
      const f = fields[i];
      const { key, rawVal, label, code: bulkCode } = grid[li][i];

      // 可选层（系统 / 族）没有值时，不给这个构件凭空造一层「(未分类)」——
      // 建筑构件本来就不属于任何机电系统，直接挂到上一级更符合实际。
      // 深度按实际走过的层数算，所以这种构件的叶子会比同层其它构件浅一级。
      if (typeof f !== 'string' && f.optional && label === '(未分类)') continue;

      let m = maps.get(parent);
      if (!m) { m = new Map(); maps.set(parent, m); }
      let g = m.get(label);
      if (!g) {
        g = {
          obj: null, name: label, depth: depth + 1, children: [],
          recs: null, hasMesh: false, isGroup: true, count: 0,
          field: key, fieldLabel: (typeof f === 'string' ? key : f.label) || key,
          raws: new Set(),   // 归到这个分类键下的原始取值（悬浮提示里给用户看）
          mapped: !!(typeof f !== 'string' && f.map), // 分类键是归一化出来的（如系统缩写）
          typeFreq: new Map(),  // 该组下各「类型」出现次数（给中文系统名兜底用）
          sysTypeFreq: new Map(), // 「系统类型」取值次数（如 "EAD-排风管"）
          sysCatFreq: new Map(),  // 「系统分类」取值次数（如 "排风"）
        };
        m.set(label, g);
        parent.children.push(g);
      }
      // 专业层记下代码，供行上色（渲染时按 disc-XXX 加 class）
      if (!g.discCode) g.discCode = bulkCode || (typeof f !== 'string' && f.code ? f.code(leaf.props) : '');
      if (rawVal) g.raws.add(rawVal);
      const tn = clean(leaf.props['Type Name']);
      if (tn) g.typeFreq.set(tn, (g.typeFreq.get(tn) || 0) + 1);
      if (g.mapped) {
        // 模型自带的系统语义字段：优先拿来当中文名（比缩写对照表可靠）
        const st = clean(leaf.props['系统类型']);
        if (st) g.sysTypeFreq.set(st, (g.sysTypeFreq.get(st) || 0) + 1);
        const sc = clean(leaf.props['系统分类']);
        if (sc) g.sysCatFreq.set(sc, (g.sysCatFreq.get(sc) || 0) + 1);
      }
      g.count++;
      parent = g;
      depth++;
    }
    leaf.depth = depth + 1;
    parent.children.push(leaf);
  }

  // 组按名称排，组内构件已按名称排好
  const sortDeep = (n) => {
    if (n.children.length > 1) n.children.sort(cmpName);
    for (const c of n.children) if (c.children.length) sortDeep(c);
  };
  sortDeep(root);

  // 给归一化出来的分组（如系统缩写）补中文名：
  // 先查内置对照表，查不到就用该组里出现最多的「类型」兜底 —— 不凭空造名字
  const topType = (freq) => {
    let best = '';
    let max = 0;
    for (const [k, v] of freq) if (v > max) { best = k; max = v; }
    return best;
  };
  const assignHint = (n) => {
    if (n.isGroup && n.mapped && n.fieldLabel === '系统') {
      // ① 模型自带「系统类型」：去掉缩写前缀即中文名（"EAD-排风管" → "排风管"）
      const sysType = stripAbbrPrefix(topType(n.sysTypeFreq), n.name);
      // ② 模型自带「系统分类」：如「排风」
      const sysCat = topType(n.sysCatFreq);
      // ③ 内置缩写对照表
      const dict = systemName(n.name);
      // ④ 该组最常见的构件「类型」名
      const typeName = topType(n.typeFreq);

      if (sysType) { n.hint = sysType; n.hintFrom = 'sysType'; }
      else if (sysCat) { n.hint = sysCat; n.hintFrom = 'sysCat'; }
      else if (dict) { n.hint = dict; n.hintFrom = 'dict'; }
      else if (typeName) { n.hint = typeName; n.hintFrom = 'data'; }

      // 系统类型 / 系统分类 的原值都留着，悬浮时给出完整对应关系
      if (n.sysTypeFreq.size) n.sysTypeNames = [...n.sysTypeFreq.keys()];
      if (n.sysCatFreq.size) n.sysCatNames = [...n.sysCatFreq.keys()];
    }
    for (const c of n.children) assignHint(c);
  };
  assignHint(root);

  return root;
}

function linkParents(node, parent = null) {
  node.parent = parent;
  for (const c of node.children) linkParents(c, node);
}

function countAll(node) {
  let n = node.isGroup ? 0 : 1;
  for (const c of node.children) n += countAll(c);
  return n;
}

export function createTree(container, opts = {}) {
  const { onSelect, onZoom } = opts;
  let root = null;
  let mode = 'unified';
  let sceneRoot = null;
  let recsMap = new Map();
  let selectedRow = null;
  const elByNode = new Map(); // 树节点 → DOM 行
  const nodeByObj = new Map(); // Object3D → 树节点（3D 点选反查用）

  const iconFor = (node) => (node.isGroup ? '▤' : '◆');
  const clsFor = (node) => (node.isGroup ? 'group' : 'mesh');

  // ---------- 显示 / 隐藏 ----------
  // 状态只在 rec.visible 上存（默认 true），复选框三态每现算：
  // 组的可见性永远从子项推导，不单独存，改组 = 改整棵子树的 rec。

  /** 节点可见性：true / false / 'mixed'（组内部分隐藏） */
  function visState(node) {
    let sawOn = false;
    let sawOff = false;
    const walk = (n) => {
      if (n.recs) for (const r of n.recs) (r.visible === false ? (sawOff = true) : (sawOn = true));
      for (const c of n.children) walk(c);
    };
    walk(node);
    if (!sawOff) return true;
    if (!sawOn) return false;
    return 'mixed';
  }

  /** 把一个节点的复选框与行样式刷到最新（行不在 DOM 里就跳过） */
  function syncRow(node) {
    const row = elByNode.get(node);
    if (!row) return;
    const st = visState(node);
    const cb = row.querySelector('.node-vis');
    if (cb) {
      cb.checked = st === true;
      cb.indeterminate = st === 'mixed';
    }
    row.classList.toggle('hidden', st === false);
    row.classList.toggle('partial', st === 'mixed');
  }

  /** 设置节点（含整棵子树）的可见性，并刷新它和所有已渲染祖先的复选框 */
  function setNodeVisible(node, on) {
    const walk = (n) => {
      if (n.recs) for (const r of n.recs) {
        if (r.visible === on) continue;
        r.visible = on;
        setVisible(r, on);
      }
      for (const c of n.children) walk(c);
    };
    walk(node);
    for (let p = node; p; p = p.parent) syncRow(p);
    // 已渲染的后代行也要刷（隐藏组时子行的勾要跟着消失）
    const syncKids = (n) => {
      for (const c of n.children) { syncRow(c); syncKids(c); }
    };
    syncKids(node);
  }

  /** 全部显示（重置所有 rec，刷新所有已渲染行）。
   *  必须两趟：先重置完所有 rec 再刷行，否则父行刷的时候子树还没恢复，
   *  算出来仍是隐藏态、再也不刷新。 */
  function showAll() {
    if (!root) return;
    const reset = (n) => {
      if (n.recs) for (const r of n.recs) {
        if (r.visible !== true) { r.visible = true; setVisible(r, true); }
      }
      for (const c of n.children) reset(c);
    };
    reset(root);
    const sync = (n) => {
      syncRow(n);
      for (const c of n.children) sync(c);
    };
    sync(root);
  }

  // ---------- 右键菜单 ----------
  let ctxMenu = null;
  function closeCtxMenu() { ctxMenu?.remove(); ctxMenu = null; }

  function openCtxMenu(x, y, node) {
    closeCtxMenu();
    ctxMenu = document.createElement('div');
    ctxMenu.className = 'ctx-menu';
    const items = [
      ['隐藏', () => setNodeVisible(node, false)],
      ['显示', () => setNodeVisible(node, true)],
      ['全部显示', () => showAll()],
    ];
    for (const [label, fn] of items) {
      const it = document.createElement('div');
      it.className = 'ctx-item';
      it.textContent = label;
      it.addEventListener('click', () => { closeCtxMenu(); fn(); });
      ctxMenu.appendChild(it);
    }
    document.body.appendChild(ctxMenu);
    const r = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 8))}px`;
    ctxMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 8))}px`;
  }

  // 点别处 / Esc 关菜单；菜单自己内部的按下不算（否则菜单项还没点到就被关了）
  document.addEventListener('pointerdown', (e) => {
    if (ctxMenu && e.target instanceof Node && ctxMenu.contains(e.target)) return;
    closeCtxMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });

  /** 行级复选框（勾选=显示，取消=隐藏；不触发行选中） */
  function makeVisCheckbox(node) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'node-vis';
    cb.title = '勾选显示 / 取消勾选隐藏';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('dblclick', (e) => e.stopPropagation());
    cb.addEventListener('change', () => setNodeVisible(node, cb.checked));
    return cb;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderChildren(node) {
    const wrap = document.createElement('div');
    wrap.className = 'node-children';

    const kids = node.children;
    const shown = kids.slice(0, MAX_CHILDREN_RENDER);
    for (const child of shown) wrap.appendChild(renderNode(child));

    if (kids.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'node node-more';
      more.style.paddingLeft = `${(node.depth + 1) * 13 + 19}px`;
      more.textContent = `还有 ${kids.length - shown.length} 个… 用上方搜索定位`;
      wrap.appendChild(more);
    }
    return wrap;
  }

  function renderNode(node) {
    // 每个节点外面套一个块级 item：子节点容器必须挂在 item 上而不是行上，
    // 否则会被 .node{display:flex;height:24px} 当成一个 flex 子项夹在行里、还裁掉高度
    const item = document.createElement('div');
    item.className = 'node-item';

    const row = document.createElement('div');
    row.className = 'node' + (node.isGroup ? ' is-group' : '')
      + (node.discCode ? ` disc disc-${node.discCode}` : '');
    row.style.paddingLeft = `${node.depth * 13 + 2}px`;
    // 分组节点：把归一化前的一串原始取值列在悬浮提示里（如 CN 5 / CN 7 / CN 15 → CN）
    if (node.discCode) {
      // 专业层：说明这一级是怎么归出来的
      row.title = `专业：${node.name}（一级归类）\n`
        + '归并依据：系统缩写 → 系统分类/系统类型 → 类别/族，消防优先单列\n'
        + `本专业构件数：${node.count}`;
    } else if (node.isGroup && (node.hint || node.raws?.size > 1)) {
      const parts = [];
      if (node.hint) {
        const src = {
          sysType: '模型自带「系统类型」',
          sysCat: '模型自带「系统分类」',
          dict: '内置缩写对照表',
          data: '按该组常见类型名推断',
        }[node.hintFrom] || '推断';
        parts.push(`${node.name}（${node.hint}，来源：${src}）`);
      } else {
        parts.push(`${node.fieldLabel || '分组'}「${node.name}」`);
      }
      if (node.sysCatNames?.length) parts.push(`系统分类：${node.sysCatNames.slice(0, 6).join('、')}`);
      if (node.sysTypeNames?.length) parts.push(`系统类型：${node.sysTypeNames.slice(0, 6).join('、')}`);
      if (node.raws?.size > 1) {
        const list = [...node.raws];
        parts.push(`系统名称（${list.length} 种）：`
          + list.slice(0, 20).join('、')
          + (list.length > 20 ? ` …等 ${list.length} 种` : ''));
      }
      row.title = parts.join('\n');
    } else {
      row.title = node.name;
    }
    item.appendChild(row);

    const hasKids = node.children.length > 0;
    const caret = document.createElement('span');
    caret.className = 'node-caret' + (hasKids ? '' : ' leaf');
    caret.textContent = '▶';
    row.appendChild(caret);

    row.appendChild(makeVisCheckbox(node));

    const icon = document.createElement('span');
    icon.className = 'node-icon ' + clsFor(node);
    icon.textContent = iconFor(node);
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'node-name';
    name.textContent = node.name;
    row.appendChild(name);

    // 系统分组的中文名跟在缩写后面（CN 5 / CN 7 → CN 冷凝水）
    if (node.hint) {
      const hint = document.createElement('span');
      hint.className = 'node-hint';
      hint.textContent = node.hint;
      hint.title = {
        sysType: '来自模型属性「系统类型」',
        sysCat: '来自模型属性「系统分类」',
        dict: '来自内置缩写对照表',
        data: '按该组最常见的类型名推断',
      }[node.hintFrom] || '';
      row.appendChild(hint);
    }

    if (node.isGroup) {
      const meta = document.createElement('span');
      meta.className = 'node-meta';
      meta.textContent = node.count ? String(node.count) : '';
      row.appendChild(meta);
    } else if (node.children.length) {
      const meta = document.createElement('span');
      meta.className = 'node-meta';
      meta.textContent = String(node.children.length);
      row.appendChild(meta);
    }

    row.__node = node;
    row.__item = item;
    row.__wrap = null;
    elByNode.set(node, row);
    syncRow(node); // 按当前 rec.visible 刷复选框与隐藏样式

    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hasKids) return;
      setOpen(node, !(row.__wrap && row.__wrap.classList.contains('open')));
    });

    row.addEventListener('click', () => {
      select(node, row);
      if (hasKids && !(row.__wrap && row.__wrap.classList.contains('open'))) setOpen(node, true);
    });

    // 双击才是"定位过去"，单击绝不移动相机
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      onZoom?.(node);
    });

    // 右键：隐藏 / 显示 / 全部显示
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY, node);
    });

    return item;
  }

  /** 展开/收起：首次展开才真正建 DOM */
  function setOpen(node, open) {
    const row = elByNode.get(node);
    if (!row || !node.children.length) return;
    if (!row.__wrap) {
      row.__wrap = renderChildren(node);
      row.__item.appendChild(row.__wrap);
    }
    row.__wrap.classList.toggle('open', open);
    row.querySelector('.node-caret')?.classList.toggle('open', open);
  }

  function select(node, row) {
    if (selectedRow) selectedRow.classList.remove('selected');
    selectedRow = row;
    row.classList.add('selected');
    onSelect?.(node);
  }

  function rebuild() {
    container.innerHTML = '';
    elByNode.clear();
    nodeByObj.clear();
    selectedRow = null;
    if (!sceneRoot) {
      container.innerHTML = '<div class="tree-empty">没有可显示的层级</div>';
      return { total: 0 };
    }

    const fields = GROUP_MODES[mode]?.fields ?? null;
    root = fields ? buildGrouped(sceneRoot, recsMap, fields) : buildRaw(sceneRoot, 0, recsMap);
    linkParents(root);

    // 建 Object3D → 节点索引
    const index = (n) => {
      if (n.obj) nodeByObj.set(n.obj, n);
      for (const c of n.children) index(c);
    };
    index(root);

    // 根行 + 展开第一层；分组模式再多展开一层（类别 → 类型），不然看不到类型
    container.appendChild(renderNode(root));
    setOpen(root, true);
    if (fields) {
      for (const g of root.children.slice(0, 400)) {
        if (g.isGroup && g.children.length) setOpen(g, false);
      }
    }

    return { total: countAll(root), groups: fields ? root.children.length : 0 };
  }

  function setModel(nextSceneRoot, objectToRecs, options = {}) {
    sceneRoot = nextSceneRoot;
    recsMap = objectToRecs || new Map();
    if (options.mode) mode = options.mode;
    return rebuild();
  }

  function setMode(next) {
    if (!GROUP_MODES[next] || next === mode) return null;
    mode = next;
    return rebuild();
  }

  /** 从外部（3D 点选）反向定位到树节点：逐级展开祖先并滚动到可见 */
  function reveal(obj) {
    if (!obj) return;
    let tn = nodeByObj.get(obj);
    if (!tn) {
      // 命中的是 mesh，但树上挂的是它的父级分组 → 往上找
      let p = obj.parent;
      while (p && !tn) { tn = nodeByObj.get(p); p = p.parent; }
    }
    if (!tn) return;

    const chain = [];
    for (let n = tn; n && n !== root; n = n.parent) chain.push(n);
    chain.reverse();
    for (const n of chain) setOpen(n, true);   // 自上而下，父展开后子行才存在

    const row = elByNode.get(tn);
    if (!row) return;
    if (selectedRow) selectedRow.classList.remove('selected');
    row.classList.add('selected');
    selectedRow = row;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /** 搜索：扁平列出命中项，点击直接选中 */
  function search(q) {
    const kw = q.trim().toLowerCase();
    if (!kw) return null;
    if (!root) return [];

    const hits = [];
    const walk = (node) => {
      if (hits.length > 500) return;
      if (!node.isGroup && node.name.toLowerCase().includes(kw)) hits.push(node);
      for (const c of node.children) walk(c);
    };
    walk(root);

    container.innerHTML = '';
    elByNode.clear();

    if (!hits.length) {
      container.innerHTML = `<div class="tree-empty">没有名称包含「${esc(q)}」的构件</div>`;
      return hits;
    }

    for (const node of hits.slice(0, 500)) {
      const row = document.createElement('div');
      row.className = 'node';
      row.title = node.name;
      row.appendChild(makeVisCheckbox(node));
      const icon = document.createElement('span');
      icon.className = 'node-icon mesh';
      icon.textContent = '◆';
      row.appendChild(icon);
      const name = document.createElement('span');
      name.className = 'node-name';
      name.textContent = node.name;
      row.appendChild(name);
      row.addEventListener('click', () => select(node, row));
      row.addEventListener('dblclick', (e) => { e.preventDefault(); onZoom?.(node); });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCtxMenu(e.clientX, e.clientY, node);
      });
      elByNode.set(node, row);
      syncRow(node);
      container.appendChild(row);
    }
    return hits;
  }

  /** 清掉树里的选中态（点空白处取消高亮时用） */
  function clearSelection() {
    if (selectedRow) {
      selectedRow.classList.remove('selected');
      selectedRow = null;
    }
  }

  return {
    setModel,
    setMode,
    reveal,
    search,
    clearSelection,
    showAll,
    get mode() { return mode; },
    get root() { return root; },
  };
}
