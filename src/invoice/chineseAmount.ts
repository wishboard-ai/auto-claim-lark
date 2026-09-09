/**
 * 中文大写金额解析（如「壹万贰仟叁佰肆拾伍元陆角柒分」→ 12345.67）。
 *
 * 用途：增值税发票票面**只有价税合计有大写金额**（「价税合计（大写）」），
 * 而阿拉伯数字同时存在「金额(不含税)」「税额」「价税合计(小写)」三个数，模型/OCR 容易取错列。
 * 大写金额语义唯一且字形差异大（壹/贰/叁… 不像 3/8、0/6 那样易混），因此可作为
 * 「价税合计」的高可信锚点，用于校正数字识别结果。
 */

/** 大写/小写数字字符 → 数值 */
const DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 洞: 0,
  一: 1, 壹: 1, 幺: 1,
  二: 2, 贰: 2, 貳: 2, 弐: 2, 两: 2, 兩: 2,
  三: 3, 叁: 3, 參: 3, 参: 3, 叄: 3,
  四: 4, 肆: 4,
  五: 5, 伍: 5,
  六: 6, 陆: 6, 陸: 6,
  七: 7, 柒: 7,
  八: 8, 捌: 8,
  九: 9, 玖: 9,
};

/** 节内单位 */
const UNITS: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };

/** 「元」及其异体（整数与小数的分界） */
const YUAN_CHARS = '元圆圓';

/** 可忽略的装饰字符（标签、货币符号、空白等） */
const IGNORABLE = /[\s(){}[\]（）【】：:¥￥,，。.、大写金额价税合计人民币]/g;

/** 解析整数部分（支持 万/萬/亿/億 分节） */
function parseIntegerSection(s: string): number | undefined {
  if (!s) return 0;
  let total = 0;
  let section = 0;
  let num = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in DIGITS) {
      num = DIGITS[ch];
      seen = true;
      continue;
    }
    if (ch in UNITS) {
      section += (num === 0 ? 1 : num) * UNITS[ch];
      num = 0;
      seen = true;
      continue;
    }
    if (ch === '万' || ch === '萬') {
      total += (section + num) * 10000;
      section = 0;
      num = 0;
      seen = true;
      continue;
    }
    if (ch === '亿' || ch === '億') {
      total = (total + section + num) * 100000000;
      section = 0;
      num = 0;
      seen = true;
      continue;
    }
    // 出现不认识的字符：整体判为不可靠，放弃解析（宁缺勿错）
    return undefined;
  }
  if (!seen) return undefined;
  return total + section + num;
}

/**
 * 解析中文大写金额字符串为数值（元）。无法可靠解析时返回 undefined。
 * 兼容：
 * - 「贰佰元整」/「贰佰圆整」/「贰佰元正」
 * - 「壹仟零伍元贰角」「拾元零伍分」
 * - 带标签或货币符号的整串，如 「价税合计（大写）壹佰元整」
 * - 罕见的「元」缺失但有角/分的写法
 */
export function parseChineseAmount(input?: unknown): number | undefined {
  if (input == null) return undefined;
  let s = String(input).replace(IGNORABLE, '');
  if (!s) return undefined;
  // 结尾的「整/正」表示 .00，去掉后不影响解析
  s = s.replace(/[整正]+$/u, '');
  if (!s) return undefined;

  // 必须至少含一个大写数字字符，避免把「12345.67」这类阿拉伯数字串误当大写解析
  if (!/[零〇壹贰貳弐叁參参叄肆伍陆陸柒捌玖一二三四五六七八九十拾百佰千仟万萬亿億]/u.test(s)) {
    return undefined;
  }

  const yuanIdx = [...s].findIndex((c) => YUAN_CHARS.includes(c));
  const intPart = yuanIdx >= 0 ? s.slice(0, yuanIdx) : s.replace(/[角分毫厘].*$/u, '');
  const fracPart = yuanIdx >= 0 ? s.slice(yuanIdx + 1) : s.slice(intPart.length);

  const intValue = parseIntegerSection(intPart);
  if (intValue == null) return undefined;

  // 小数部分：X角Y分（角/分前的数字），可含「零」占位；出现其它字符则判为不可靠
  let jiao = 0;
  let fen = 0;
  let pending: number | undefined;
  for (const ch of fracPart) {
    if (ch in DIGITS) {
      pending = DIGITS[ch];
      continue;
    }
    if (ch === '角') {
      jiao = pending ?? 0;
      pending = undefined;
      continue;
    }
    if (ch === '分') {
      fen = pending ?? 0;
      pending = undefined;
      continue;
    }
    if (ch === '毫' || ch === '厘') {
      pending = undefined; // 忽略更小的单位
      continue;
    }
    return undefined;
  }
  if (pending != null) return undefined; // 有数字却没有单位，写法异常

  const value = intValue + jiao / 10 + fen / 100;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100) / 100;
}
