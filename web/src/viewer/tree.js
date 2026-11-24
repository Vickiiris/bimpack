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
import { equipmentKind, isKindLabel, kindRank, NON_EQUIP, OTHER_EQUIP, NON_MEP, SMART_KIND } from './equipment.js';
import { UNKNOWN_LABEL, cleanText as clean, systemAbbr, systemKey, systemKeyOf, stripAbbrPrefix } from './system-key.js';

// 兼容既有引用（测试与其它模块一直从 tree.js 取这几个函数）
export { systemAbbr, systemKey, stripAbbrPrefix };

const MAX_CHILDREN_RENDER = 800;

/**
 * 叶子 → 系统分类键。
 *
 * 属性里有系统信息就照用；属性没有（手工添加的非 BIM 模型）时取名字里的系统名。
 * 但**系统名认不出专业时不建系统分组** —— 否则「其他分类 > 构件甲」会让人误以为
 * 「构件甲」是个正经系统，而它其实只是一段没被识别的名字。
 */
function sysKeyOfLeaf(props, name) {
  const key = systemKeyOf(props, name);
  if (key === UNKNOWN_LABEL) return key;
  const fromProps = systemKey(props) !== UNKNOWN_LABEL;
  if (!fromProps && disciplineCode(props, { name }) === 'NONE') return UNKNOWN_LABEL;
  return key;
}

/**
 * 两级视图第 1 层的「智能化」一级。
 *
 * 名称里带「智能 / 智慧 / 智控 / 智联」的设备横跨电气、安防两个专业（智能照明、智慧安防、
 * 智能配电箱…），散在各专业下要翻好几处才数得清。所以像管综一样单独成一级，
 * 把它们收在一处；第二层仍按系统名分组（智能照明 / 智慧安防），与主干视图的系统层同名。
 */
export const SMART_GROUP = '智能化';

/**
 * 专业的业务排列（暖通 → 给排水 → 消防 → 电气 → 安防 → 燃气 → 建筑 → 结构 → 其他），
 * 之后是「智能化」（850）与「管综」（900）。只在「专业›设备分类」这一档用：
 * 那一档专业是第一层，按拼音排（电气 / 给排水 / 建筑…）不符合现场翻图习惯。
 * 其余档位的专业层仍按名称排。
 */
const DISC_RANK = new Map([
  ...Object.values(DISCIPLINES).map((d) => [d.name, d.order]),
  [SMART_GROUP, 850],
  [NON_EQUIP, 900],
]);

/**
 * 两级视图的第 1 层：**智能化 / 管综各自单独成一级**，其余照专业走。
 *
 * · 管综（管道 / 风管 / 桥架 / 支吊架）不是专业，而是构件形态；一栋楼里它常占八成构件量，
 *   挂在「暖通空调」「消防」下面会把真正的设备埋掉。所以整体拎出来单独成一级、排在最后，
 *   展开后按 Revit 类别看（风管 / 管道 / 电缆桥架）。
 * · 智能化（名称带 智能 / 智慧 / 智控 的设备）横跨电气、安防，单独成一级、排在管综之前，
 *   展开后按系统名看（智能照明 / 智慧安防）。
 *
 * 顺序：专业（暖通 → … → 建筑 → 结构）→ 智能化 → 管综。
 */
function discOrPipe(props, leaf) {
  const kind = kindOf(props, leaf);
  if (kind === NON_EQUIP) return NON_EQUIP;
  if (kind === SMART_KIND) return SMART_GROUP;
  return disciplineName(disciplineCode(props, { name: leaf?.name }));
}

/**
 * 设备类型只算一次。系统层与设备层都要用它，而 12k 构件下 equipmentKind 不便宜
 * （里面还要跑一遍 disciplineCode），结果挂在叶子上复用。
 */
function kindOf(props, leaf) {
  if (!leaf) return equipmentKind(props);
  if (leaf.__kind === undefined) leaf.__kind = equipmentKind(props, leaf.name);
  return leaf.__kind;
}

/**
 * 「设备分类」这一层：设备分支看设备分类，管综 / 建筑结构分支看 Revit 类别。
 * 管综那支本来就全是管综，再按设备分类分只剩一个节点，
 * 换成 Revit 类别（风管 / 管道 / 电缆桥架 / 支吊架 / 墙）才有得筛。
 */
function equipOrCategory(props, leaf) {
  const kind = kindOf(props, leaf);
  if (kind === NON_EQUIP || kind === NON_MEP) {
    return clean(props['Category Name']) || clean(props['类别']) || UNKNOWN_LABEL;
  }
  return kind;
}

/**
 * 两级视图的第 2 层：设备分类，但**「智能化设备」按系统名显示**。
 *
 * 「智能化设备」是个很宽的池子：一栋楼里 100 多件可能全是智能照明筒灯，也可能是智慧安防摄像头。
 * 笼统堆成一个「智能化设备」节点，既看不出是哪套系统，也跟主干视图（专业 → 系统 → 类别 → 类型）
 * 里的叫法对不上 —— 那边显示的是「智能照明」「智慧安防」。
 *
 * 所以这一档沿用**同一个系统键**（`sysKeyOfLeaf`：属性里的系统缩写优先，手工模型取
 * 「系统名_设备名+编号」里的系统名）当标签，名称与主干视图的系统层完全一致；
 * 认不出系统名时才退回「智能化设备」。
 */
/** 智能化设备认不出系统名时的兜底标签（挂在「智能化」一级下，不再叫「智能化设备」免得父子同名） */
const NO_SYSTEM_LABEL = '未分系统';

function equipOrSystem(props, leaf) {
  const kind = kindOf(props, leaf);
  if (kind === SMART_KIND) {
    const sys = sysKeyOfLeaf(props, leaf?.name);
    return sys === UNKNOWN_LABEL ? NO_SYSTEM_LABEL : sys;
  }
  return equipOrCategory(props, leaf);
}

/**
 * 分组方式（只要五种，别再把「加一层/少一层」的变体都摆出来）。
 *
 * 主干只有一套（unified）：专业 → 系统 → 类别 → 类型；另有省掉中间层的
 * 「专业›设备分类」两级视图。其余几档是同一批构件的**换轴视图**，不是并行的第二棵树 ——
 * 构件不会在多棵树里重复出现，计数永远一致。
 *
 * 刻意下架的变体（原先下拉里有，纯属同义反复）：
 *   · 专业→系统→类别→族→类型  —— 族与类型语义重叠，族不进主干（属性面板里能看到）
 *   · 系统→类别→类型          —— 「系统→类别」展开就是类型，少一层不影响找构件
 *   · 族→类型                 —— 与「类别→类型」近似，族是类别的细分
 *   · 标高→类别               —— 楼层是空间维度，与系统轴正交，立管跨 31 层无法两全
 */
export const GROUP_MODES = {
  unified: {
    label: '专业›系统›类别›类型',
    hint: '规范层级：专业 → 系统 → 类别 → 类型 → 构件（默认）',
    fields: [
      { key: '专业', map: (raw, props, leaf) => disciplineName(disciplineCode(props, { name: leaf?.name })), code: (props, name) => disciplineCode(props, { name }), bulk: (leaves) => classifyLeaves(leaves), label: '专业' },
      // 系统键：属性优先；手工模型（无属性）用名字里的「系统名」兜底，见 systemKeyOf
      { key: '系统名称', map: (raw, props, leaf) => sysKeyOfLeaf(props, leaf?.name), label: '系统', optional: true },
      { key: 'Category Name', optional: true },
      { key: 'Type Name', optional: true },
    ],
  },
  /**
   * 两级视图：**（专业 + 智能化 + 管综）› 设备分类**。
   *
   * 只回答两个问题：「这是哪个专业的」「这专业里有哪些设备」。不分系统，也不分
   * Revit 类别 —— 第二层直接是设备分类（风机 / 风机盘管 / 水泵 / 配电柜…），
   * 所以「暖通空调」底下就是它那一批设备，一眼能数出各有多少件。
   *
   * **「智能化」与「管综」各自单独成一级、排在各专业之后**（见 discOrPipe）：
   * · 智能化 —— 名称带「智能 / 智慧 / 智控」的设备，横跨电气与安防，收在一处才数得清；
   *   第二层按系统名分组（智能照明 / 智慧安防），与主干视图的系统层同名；
   * · 管综 —— 管道 / 风管 / 桥架不是设备，留在专业里会把设备埋掉；
   *   第二层给 Revit 类别（风管 / 管道 / 电缆桥架）。
   * 建筑 / 结构同理走类别（墙 / 门 / 窗），因为它们的设备分类只有一个「建筑结构」。
   *
   * 与另外几档的关系：叶子完全同一批（`objectToRecs` 里的构件），只是把
   * 「系统」「类别」「类型」三层砍掉，只留 专业（discipline.js）+ 设备分类
   * （equipment.js 的 equipmentKind）；不重新归类，构件总数与其它档一致。
   */
  discEquip: {
    label: '专业›设备分类',
    hint: '两级视图：专业 → 设备分类（风机 / 风机盘管 / 水泵 / 配电柜…）；智能化与管综各自单独成一级',
    fields: [
      {
        key: '专业',
        // 管综（管道 / 风管 / 桥架 / 支吊架）一律拎到单独一级
        map: (raw, props, leaf) => discOrPipe(props, leaf),
        // 专业层是「整批上下文」算出来的（同类别多数兜底），bulk 的结果在这里再纠一次：
        // 管综、智能化这两个一级归类不跟专业走
        fix: (label, props, leaf) => {
          const kind = kindOf(props, leaf);
          if (kind === NON_EQUIP) return NON_EQUIP;
          if (kind === SMART_KIND) return SMART_GROUP;
          return label;
        },
        code: (props, name) => disciplineCode(props, { name }),
        bulk: (leaves) => classifyLeaves(leaves),
        rank: (label) => DISC_RANK.get(label) ?? 500,
        label: '专业',
      },
      {
        key: '设备分类',
        // 设备给设备分类；智能化设备按系统名显示（智能照明 / 智慧安防）；
        // 管综 / 建筑结构这两支给 Revit 类别（风管 / 管道 / 墙）
        map: (raw, props, leaf) => equipOrSystem(props, leaf),
        rank: (label) => (isKindLabel(label) ? kindRank(label) : 500),
        label: '设备分类',
      },
    ],
  },
  system: {
    label: '系统›类别',
    hint: '换轴看系统：英文缩写定类别，编号不参与',
    fields: [
      { key: '系统名称', map: (raw, props) => systemKey(props || { 系统名称: raw }), label: '系统' },
      { key: 'Category Name' },
    ],
  },
  category: {
    label: '类别›类型',
    hint: '换轴看构件：Revit 类别 → 类型，与专业无关',
    fields: [{ key: 'Category Name' }, { key: 'Type Name' }],
  },
  raw: {
    label: '原始结构',
    hint: '照文件里的节点层级原样铺开（平铺模型会退化成一条长列表）',
    fields: null,
  },
};

function cmpName(a, b) {
  // 「其他分类」永远排最后，别挡住有类别的构件
  const ua = a.name === UNKNOWN_LABEL;
  const ub = b.name === UNKNOWN_LABEL;
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
  //       一层全是「其他分类」的假层级；整份模型同属一个专业时同理
  //   (b) 后面建立树时不用重复调 map（map 可能读多个字段，不便宜）
  const labelOf = (leaf, f) => {
    const key = typeof f === 'string' ? f : f.key;
    const rawVal = clean(leaf.props[key]);
    // 分类键：有 map 就用归一化结果（如系统缩写），否则用原值
    const label = (typeof f === 'string' || !f.map ? rawVal : clean(f.map(rawVal, leaf.props, leaf))) || UNKNOWN_LABEL;
    return { key, rawVal, label };
  };
  // 需要「整批上下文」的层（如专业：要参考同类别其它构件）先算一遍
  const bulkVals = fields.map((f) => (typeof f !== 'string' && f.bulk ? f.bulk(leaves) : null));
  const grid = leaves.map((leaf) => fields.map((f, i) => {
    const bv = bulkVals[i]?.get(leaf);
    const cell = bv
      ? { key: typeof f === 'string' ? f : f.key, rawVal: '', label: bv.label, code: bv.code, from: bv.from, detail: bv.detail }
      : labelOf(leaf, f);
    // fix：整批算出来的层也要能被单项规则改写（专业层里「管综」不该跟专业走）
    if (typeof f !== 'string' && f.fix) {
      const fixed = clean(f.fix(cell.label, leaf.props, leaf));
      if (fixed && fixed !== cell.label) return { ...cell, label: fixed };
    }
    return cell;
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
      const { key, rawVal, label, code: bulkCode, from: bulkFrom, detail: bulkDetail } = grid[li][i];

      // 可选层（系统 / 族 / 手工模型缺的类别与类型）没有值时，不给这个构件凭空造一层
      // 「其他分类」—— 建筑构件本来就不属于任何机电系统，手工模型也没有 Category，
      // 直接挂到上一级更符合实际。
      // 深度按实际走过的层数算，所以这种构件的叶子会比同层其它构件浅一级。
      if (typeof f !== 'string' && f.optional && label === UNKNOWN_LABEL) continue;

      let m = maps.get(parent);
      if (!m) { m = new Map(); maps.set(parent, m); }
      let g = m.get(label);
      if (!g) {
        g = {
          obj: null, name: label, depth: depth + 1, children: [],
          recs: null, hasMesh: false, isGroup: true, count: 0,
          field: key, fieldLabel: (typeof f === 'string' ? key : f.label) || key,
          // 该层的业务排序权重（设备类型用：机房设备在前、「管综」等兜底桶在后）
          rank: (typeof f !== 'string' && f.rank ? f.rank(label) : null),
          raws: new Set(),   // 归到这个分类键下的原始取值（悬浮提示里给用户看）
          mapped: !!(typeof f !== 'string' && f.map), // 分类键是归一化出来的（如系统缩写）
          typeFreq: new Map(),  // 该组下各「类型」出现次数（给中文系统名兜底用）
          sysTypeFreq: new Map(), // 「系统类型」取值次数（如 "EAD-排风管"）
          sysCatFreq: new Map(),  // 「系统分类」取值次数（如 "排风"）
        };
        m.set(label, g);
        parent.children.push(g);
      }
      // 专业层记下代码与判定来源：行上色按 disc-XXX，悬浮提示要说明是怎么归进来的。
      // 「管综」「智能化」不是专业（是从各专业里拎出来的归类），不跟任何一个专业上色
      if (!g.discCode && label !== NON_EQUIP && label !== SMART_GROUP) {
        g.discCode = bulkCode || (typeof f !== 'string' && f.code ? f.code(leaf.props, leaf.name) : '');
        g.discFrom = bulkFrom || '';
        g.discDetail = bulkDetail || '';
      }
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

  // 组按名称排，组内构件已按名称排好。
  // 带 rank 的层（专业 / 设备类型）先按业务顺序：暖通 → 水 → 电 → 弱电 → 建筑 → 管综
  const cmpNode = (a, b) => {
    const ra = Number.isFinite(a.rank) ? a.rank : null;
    const rb = Number.isFinite(b.rank) ? b.rank : null;
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
    if (ra !== null && rb === null) return -1;
    if (ra === null && rb !== null) return 1;
    return cmpName(a, b);
  };
  const sortDeep = (n) => {
    if (n.children.length > 1) n.children.sort(cmpNode);
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

  /** 专业层悬浮说明：这一级是按哪条规则归出来的 */
  const DISC_FROM_TEXT = {
    field: '模型自带「专业」字段',
    fire: '消防优先（含消防词，按 GB 55037 单列）',
    semantic: '系统分类 / 系统类型 / 系统名称的语义',
    manual: '构件命名规则「系统名_设备名+编号」',
    bim: 'BIM 语义层（IFC 实体 / OmniClass 编码）',
    abbr: '系统缩写对照表',
    fallback: '类别 / 族 / 设备名兜底',
    category: '同类别多数推断',
    none: '没有可用依据',
  };

  /** 第 1 层「智能化」「管综」的悬浮提示：说清它为什么单独成一级、里面怎么展开 */
  function bucketTitleOf(node) {
    const lines = [`分类：${node.name}（从各专业里拎出来，单独成一级）`];
    if (node.name === SMART_GROUP) {
      lines.push('智能化：名称 / 类别 / 族 / 类型里带「智能 / 智慧 / 智控 / 智联」的设备');
      lines.push('（英文 smart / intelligent 按整词匹配）');
      lines.push('这些设备横跨电气与安防（智能照明 / 智慧安防 / 智能配电箱…），');
      lines.push('散在各专业下要翻好几处才数得清，所以收成一级，排在各专业之后、管综之前');
      lines.push('展开后按系统名分组（智能照明 / 智慧安防），与主干视图的系统层同名');
      lines.push('本体是管道 / 桥架 / 阀门的，带「智能」也仍归「管综」，不在这里');
    } else {
      lines.push('管综：管道 / 风管 / 桥架 / 阀门 / 风口 / 支吊架等「线」类构件');
      lines.push('它们不是设备，又常占全楼八成的构件量，混在各专业下会把设备埋掉');
      lines.push('展开后按 Revit 类别看（风管 / 管道 / 电缆桥架 / 支吊架…）');
    }
    lines.push(`本类构件数：${node.count}`);
    lines.push('取消左侧勾选即隐藏整类 —— 这就是按分类筛选');
    return lines.join('\n');
  }

  /**
   * 设备分类分组的悬浮提示（第 3 层 / 两级视图的第 2 层）：说明它是设备类型还是
   * Revit 类别、多少件、怎么当筛选用。
   * 设备类型名（配电柜 / 水泵…）与类别名（风管 / 管道 / 墙…）不会重名，据此分辨。
   */
  function kindTitleOf(node) {
    const isKind = isKindLabel(node.name);
    const parent = node.parent;
    // 管综、建筑 / 结构这两支的第 2 层是 Revit 类别；其余专业下不是设备分类名的，
    // 就是「智能化设备」按系统名分出来的组（智能照明 / 智慧安防）
    const isCat = !isKind && (parent?.name === NON_EQUIP || parent?.discCode === 'ARCH' || parent?.discCode === 'STR');
    const isSmartSys = parent?.name === SMART_GROUP;
    const head = isKind ? (node.fieldLabel || '设备类型') : (isCat ? '类别' : (isSmartSys ? '系统' : SMART_KIND));
    const lines = [`${head}：${node.name}`];
    if (node.name === OTHER_EQUIP) {
      lines.push('类别写着机械设备 / 专用设备 / 设备，但名称里认不出具体型号');
    } else if (node.name === SMART_KIND) {
      lines.push('名称里带「智能 / 智慧 / 智控 / 智联」的设备（手工模型与 BIM 模型同一口径）');
      lines.push('本体是管道 / 桥架 / 阀门这类的，仍归「管综」，不在这里');
      lines.push('只看构件自己的名字，不看系统名 —— 否则弱电整层都会涌进来');
    } else if (isSmartSys && node.name === NO_SYSTEM_LABEL) {
      lines.push('智能化设备里没有系统名的那些：属性没写系统，名字也不符合「系统名_设备名+编号」');
      lines.push('补上系统字段或按规则改名后，会自动回到对应系统组');
    } else if (!isKind && !isCat) {
      lines.push('名称里带「智能 / 智慧」的设备，按系统名分组（智能照明 / 智慧安防）');
      lines.push('与主干视图「专业 → 系统 → …」里的系统层同名，两边对得上');
      lines.push('这一组都是智能化设备；要看各自的类别与型号，切回主干视图');
    } else if (node.name === UNKNOWN_LABEL) {
      lines.push('没有 Revit 类别（手工添加的非 BIM 模型常见），只能按名称归到这一支');
    } else if (head === '类别') {
      lines.push('管综 / 建筑结构构件不是设备，按 Revit 类别看更有得筛');
    } else {
      lines.push('机房设备 / 末端设备（按名称、族、类型与 IFC 实体判定）');
    }
    lines.push(`本类构件数：${node.count}`);
    lines.push(`取消左侧勾选即隐藏整类 —— 这就是按「${head}」筛选`);
    return lines.join('\n');
  }

  function discTitleOf(node) {
    const lines = [`专业：${node.name}（一级归类）`];
    if (node.discCode === 'NONE') {
      lines.push(`进桶原因：${node.discDetail || '没有系统字段，名称也不符合「系统名_设备名+编号」'}`);
      lines.push('补上属性或按规则改名后会自动归位。');
    } else {
      const from = DISC_FROM_TEXT[node.discFrom] || '属性规则';
      lines.push(`归并依据：${from}${node.discDetail ? ` · ${node.discDetail}` : ''}`);
      lines.push('依次判：专业字段 → 消防优先 → 系统语义 → BIM 语义 → 系统缩写 → 类别/族');
    }
    lines.push(`本专业构件数：${node.count}`);
    return lines.join('\n');
  }

  function renderNode(node) {
    // 每个节点外面套一个块级 item：子节点容器必须挂在 item 上而不是行上，
    // 否则会被 .node{display:flex;height:24px} 当成一个 flex 子项夹在行里、还裁掉高度
    const item = document.createElement('div');
    item.className = 'node-item';

    const row = document.createElement('div');
    // 「智能化」「管综」不是专业（没有 discCode），但它们是第 1 层的分类，得跟专业一样带个头点、
    // 文字才好对齐（否则名字会顶到专业色点的位置上，比上面几行左一点）
    const isBucket = node.depth === 1 && (node.name === NON_EQUIP || node.name === SMART_GROUP);
    const bucketCls = node.name === SMART_GROUP ? 'disc-smart' : 'disc-bucket';
    row.className = 'node' + (node.isGroup ? ' is-group' : '')
      + (node.discCode ? ` disc disc-${node.discCode}` : (isBucket ? ` disc ${bucketCls}` : ''));
    row.style.paddingLeft = `${node.depth * 13 + 2}px`;
    // 分组节点：把归一化前的一串原始取值列在悬浮提示里（如 CN 5 / CN 7 / CN 15 → CN）
    if (isBucket) {
      // 第 1 层的「管综」：说清它为什么单独成一级、里面怎么展开
      row.title = bucketTitleOf(node);
    } else if (node.field === '设备类型' || node.field === '设备分类') {
      // 第 3 层：设备类型（设备）或 Revit 类别（管综 / 建筑结构），顺带说怎么拿它筛选
      row.title = kindTitleOf(node);
    } else if (node.discCode) {
      // 专业层：说明这一级是怎么归出来的（命名规则 / 同类别多数 / 消防优先…）
      row.title = discTitleOf(node);
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
