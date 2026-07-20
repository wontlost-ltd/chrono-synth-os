// src/collaboration/key-points.ts
/** 从 grounded 证据 excerpt 提取 keyPoints（确定性、零-LLM）：tokenize + 剥样板前缀 + 去重 + 稳定排序。
 * 约束：只从 evidence.excerpt 提，不从 opinion/alternatives（spec §5.1 / 约束 3/4）。 */
import { tokenize } from '../conversation/conversation-knowledge-retriever.js';  // 已导出（:185）；不改该文件
import type { PerspectiveEvidence } from './collaboration-types.js';

/** 样板前缀词（离线套话/记忆引导语），不作为话题信号。照 memory companion-associative-memory。 */
const BOILERPLATE = new Set<string>(['据我记得', '我认为', '我觉得', '据我了解', '如我所学', '就我所知']);

/** 剥掉 excerpt 开头的样板引导（返回剥离后的文本）。 */
export function stripBoilerplate(text: string): string {
  let out = text.trim();
  for (const prefix of BOILERPLATE) {
    if (out.startsWith(prefix)) out = out.slice(prefix.length).trim();
  }
  return out;
}

/** 停用词（tokenize 若已去部分虚词则此处兜底）。 */
const STOPWORDS = new Set<string>(['需要', '是', '的', '了', '和', '与', '很', '更多', '关键', '约束']);

export function extractKeyPoints(evidence: readonly PerspectiveEvidence[]): string[] {
  const seen = new Set<string>();
  for (const e of evidence) {
    for (const tok of tokenize(stripBoilerplate(e.excerpt))) {
      if (tok.length <= 1) continue;          // 单字噪音
      if (STOPWORDS.has(tok)) continue;
      seen.add(tok);
    }
  }
  return [...seen].sort();                     // 稳定：字典序（约束 8 确定性）
}
