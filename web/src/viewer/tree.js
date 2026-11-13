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
 */

const MAX_CHILDREN_RENDER = 800;

/** 分组方式：都是拿 extras 里的中文属性做键，尾部 \r 要清掉 */
export const GROUP_MODES = {
  category: { label: '类别 → 类型', fields: ['Category Name', 'Type Name'] },
  system: { label: '系统 → 类别', fields: ['系统名称', 'Category Name'] },
  family: { label: '族 → 类型', fields: ['族', 'Type Name'] },
  level: { label: '标高 → 类别', fields: ['参照标高', 'Category Name'] },
  raw: { label: '原始结构', fields: null },
};

const clean = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();

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
 * @param {THREE.Object3D} sceneRoot
 * @param {Map} objectToRecs Object3D → rec[]
 * @param {string[]} fields 逐层的属性键
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

  const root = {
    obj: sceneRoot, name: '模型', depth: 0, children: [],
    recs: null, hasMesh: false, isGroup: true, count: leaves.length,
  };

  const maps = new Map(); // 父节点 → (标签 → 子节点)
  for (const leaf of leaves) {
    let parent = root;
    for (let i = 0; i < fields.length; i++) {
      const label = clean(leaf.props[fields[i]]) || '(未分类)';
      let m = maps.get(parent);
      if (!m) { m = new Map(); maps.set(parent, m); }
      let g = m.get(label);
      if (!g) {
        g = {
          obj: null, name: label, depth: i + 1, children: [],
          recs: null, hasMesh: false, isGroup: true, count: 0, field: fields[i],
        };
        m.set(label, g);
        parent.children.push(g);
      }
      g.count++;
      parent = g;
    }
    leaf.depth = fields.length + 1;
    parent.children.push(leaf);
  }

  // 组按名称排，组内构件已按名称排好
  const sortDeep = (n) => {
    if (n.children.length > 1) n.children.sort(cmpName);
    for (const c of n.children) if (c.children.length) sortDeep(c);
  };
  sortDeep(root);
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
  let mode = 'category';
  let sceneRoot = null;
  let recsMap = new Map();
  let selectedRow = null;
  const elByNode = new Map(); // 树节点 → DOM 行
  const nodeByObj = new Map(); // Object3D → 树节点（3D 点选反查用）

  const iconFor = (node) => (node.isGroup ? '▤' : '◆');
  const clsFor = (node) => (node.isGroup ? 'group' : 'mesh');

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
    row.className = 'node' + (node.isGroup ? ' is-group' : '');
    row.style.paddingLeft = `${node.depth * 13 + 2}px`;
    row.title = node.name;
    item.appendChild(row);

    const hasKids = node.children.length > 0;
    const caret = document.createElement('span');
    caret.className = 'node-caret' + (hasKids ? '' : ' leaf');
    caret.textContent = '▶';
    row.appendChild(caret);

    const icon = document.createElement('span');
    icon.className = 'node-icon ' + clsFor(node);
    icon.textContent = iconFor(node);
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'node-name';
    name.textContent = node.name;
    row.appendChild(name);

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
      row.innerHTML =
        `<span class="node-caret leaf"></span>` +
        `<span class="node-icon mesh">◆</span>` +
        `<span class="node-name">${esc(node.name)}</span>`;
      row.addEventListener('click', () => select(node, row));
      row.addEventListener('dblclick', () => onZoom?.(node));
      elByNode.set(node, row);
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
    get mode() { return mode; },
    get root() { return root; },
  };
}
