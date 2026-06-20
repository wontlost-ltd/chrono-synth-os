/**
 * 内在驱动·对话回想（ADR-0056 类人化 block 6：「我突然想到你之前提到过…」）。
 *
 * 让数字人主动「想起」你之前说过的话——体现它**记得你、会想起你**的内在生活，而非纯被动问答。
 * 取一条与当前话题相关的**过往对话记忆**（kind=episodic，由「对话即经历」沉淀的你说过的话），
 * 渲染成第一人称回想片段（由 responder 加「我突然想到你之前提到过…」的框）。
 *
 * 设计说明：**不排除本轮 grounding 命中的记忆**——对话记忆几乎总会被关键词检索拉进 grounding，
 * 若排除则回想几乎永不触发（dead code）。即便该记忆也出现在 grounding 的冷列表里，回想的**框**
 * （「我突然想到你之前提到过 X，我一直记着」）带来的是「我记得你」的温度，与冷列举语义不同，
 * 轻微重叠可接受、且更像人。剥掉沉淀前缀「（来自对话）」让回想读起来是「你说的话」而非系统标记。
 *
 * 论点保持：零 LLM、确定性——同样的记忆库 + 同样输入 → 同一条回想（稳定 tie-break，可复现）。
 * 无相关过往对话记忆 → undefined（不编造，诚实）。
 */

import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { SupportedLocale } from '../../../i18n/locale-resolver.js';
import { tokenize } from '../../../conversation/conversation-knowledge-retriever.js';
import { CONVERSATION_MEMORY_PREFIX } from '../../../conversation/conversation-memory-capture.js';

/** 对话回想的最低关键词重叠分（低于此视为不相关，不回想）。 */
const MIN_OVERLAP = 1;
/** 回想片段最长字数（过长截断，与 follow-up 渲染端再统一截断无冲突）。 */
const CALLBACK_CAP = 40;
/** 过短的对话记忆不值得回想（噪声）。 */
const MIN_CONTENT_LEN = 4;

/**
 * 取一条与当前输入相关的过往对话记忆（episodic），渲染成确定性回想片段。
 *  - 仅看 kind='episodic'（对话沉淀），不回想老师教的 semantic 知识；
 *  - 按关键词重叠分降序、salience 降序、id 升序确定性取第一条（无随机）；
 *  - 剥掉「（来自对话）」沉淀前缀，让回想读起来是你说的话；
 *  - 无达标记忆 → undefined。
 */
export function buildConversationCallback(
  tenantOS: ChronoSynthOS,
  currentInput: string,
  _locale: SupportedLocale,
): string | undefined {
  const queryTokens = new Set(tokenize(currentInput));
  if (queryTokens.size === 0) return undefined;

  let best: { content: string; overlap: number; salience: number; id: string } | undefined;
  for (const mem of tenantOS.core.memories.getAllMemories().values()) {
    if (mem.kind !== 'episodic') continue;            // 只回想对话沉淀
    /* 剥沉淀前缀「（来自对话）」→ 回想读起来是「你说的话」而非系统标记。 */
    const content = mem.content.startsWith(CONVERSATION_MEMORY_PREFIX)
      ? mem.content.slice(CONVERSATION_MEMORY_PREFIX.length).trim()
      : mem.content.trim();
    if (content.length < MIN_CONTENT_LEN) continue;

    /* 重叠按原文 token 算（含前缀也无妨——前缀词不在 query 里不贡献分）。 */
    const memTokens = tokenize(mem.content);
    let overlap = 0;
    for (const tk of memTokens) if (queryTokens.has(tk)) overlap++;
    if (overlap < MIN_OVERLAP) continue;

    /* 确定性选取：overlap 降序 → salience 降序 → id 升序（稳定 tie-break，避免 Map 序漂移）。 */
    if (
      !best ||
      overlap > best.overlap ||
      (overlap === best.overlap && mem.salience > best.salience) ||
      (overlap === best.overlap && mem.salience === best.salience && mem.id < best.id)
    ) {
      best = { content, overlap, salience: mem.salience, id: mem.id };
    }
  }

  if (!best) return undefined;
  return best.content.length > CALLBACK_CAP ? best.content.slice(0, CALLBACK_CAP) : best.content;
}
