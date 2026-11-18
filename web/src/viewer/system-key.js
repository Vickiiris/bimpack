/**
 * system-key.js —— 系统分类键的提取（唯一归并依据）
 *
 * 从模型属性里得到一个「系统缩写」：
 *   1. 有 `系统缩写` 字段就直接用（最可靠）
 *   2. 没有才解析 `系统名称`（"EAD 5" → "EAD"）
 *   3. 两者都没有时，退一步看**构件名**是否符合「系统名_设备名+编号」
 *      （手工添加的非 BIM 模型只有名字，见 systemKeyOf）
 * 前两种路径都**不让编号参与判定**：缩写定类别，缩写后面的数字只是实例序号。
 *
 * 这个模块被 tree.js（分组）与 discipline.js（专业判定）共用，
 * 单独拆出来是为了避免两个模块互相 import 成环。
 */

import { manualSystemName } from './manual-name.js';

export const cleanText = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();

/**
 * 「归不出来」时使用的分类名。
 * 业务口径：这一类叫「其他分类」，不再叫「未分类」——
 * 里面既有属性缺失的构件，也有按命名规则没匹配上的手工模型，
 * 叫「其他」比「未分类」更贴近它在树里的作用（兜底桶，而不是错误状态）。
 */
export const UNKNOWN_LABEL = '其他分类';

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

/**
 * 系统分类键（含手工命名兜底）。
 *
 * 属性里有系统信息就以属性为准；属性完全没有时，才用构件名里的「系统名」。
 * 手工模型（无 extras）在树上的「系统」层因此也能显示出「智能照明」这样的中文系统名，
 * 而不是掉进「其他分类」。
 *
 * @param {object} props 构件属性（可能是空对象）
 * @param {string} [name] 构件名（"智能照明_筒灯001"）
 */
export function systemKeyOf(props, name = '') {
  const key = systemKey(props);
  if (key !== UNKNOWN_LABEL) return key;
  const fromName = manualSystemName(name);
  return fromName || UNKNOWN_LABEL;
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
 *   5. 统一大写、去空白；不以字母开头时剔除结尾编号段；空值/纯数字 → 「其他分类」
 */
export function systemAbbr(raw) {
  const s = cleanText(raw);
  if (!s) return UNKNOWN_LABEL;

  // 1) 多系统值只取第一个系统
  const head = s.split(/[,，;；/、|+]/)[0].trim();
  if (!head) return UNKNOWN_LABEL;

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

  if (!stripped) return UNKNOWN_LABEL;
  // 5) 纯数字/纯符号没有分类意义
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(stripped)) return UNKNOWN_LABEL;
  return stripped.toUpperCase();
}
