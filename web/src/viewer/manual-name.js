/**
 * manual-name.js —— 「系统名_设备名+编号」手工命名规则的解析
 *
 * 背景：用户手工往场景里补的非 BIM 模型（筒灯、喷淋头、摄像头之类）没有 extras，
 * 也没有「系统名称 / 系统分类」字段，属性判定必然落到「其他分类」。这类模型唯一
 * 可用的线索就是**名字**，于是约定一条命名规则：
 *
 *     系统名 _ 设备名 + 编号
 *     例：智能照明_筒灯001 / 消防_喷淋头012 / 给排水_地漏03
 *
 * 解析只做**字符串层面的拆解**，不判断专业（专业由 discipline.js 用关键词表决定）——
 * 这样这个模块可以脱离词表单独测试，也不会和 discipline.js 循环依赖。
 *
 * 格式约定：
 *   1. 分隔符：半角 `_`，兼容全角 `＿` / `﹍`；连续多个下划线当作一个分隔符
 *   2. 系统名：分隔符之前的部分。尾部编号不算系统名（"智能照明1" → "智能照明"）
 *   3. 设备名：分隔符之后、去掉尾部编号的部分。允许内部再有下划线
 *   4. 编号：末尾 1~6 位数字，允许前置 `#` 或 `-`/`~`/空格/下划线（"筒灯#001"）
 *
 * 判定为「格式不规则」的情形（返回 ok:false，交给上层留在「其他分类」）：
 *   - 名称为空
 *   - 没有分隔符（"筒灯001"）
 *   - 分隔符前为空（"_筒灯001"）
 *   - 系统名只有编号或单个字母（"123_筒灯001"、"A_筒灯001"）—— 定不了系统
 *   - 分隔符后为空（"智能照明_"）
 *   - 设备名只有编号（"智能照明_001"）
 * 缺编号不算格式错误（"智能照明_筒灯" 仍可归类），只是 serial 为空。
 */

const CN_CHAR = /[\u4e00-\u9fa5]/;
const ASCII_WORD = /[A-Za-z]{2,}/;

/** 全角分隔符 / 全角空格归一，压缩连续空白 */
export function normalizeName(raw) {
  return String(raw ?? '')
    .replace(/[＿﹍]/g, '_')
    .replace(/[\u3000\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 失败原因 → 给人看的一句话（树提示 / 体检报告里直接用） */
export const MANUAL_REASONS = {
  empty: '名称为空',
  'no-sep': '没有「_」分隔符',
  'no-system': '分隔符前没有系统名',
  'bad-system': '系统名只有编号或单字母',
  'no-device': '分隔符后没有设备名',
  'bad-device': '设备名只有编号',
};

const fail = (raw, reason) => ({
  ok: false, system: '', systemNo: '', device: '', serial: '', raw, reason,
});

/**
 * 解析一个构件名。
 * @returns {{ok:boolean, system:string, systemNo:string, device:string, serial:string, raw:string, reason:string}}
 */
export function parseManualName(raw) {
  const src = normalizeName(raw);
  if (!src) return fail(src, 'empty');

  const at = src.indexOf('_');
  if (at < 0) return fail(src, 'no-sep');

  const head = src.slice(0, at).trim();
  // 连续下划线视为一个分隔符；设备名内部的下划线保留
  const tail = src.slice(at + 1).replace(/^_+/, '').trim();
  if (!head) return fail(src, 'no-system');
  if (!tail) return fail(src, 'no-device');

  // 系统名尾部编号："智能照明1" → 系统名「智能照明」+ 编号 1
  const headNo = head.match(/[\s-]*(\d{1,4})$/);
  const systemNo = headNo ? headNo[1] : '';
  const system = (headNo ? head.slice(0, headNo.index) : head)
    .replace(/[\s\-–—_]+$/, '')
    .trim();
  if (!system) return fail(src, 'bad-system');
  if (!CN_CHAR.test(system) && !ASCII_WORD.test(system)) return fail(src, 'bad-system');

  // 设备名尾部编号：允许 "筒灯001" / "筒灯 001" / "筒灯-001" / "筒灯#001"
  const devNo = tail.match(/[\s\-~_]*#?(\d{1,6})$/);
  const serial = devNo ? devNo[1] : '';
  const device = (devNo ? tail.slice(0, devNo.index) : tail)
    .replace(/[\s\-–—_#]+$/, '')
    .trim();
  if (!device) return fail(src, 'no-device');
  if (!CN_CHAR.test(device) && !ASCII_WORD.test(device)) return fail(src, 'bad-device');

  return { ok: true, system, systemNo, device, serial, raw: src, reason: '' };
}

/** 只要系统名（不是规则格式就返回空串） */
export function manualSystemName(raw) {
  const r = parseManualName(raw);
  return r.ok ? r.system : '';
}
