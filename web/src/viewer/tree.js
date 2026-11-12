/**
 * tree.js —— 模型层级树
 *
 * 12,244 个节点不能一次全塞进 DOM，所以：初始只渲染根的子节点，展开时才插入子节点；
 * 单个节点子项超过 600 时只渲染前 600 个，其余提示用搜索定位。
 * 搜索走全树遍历，命中后显示扁平列表并自动展开祖先链。
 */

const MAX_CHILDREN_RENDER = 600;

/** 递归建轻量树结构（不碰 DOM） */
function buildNode(obj, depth, objectToRecs) {
  const recs = objectToRecs.get(obj);
  let verts = 0;
  if (recs) {
    for (const r of recs) {
      const g = r.object?.geometry;
      verts += g?.attributes?.position?.count || 0;
    }
  }

  const kids = [];
  for (const child of obj.children || []) {
    if (child.userData?.__skipTree) continue;
    kids.push(buildNode(child, depth + 1, objectToRecs));
  }

  // 只有真正承载几何的节点才显示蓝点，纯分组节点用灰点
  const hasMesh = !!(obj.isMesh || (recs && recs.length));
  return {
    obj,
    name: obj.name || (hasMesh ? '(未命名构件)' : '(分组)'),
    depth,
    children: kids,
    recs: recs || null,
    verts,
    hasMesh,
  };
}

function countAll(node) {
  let n = 1;
  for (const c of node.children) n += countAll(c);
  return n;
}

export function createTree(container, opts = {}) {
  const { onSelect } = opts;
  let root = null;
  let selectedEl = null;
  let selectedObj = null;
  const elByObj = new Map(); // Object3D → DOM（用于外部选中时展开+滚动）

  const iconFor = (node) => (node.hasMesh ? '◆' : '▸');
  const clsFor = (node) => (node.hasMesh ? 'mesh' : 'group');

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderChildren(node, parentEl) {
    const wrap = document.createElement('div');
    wrap.className = 'node-children';

    const kids = node.children;
    const shown = kids.slice(0, MAX_CHILDREN_RENDER);

    for (const child of shown) wrap.appendChild(renderNode(child));

    if (kids.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'node';
      more.style.paddingLeft = `${(node.depth + 1) * 13 + 19}px`;
      more.innerHTML = `<span class="node-name" style="color:#98a2b3">还有 ${kids.length - shown.length} 个节点… 用上方搜索定位</span>`;
      wrap.appendChild(more);
    }

    parentEl.appendChild(wrap);
    return wrap;
  }

  function renderNode(node) {
    const row = document.createElement('div');
    row.className = 'node';
    row.style.paddingLeft = `${node.depth * 13 + 2}px`;
    row.title = node.name;

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

    if (node.children.length > 0) {
      const meta = document.createElement('span');
      meta.className = 'node-meta';
      meta.textContent = String(node.children.length);
      row.appendChild(meta);
    }

    let childWrap = null;
    const expand = (open) => {
      if (!hasKids) return;
      if (!childWrap) childWrap = renderChildren(node, row);
      childWrap.classList.toggle('open', open);
      caret.classList.toggle('open', open);
    };

    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      expand(!caret.classList.contains('open'));
    });

    row.addEventListener('click', () => {
      select(node, row);
      // 点一下就展开，符合直觉
      if (hasKids && !caret.classList.contains('open')) expand(true);
    });

    row.addEventListener('dblclick', () => expand(!caret.classList.contains('open')));

    elByObj.set(node.obj, row);
    row.__node = node;
    return row;
  }

  function select(node, row) {
    if (selectedEl) selectedEl.classList.remove('selected');
    selectedEl = row;
    selectedObj = node.obj;
    row.classList.add('selected');
    onSelect?.(node);
  }

  function setModel(sceneRoot, objectToRecs) {
    container.innerHTML = '';
    elByObj.clear();
    selectedEl = null;
    selectedObj = null;

    if (!sceneRoot) {
      container.innerHTML = '<div class="tree-empty">没有可显示的层级</div>';
      return { total: 0 };
    }

    root = buildNode(sceneRoot, 0, objectToRecs || new Map());

    // 根节点本身也当作一行显示，避免"根看不见"
    const rootRow = renderNode(root);
    container.appendChild(rootRow);
    if (root.children.length) {
      const wrap = renderChildren(root, rootRow);
      wrap.classList.add('open');
      rootRow.querySelector('.node-caret')?.classList.add('open');
    }

    return { total: countAll(root) };
  }

  /** 从外部（3D 点选）反向定位到树节点：展开祖先并滚动到可见 */
  function reveal(obj) {
    if (!obj) return;
    let el = elByObj.get(obj);
    if (!el) {
      // 命中的是 mesh，但树上挂的是它的父级分组 → 往上找
      let p = obj.parent;
      while (p && !el) {
        el = elByObj.get(p);
        p = p.parent;
      }
    }
    if (!el) return;

    // 展开所有祖先
    let cur = el.parentElement;
    while (cur && cur !== container) {
      if (cur.classList?.contains('node-children')) {
        cur.classList.add('open');
        const row = cur.previousElementSibling;
        row?.querySelector('.node-caret')?.classList.add('open');
      }
      cur = cur.parentElement;
    }

    if (selectedEl) selectedEl.classList.remove('selected');
    el.classList.add('selected');
    selectedEl = el;
    selectedObj = obj;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /** 搜索：扁平列出命中项，点击直接选中 */
  function search(q) {
    const kw = q.trim().toLowerCase();
    if (!kw) return null;
    if (!root) return [];

    const hits = [];
    const walk = (node) => {
      if (node.name.toLowerCase().includes(kw)) hits.push(node);
      for (const c of node.children) walk(c);
      if (hits.length > 500) return; // 上限，避免把 DOM 撑爆
    };
    walk(root);

    container.innerHTML = '';
    elByObj.clear();

    if (!hits.length) {
      container.innerHTML = `<div class="tree-empty">没有名称包含「${esc(q)}」的节点</div>`;
      return hits;
    }

    for (const node of hits.slice(0, 500)) {
      const row = document.createElement('div');
      row.className = 'node';
      row.style.paddingLeft = '2px';
      row.title = node.name;
      row.innerHTML =
        `<span class="node-caret leaf"></span>` +
        `<span class="node-icon ${clsFor(node)}">${iconFor(node)}</span>` +
        `<span class="node-name">${esc(node.name)}</span>` +
        (node.hasMesh ? `<span class="node-meta">mesh</span>` : '');
      row.addEventListener('click', () => select(node, row));
      elByObj.set(node.obj, row);
      container.appendChild(row);
    }
    return hits;
  }

  return { setModel, reveal, search, get root() { return root; } };
}
