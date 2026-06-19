/**
 * 记忆内容翻译服务（ADR-0055 内容多语，成长档）。
 *
 * 用 LLM 老师把一批记忆内容翻译成目标语言——**摄取/成长阶段**，运行时 chat 不调用本服务（只读取
 * 已存翻译变体）。翻译产物存 memory_translations 表，之后目标语言用户的检索/呈现走零-LLM。
 *
 * 论点保持：翻译是「老师在成长期帮我把已学的东西用另一种语言重述」，与 perceive（教）/reflect（内化）
 * 同档；运行时仍零-LLM。安全：翻译只重述已有记忆内容，不引入新知识；调用方对译文做 never_discuss 呈现自检。
 */

import type { ModelRouter } from './model-router.js';
import type { SupportedLocale } from '../i18n/locale-resolver.js';

/** 待翻译的记忆（id + 原文）。 */
export interface TranslatableMemory {
  readonly id: string;
  readonly content: string;
}

/** 翻译结果（id → 译文）。 */
export type TranslationResult = ReadonlyMap<string, string>;

/** 单次最多翻译多少条（控制 prompt 大小 / token）。调用方分批。 */
export const TRANSLATION_BATCH_SIZE = 20;

/** 单次 /translate 请求最多翻译多少条（有界同步，避免长任务超时；多次调用增量续翻）。 */
export const MAX_TRANSLATE_PER_CALL = 40;

/** 目标语言的人类可读名（喂给老师的指令）。 */
const LANGUAGE_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
  'zh-CN': 'Simplified Chinese',
};

export class LlmTranslationService {
  constructor(
    private readonly llm: ModelRouter,
    private readonly logger?: { info(layer: string, msg: string): void; warn(layer: string, msg: string): void },
  ) {}

  /**
   * 把一批记忆内容翻译成 targetLanguage。返回 id→译文（仅含成功翻译的）。
   * LLM 失败 / JSON 解析失败 → 返回空 Map（安全降级，调用方不写库）。
   * 译文保留**第一人称视角**（记忆是数字人的自述，如「我听到…」→「I heard…」）。
   */
  async translate(memories: readonly TranslatableMemory[], targetLanguage: SupportedLocale): Promise<TranslationResult> {
    if (memories.length === 0) return new Map();
    const langName = LANGUAGE_NAMES[targetLanguage] ?? targetLanguage;

    const system = [
      'TASK:TRANSLATE_MEMORIES',
      `你在帮一个数字人把它的记忆内容翻译成 ${langName}。`,
      '规则：①只翻译，不增删信息、不解释、不添加新内容；②保留第一人称视角（这些是数字人的自述）；',
      '③保留原意与语气；④返回 JSON 对象 {"id1":"译文1","id2":"译文2",...}，key 用给定的记忆 id。',
    ].join('\n');
    const user = [
      `目标语言：${langName}`,
      '待翻译记忆（id → 原文）：',
      ...memories.map((m) => `[${m.id}] ${m.content}`),
    ].join('\n');

    try {
      const res = await this.llm.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { responseFormat: 'json' },
      );
      const parsed = safeParseObject(res.content);
      if (!parsed) {
        this.logger?.warn('LlmTranslationService', '译文 JSON 解析失败，跳过本批');
        return new Map();
      }
      const out = new Map<string, string>();
      for (const m of memories) {
        const t = parsed[m.id];
        if (typeof t === 'string' && t.trim().length > 0) out.set(m.id, t.trim());
      }
      this.logger?.info('LlmTranslationService', `翻译 ${out.size}/${memories.length} 条 → ${langName}`);
      return out;
    } catch (err) {
      this.logger?.warn('LlmTranslationService', `翻译失败，跳过本批: ${err instanceof Error ? err.message : String(err)}`);
      return new Map();
    }
  }
}

/** 安全解析 JSON 对象（{id:text}）；非对象 / 解析失败 → undefined。 */
function safeParseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end < start) return undefined;
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
