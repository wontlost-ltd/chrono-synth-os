/**
 * PII 脱敏（P1-C 加固 9）
 *
 * 在 user_input / assistant_output 写入持久化层和审计日志之前对常见敏感信息脱敏。
 * 不替代字段加密 —— 只负责把 PII 在原始内容中替换为占位符，避免：
 *   - 日志聚合系统（Loki/ELK）截获明文 PII
 *   - LLM provider 上传明文 PII 触发合规问题
 *   - 持久化数据库被未授权读取时泄露 PII
 *
 * 覆盖：手机号（中国大陆 / 国际）、邮箱、身份证（中国 18 位）、银行卡号、
 *      IPv4、JWT、API key 类长字符串。
 *
 * 原则：保守覆盖（宁误判不放过）；输出长度可能略小于输入。
 */

export type PiiCategory = 'phone' | 'email' | 'id_card' | 'card_no' | 'ipv4' | 'jwt' | 'api_key';

export interface RedactionResult {
  text: string;
  redactedCount: number;
  categories: Partial<Record<PiiCategory, number>>;
}

interface Pattern {
  category: PiiCategory;
  regex: RegExp;
  replacement: string;
}

const PATTERNS: readonly Pattern[] = [
  /* 中国大陆手机号（含 +86 / 86 前缀，1[3-9] 开头 11 位） */
  { category: 'phone', regex: /(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: '[REDACTED_PHONE]' },
  /* 通用国际手机号（保守：+ 后跟 7-15 位数字 + 至少含一个空格或连字符） */
  { category: 'phone', regex: /\+\d{1,3}[\s-]\d{2,4}[\s-]\d{3,4}[\s-]\d{3,4}\b/g, replacement: '[REDACTED_PHONE]' },
  /* 邮箱 */
  { category: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[REDACTED_EMAIL]' },
  /* 中国身份证 18 位（17 位数字 + 末位数字或 X） */
  { category: 'id_card', regex: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, replacement: '[REDACTED_ID_CARD]' },
  /* 银行卡号（13-19 位连续数字，前缀常见 visa/master/银联） */
  { category: 'card_no', regex: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|62\d{14,17})\b/g, replacement: '[REDACTED_CARD_NO]' },
  /* IPv4 */
  { category: 'ipv4', regex: /\b(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d{1,2})){3}\b/g, replacement: '[REDACTED_IP]' },
  /* JWT */
  { category: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[REDACTED_JWT]' },
  /* 通用 API key 启发式（>= 32 字符的随机字母数字串），最后处理避免覆盖前面已替换的占位符 */
  { category: 'api_key', regex: /\b[A-Za-z0-9_-]{32,}\b/g, replacement: '[REDACTED_API_KEY]' },
];

const PLACEHOLDER_GUARD = /^\[REDACTED_/;

export function redactPii(text: string): RedactionResult {
  let result = text;
  const categories: Partial<Record<PiiCategory, number>> = {};
  let redactedCount = 0;

  for (const p of PATTERNS) {
    /* 重置 RegExp.lastIndex（带 g flag 的全局正则在多次 exec 之间需要重置） */
    p.regex.lastIndex = 0;
    result = result.replace(p.regex, (match) => {
      /* 保护已替换的占位符不被二次匹配 */
      if (PLACEHOLDER_GUARD.test(match)) return match;
      categories[p.category] = (categories[p.category] ?? 0) + 1;
      redactedCount += 1;
      return p.replacement;
    });
  }

  return { text: result, redactedCount, categories };
}
