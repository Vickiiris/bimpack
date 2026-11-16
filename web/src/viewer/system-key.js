/**
 * system-key.js —— 系统分类键的提取（唯一归并依据）
 *
 * 从模型属性里得到一个「系统缩写」：
 *   1. 有 `系统缩写` 字段就直接用（最可靠）
 *   2. 没有才解析 `系统名称`（"EAD 5" → "EAD"）
 * 两种路径都**不让编号参与判定**：缩写定类别，缩写后面的数字只是实例序号。
 *
 * 这个模块被 tree.js（分组）与 discipline.js（专业判定）共用，
 * 单独拆出来是为了避免两个模块互相 import 成环。
 */

export const cleanText = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();

/** 分类键：优先模型自带 `系统缩写`，否则解析 `系统名称` */
export function systemKey(props) {
  const p = props || {};
  const explicit = cleanText(p['系统缩写']);
  if (explicit) {
    // 自带缩写也可能带编号/多余符号："EAD-5" → EAD
    const t = explicit.replace(/[\s._-]*[A-Za-z]*\d[A-Za-z0-9]*\s*$/g, '').replace(/[\s._-]+$/g, '').trim();
    if (t) return t.toUpperCase();
  }
  return systemAbbr(p['系统名称']);
}

/** 把 "EAD-排风管" 里的缩写前缀去掉，只留中文系统名 → "排风管" */
export function stripAbbrPrefix(value, abbr) {
  let s = cleanText(value);
  if (!s) return '';
  const a = cleanText(abbr);
  if (a) {
    const re = new RegExp(`^${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-—_:：/|·]?\\s*`, 'i');
    s = s.replace(re, '');
  }
  return s.trim();
}

/**
 * 系统名称 → 系统缩写
 *
 * 规则（业务口径：**缩写定类别，编号不参与归属**）：
 *   1. 只取「第一个系统条目」：多系统值按 , ， ; ； / 、 | + 切开，取首段
 *      —— "CR 30,CR 18" 归 CR，不会另立一个 "CR 30,CR 18" 类别
 *   2. 去掉括号注释："CN 5(备用)" → "CN 5"
 *   3. 取开头的字母段（字母之间允许 - _ . 连接），遇数字/空白/中文即止
 *      —— "CN5" "CN 5" "CN-5" "CHW-A 12" 都只取缩写
 *   4. 保留缩写里的字母后缀："CHW-A" 仍是 "CHW-A"（字母不是编号，有区分意义）
 *   5. 统一大写、去空白；不以字母开头时剔除结尾编号段；空值/纯数字 → 「(未分类)」
 */
export function systemAbbr(raw) {
  const s = cleanText(raw);
  if (!s) return '(未分类)';

  // 1) 多系统值只取第一个系统
  const head = s.split(/[,，;；/、|+]/)[0].trim();
  if (!head) return '(未分类)';

  // 2) 去掉括号注释："CN 5(备用)" → "CN 5"
  const noNote = head.replace(/[（(][^）)]*[）)]/g, ' ').trim();

  // 3) 首选：开头的字母段
  const m = noNote.match(/^[A-Za-z]+(?:[-_.][A-Za-z]+)*/);
  if (m) return m[0].toUpperCase();

  // 4) 不以字母开头（如「生活给水 JL 3」）：剔除结尾的编号段，保留其余
  const stripped = noNote
    .replace(/[\s._-]*[A-Za-z]*\d[A-Za-z0-9]*\s*$/, '')
    .replace(/[\s._-]+$/g, '')
    .trim();

  if (!stripped) return '(未分类)';
  // 5) 纯数字/纯符号没有分类意义
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(stripped)) return '(未分类)';
  return stripped.toUpperCase();
}
