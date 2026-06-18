/**
 * 第一人称身份意图识别（ADR-0055「自我意识」+ 多语种）——确定性、零-LLM。
 *
 * 两类身份意图（按 locale 用对应语言的模式）：
 *   - 「定义我的身份」：用户在给数字人起名（中：你叫X/我叫你X；英：call you X/your name is X）。
 *     → 提取名字 X（视角转换：用户对「你」的称呼 = 数字人自己，内化为第一人称身份）。
 *   - 「询问我的身份」：用户在问名字（中：你叫什么；英：what's your name）。→ 第一人称答「我叫X」。
 *
 * 语言相关的模式集中在 companion-locale.ts；本模块只做「按 locale 取模式 → 匹配 → 清洗」。
 * 纯函数：相同输入 → 相同输出。
 */

import type { SupportedLocale } from '../i18n/locale-resolver.js';
import { companionLocale } from './companion-locale.js';

/** 提取到的名字最大长度（与 store 兜底一致，超长视为非起名）。 */
const MAX_EXTRACTED_NAME = 40;

export interface IdentityIntent {
  /** 'define'=在给我起名（含提取的 name）；'ask'=在问我名字；'none'=非身份意图。 */
  readonly kind: 'define' | 'ask' | 'none';
  /** kind='define' 时的名字（已清洗）。 */
  readonly name?: string;
}

/**
 * 识别一段用户输入的身份意图（确定性，按 locale）。
 * **ask 先于 define**：避免「你的名字是什么 / what's your name」被当起名。
 * @param userInput 用户输入
 * @param locale 对话语言（决定用哪套模式）
 */
export function detectIdentityIntent(userInput: string, locale: SupportedLocale): IdentityIntent {
  const text = userInput.trim();
  if (text.length === 0) return { kind: 'none' };
  const res = companionLocale(locale);

  /* 先试询问（带疑问标记）。 */
  for (const re of res.nameAskPatterns) {
    if (re.test(text)) return { kind: 'ask' };
  }

  /* 起名否决：疑问/转述上下文（如「Can I call you X?」「They call you X.」）不当起名。 */
  if (res.nameDefineVeto?.test(text)) return { kind: 'none' };

  /* 再试定义（起名）——捕获名字并清洗。 */
  for (const re of res.nameDefinePatterns) {
    const m = re.exec(text);
    if (m && m[1]) {
      const name = sanitizeName(m[1]);
      if (name.length > 0) return { kind: 'define', name };
    }
  }

  return { kind: 'none' };
}

/** 清洗提取的名字：去 ASCII 控制字符（含换行/制表）与尖括号（防 markup）与首尾标点空白，截断。
 * 与 store 的 cleanName 一致——意图层即剥空：清洗后为空 → 调用方判 length===0 不 define，
 * 避免「你叫<>」这类清洗后空名走到 setName 抛错触发 route 500。 */
function sanitizeName(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;       // 控制字符
    if (ch === '<' || ch === '>') continue;            // 防 markup
    out += ch;
  }
  const trimmed = out.replace(/^[\s，。,.!！?？、'"「」]+|[\s，。,.!！?？、'"「」]+$/g, '').trim();
  return trimmed.slice(0, MAX_EXTRACTED_NAME);
}
