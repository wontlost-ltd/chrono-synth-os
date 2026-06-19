/**
 * 归纳总结（ADR-0055 归纳能力）——确定性、零-LLM、多语种。
 *
 * 给数字人「归纳总结」能力：「总结你学过的带团队」「你最近学了什么」「summarize what you know about X」。
 * 论点保持：这不是 LLM 式「理解后概括」，而是**确定性聚合**——有主题沿关键词+图检索按**相关度**
 * 排序，无主题取**最近**（createdAt 降序）→ 去重 → 模板拼装成有序总述。相同输入（+相同人格状态）→
 * 相同输出，运行时零-LLM、离线可用。这是「相关记忆的确定性整理」，非 LLM 式综合（不抽象共性/
 * 不消解矛盾/不跨语言对齐）——深层归纳登记后续。
 *
 * 深度「融会贯通」式归纳（LLM 老师读多条记忆 → 提炼出更高层概括 → 蒸馏成新记忆）属成长档，
 * 复用 reflect 模式，登记为后续，不在此模块。
 */

import type { MemoryId, MemoryNode } from '@chrono/kernel';
import type { SupportedLocale } from '../i18n/locale-resolver.js';
import { companionLocale } from './companion-locale.js';
import { retrieveMemoriesDeterministic } from './deterministic-memory-retrieval.js';
import type { EdgeLookup } from './deterministic-memory-retrieval.js';

/** 总述取多少条记忆（与 self_intro 量级一致，避免过长）。 */
const SUMMARY_MEMORY_LIMIT = 6;
/** 单条记忆在总述里的最大字符数。 */
const SUMMARY_SNIPPET_CAP = 200;

/** 归纳意图识别结果。 */
export interface SummaryIntent {
  /** 是否是归纳总结意图。 */
  readonly matched: boolean;
  /** 主题（有则按主题总结；无则「最近学了什么」）。 */
  readonly topic?: string;
}

/** 识别「归纳总结」意图并提取主题（确定性，按 locale）。 */
export function detectSummaryIntent(message: string, locale: SupportedLocale): SummaryIntent {
  const text = message.trim();
  if (text.length === 0) return { matched: false };
  for (const re of companionLocale(locale).summaryPatterns) {
    const m = re.exec(text);
    if (m) {
      const topic = m[1] ? sanitizeTopic(m[1]) : undefined;
      return { matched: true, topic: topic && topic.length > 0 ? topic : undefined };
    }
  }
  return { matched: false };
}

/** 构建归纳总述（确定性，多语）。topic 有则按主题检索（相关度排序），无则取最近记忆（createdAt 降序）。
 * 返回相应模板字符串；无可用记忆 → summaryNothing。 */
export function buildSummary(args: {
  memories: ReadonlyMap<MemoryId, MemoryNode>;
  edgesFor: EdgeLookup;
  topic: string | undefined;
  locale: SupportedLocale;
}): string | undefined {
  const t = companionLocale(args.locale).reply;
  const all = [...args.memories.values()];
  if (all.length === 0) return t.summaryNothing;

  let selected: MemoryNode[];
  if (args.topic) {
    /* 有主题：沿关键词 + 图扩展检索相关记忆。 */
    const hits = retrieveMemoriesDeterministic(args.topic, args.memories, args.edgesFor);
    const byId = new Map(all.map((m) => [m.id, m]));
    selected = hits.map((h) => byId.get(h.id)).filter((m): m is MemoryNode => m !== undefined);
    if (selected.length === 0) return t.summaryEmpty(args.topic);
  } else {
    /* 无主题（最近学了什么）：按 createdAt 降序取最近，稳定 tie-breaker（id）防 Map 迭代漂移。 */
    selected = [...all].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  /* 去重（精确内容）+ 截断到上限。相似度去重留 debt。 */
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of selected) {
    const content = m.content.trim();
    if (content.length === 0 || seen.has(content)) continue;
    seen.add(content);
    lines.push(`· ${content.slice(0, SUMMARY_SNIPPET_CAP)}`);
    if (lines.length >= SUMMARY_MEMORY_LIMIT) break;
  }
  if (lines.length === 0) return args.topic ? t.summaryEmpty(args.topic) : t.summaryNothing;

  const lead = args.topic ? t.summaryLeadIn(args.topic) : t.summaryRecentLeadIn;
  return [lead, ...lines, t.summaryFooter(lines.length)].join('\n');
}

/** 清洗提取的主题：去首尾标点空白、控制字符，截断。 */
function sanitizeTopic(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out.replace(/^[\s，。,.!！?？、'"「」]+|[\s，。,.!！?？、'"「」]+$/g, '').trim().slice(0, 30);
}
