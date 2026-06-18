/**
 * 对话语言检测（ADR-0055 多语种）——确定性、零-LLM。
 *
 * 数字人格要服务不同语言的用户（伴侣/助手）。运行时按**用户当前这句话**的语言确定性地选择
 * 身份识别模式与回复模板——「what's your name」用英文回，「你叫什么」用中文回。
 *
 * 判定规则（保守、确定性）：统计 CJK 表意文字占「字母/表意字符」的比例（忽略空白/标点/数字）：
 *   - CJK 占比 ≥ CJK_THRESHOLD → 'zh-CN'；
 *   - 否则 → 'en'（拉丁/其他先归英文，后续可加更多语言检测规则）；
 *   - 无可判定字符（纯标点/数字/空）→ 回退 fallback（默认 'en'）。
 *
 * 仅区分 zh-CN / en（与 i18n SUPPORTED_LOCALES 对齐）。加新语言时在此扩展检测 + companion-locale 加资源。
 */

import type { SupportedLocale } from '../i18n/locale-resolver.js';

/** CJK 占比达此阈值即判中文（混合句里只要有相当比例汉字就按中文回应，符合中文用户直觉——
 * 如「怎么做 flat white」含英文术语但整体是中文提问，应判中文）。阈值偏低，因夹用英文专名/
 * 术语在中文里很常见，而英文句几乎不含汉字（误判风险不对称，偏向「有汉字即中文」）。 */
const CJK_THRESHOLD = 0.2;

/** 是否 CJK 统一表意文字（基本区 + 扩展 A + 兼容）。 */
function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||   // CJK 统一表意文字
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||   // 扩展 A
    (codePoint >= 0xf900 && codePoint <= 0xfaff)       // 兼容表意文字
  );
}

/** 是否拉丁字母（含重音扩展），用于「有效字符」计数的分母。 */
function isLatin(codePoint: number): boolean {
  return (
    (codePoint >= 0x41 && codePoint <= 0x5a) ||        // A-Z
    (codePoint >= 0x61 && codePoint <= 0x7a) ||        // a-z
    (codePoint >= 0xc0 && codePoint <= 0x24f)           // 拉丁扩展（重音等）
  );
}

/**
 * 检测一段文本的对话语言（确定性）。
 * @param text 用户输入
 * @param fallback 无可判定字符时的回退语言（默认 'en'）
 */
export function detectLanguage(text: string, fallback: SupportedLocale = 'en'): SupportedLocale {
  /* 强信号：含中文高频功能/疑问字（的/了/吗/呢/你/我/他/她/怎/什/么/请/为/啥/谁/哪/会/能/吧/把/给）→
   * 判中文——这类字在中文句里几乎必现，能压住「中文问题夹长英文术语」被英文术语稀释的误判
   * （如「我的 TypeScript generic 怎么写」）。这些字不会出现在纯英文句。 */
  if (/[的了吗呢你我他她它怎什么请为啥谁哪会能吧把给吧呀啊嘛叫是不也很都还]/.test(text)) return 'zh-CN';

  let cjk = 0;
  let meaningful = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjk(cp)) { cjk++; meaningful++; }
    else if (isLatin(cp)) { meaningful++; }
  }
  if (meaningful === 0) return fallback;
  return cjk / meaningful >= CJK_THRESHOLD ? 'zh-CN' : 'en';
}
