/**
 * 对话经历沉淀（ADR-0055「对话即经历」+ 多语种）——确定性、零-LLM。
 *
 * 论点保持：这不是「理解」用户的话（那需要 LLM 推理，走 reflect/perceive），而是把「跟你聊过这件事」
 * **确定性地记下来**——经历即记忆，记忆可被后续联想检索召回。所以离线也能「学习」：下次它记得你说过的话。
 *
 * 纯函数：相同输入 → 相同输出。决定「这轮对话该不该沉淀、沉淀成什么内容」，不做 I/O（写库由调用方）。
 *
 * **首版保守捕获**：判定刻意偏安全侧——宁可漏沉淀一条有价值的自我陈述，也绝不误沉淀一句疑问
 * （疑问会自回声污染检索 + 破坏可复现）。寒暄/疑问判定按 locale（中英）取自 companion-locale。
 *
 * 安全约束（写库前调用方仍须过 never_discuss 输出自检；本模块只做内容/够格判定）：
 *   - 空 / 过短 / 纯寒暄 / 疑问句 → 不沉淀（避免垃圾记忆污染人格知识核）。
 *   - 沉淀的记忆 **低显著（salience）**：远低于老师蒸馏的语义记忆，检索时不喧宾夺主。
 *   - kind='episodic'：与老师教的 'semantic' 知识区分。
 *   - 内容带确定性前缀标注来源（「（来自对话）」），运行期可识别、可检索。
 */

import type { SupportedLocale } from '../i18n/locale-resolver.js';
import { companionLocale } from './companion-locale.js';

/** 沉淀的对话记忆 salience（低——经历不应盖过老师教的知识；范围 0..1）。 */
export const CONVERSATION_MEMORY_SALIENCE = 0.25;
/** 沉淀的对话记忆 valence（中性——不臆断情感极性）。 */
export const CONVERSATION_MEMORY_VALENCE = 0;
/** 够格沉淀的用户输入最小长度（字符）：太短（如「嗯」「好」「ok」）不值得记。 */
const MIN_CAPTURE_LENGTH = 4;
/** 沉淀内容前缀（来源标注，确定性、可检索）。 */
const CONVERSATION_PREFIX = '（来自对话）';
/** 用户输入截断长度（防超长输入撑爆单条记忆；与知识片段上限同量级）。 */
const CAPTURE_CONTENT_CAP = 280;

/** 沉淀决策结果。capture=false 时 content 无意义。 */
export interface ConversationCaptureDecision {
  /** 是否值得沉淀为经历记忆。 */
  readonly capture: boolean;
  /** 沉淀的记忆正文（capture=true 时有效，已加来源前缀、已截断）。 */
  readonly content: string;
}

/**
 * 判定一段用户输入是否够格沉淀，以及沉淀成什么内容。纯确定性。
 *
 * @param userInput 已脱敏的用户输入（调用方保证非敏感——never_discuss 命中的输入不应进来）。
 * @param locale 对话语言（决定寒暄/疑问判定用哪套规则）。
 */
export function decideConversationCapture(userInput: string, locale: SupportedLocale): ConversationCaptureDecision {
  const res = companionLocale(locale);
  const trimmed = userInput.trim();
  if (trimmed.length < MIN_CAPTURE_LENGTH) return { capture: false, content: '' };

  /* 纯寒暄（整句归一化后命中寒暄集）→ 不沉淀。中文压成无空白，英文保留单空格小写。 */
  if (res.smallTalk.has(smallTalkKey(trimmed))) return { capture: false, content: '' };

  /* 疑问句（用户在问而非陈述）→ 不沉淀（去问句自回声噪声 + 保住可复现）。 */
  if (res.isQuestion(trimmed)) return { capture: false, content: '' };

  const body = trimmed.length > CAPTURE_CONTENT_CAP ? trimmed.slice(0, CAPTURE_CONTENT_CAP) : trimmed;
  return { capture: true, content: `${CONVERSATION_PREFIX}${body}` };
}

/** 寒暄归一化键：转小写 trim，去首尾标点（让「thanks.」「hello!」匹配），CJK 句去内部空白，
 * 拉丁句压成单空格（让「thank you」匹配）。 */
function smallTalkKey(text: string): string {
  const lower = text.trim().toLowerCase().replace(/^[\s.,!?;:'"。，！？、]+|[\s.,!?;:'"。，！？、]+$/g, '');
  /* 含拉丁字母 → 压单空格（保留词间空格供「thank you」匹配）；纯 CJK → 去所有空白。 */
  if (/[a-z]/.test(lower)) return lower.replace(/\s+/g, ' ');
  return lower.replace(/\s+/g, '');
}
