/**
 * 对话知识检索器（P1-C MVP，关键词匹配）
 *
 * 从 persona_knowledge_items 按 title/content 关键词匹配，返回 topK 相关条目。
 * 未来可替换为 embedding 检索（需要 persona 知识也走 EmbeddingIndex）。
 *
 * 输入清洗：去除停用词（中英文都有），按 token 累加打分。
 */

import type { IDatabase } from '../storage/database.js';
import type { RelevantKnowledge } from './conversation-types.js';

interface KnowledgeRow {
  id: string;
  title: string;
  content: string;
  confidence: number;
}

/* 极简停用词表，避免对常见连词/疑问词命中 */
const STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '什么', '怎么', '吗', '呢', '吧',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'i', 'you', 'we', 'they', 'he', 'she', 'it', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'if', 'then', 'else', 'how', 'what', 'when', 'where', 'why', 'who', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'as',
]);

const MIN_TOKEN_LENGTH = 2;
const MAX_TOKEN_COUNT = 32;

export class ConversationKnowledgeRetriever {
  constructor(private readonly db: IDatabase) {}

  retrieve(input: {
    tenantId: string;
    personaId: string;
    userInput: string;
    topK: number;
  }): RelevantKnowledge[] {
    const tokens = tokenize(input.userInput);
    if (tokens.length === 0) return [];

    /* 加载该 persona 的所有知识条目（短期内 persona 知识量上限通常 < 1000，可全量打分） */
    const rows = this.db.prepare<KnowledgeRow>(
      `SELECT id, title, content, confidence
         FROM persona_knowledge_items
        WHERE tenant_id = ? AND persona_id = ?`,
    ).all(input.tenantId, input.personaId);
    if (rows.length === 0) return [];

    const scored = rows.map((row) => {
      const haystack = `${row.title}\n${row.content}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (haystack.includes(t)) score += t.length >= 4 ? 2 : 1;
      }
      /* 知识本身的 confidence 作为打分加权（高置信度优先） */
      score *= 0.5 + 0.5 * row.confidence;
      return { row, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, input.topK))
      .map((s) => ({
        id: s.row.id,
        title: s.row.title,
        content: s.row.content,
        relevance: clamp01(s.score / (tokens.length * 2)),
      }));
  }
}

function tokenize(text: string): string[] {
  /* 同时支持中英文：拉丁字母数字按 \W 分词；CJK 按 1-3 字符滑动窗口生成 bigram/trigram */
  const lower = text.toLowerCase();
  const tokens = new Set<string>();

  const latinMatches = lower.match(/[a-z0-9¥$€£%]+/g) ?? [];
  for (const m of latinMatches) {
    if (m.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(m)) tokens.add(m);
  }

  /* CJK：抽出连续中文片段，再切 2/3 字符 ngram */
  const cjkMatches = lower.match(/[一-鿿]+/g) ?? [];
  for (const segment of cjkMatches) {
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= segment.length; i++) {
        const gram = segment.slice(i, i + n);
        if (!STOPWORDS.has(gram)) tokens.add(gram);
      }
    }
  }

  return [...tokens].slice(0, MAX_TOKEN_COUNT);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
