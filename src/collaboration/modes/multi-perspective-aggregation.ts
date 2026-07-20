// src/collaboration/modes/multi-perspective-aggregation.ts
/** 多视角汇聚（确定性、零-LLM）：共同话题（关键词重叠）+ 排序分歧（结构化）+ 证据摘要（模板拼装）。
 * 诚实命名：commonTopics 是「共同关注的话题」非「共识」；evidenceBrief 是「证据摘要」非「综合建议」（spec §5.2 / 约束 5）。 */
import type { CollaborationMode } from '../collaboration-types.js';
import type { CollaborativeReport, PersonaPerspective } from '../collaboration-types.js';

export class MultiPerspectiveAggregation implements CollaborationMode {
  readonly modeId = 'multi_perspective';

  aggregate(question: string, perspectives: readonly PersonaPerspective[]): CollaborativeReport {
    const groundedViews = perspectives.filter((p) => p.kind === 'knowledge_grounded');
    const g = groundedViews.length;
    const commonTopics = this.computeCommonTopics(groundedViews);
    const rankingDivergences = this.computeRankingDivergences(perspectives);
    const status: CollaborativeReport['status'] = g === 0 ? 'insufficient_grounding' : 'analyzed';
    const groundingNote = this.groundingNote(g, perspectives.length);
    return {
      question,
      modeId: this.modeId,
      status,
      perspectives,
      commonTopics: status === 'insufficient_grounding' ? [] : commonTopics,
      rankingDivergences: status === 'insufficient_grounding' ? [] : rankingDivergences,
      evidenceBrief: this.buildBrief(question, commonTopics, rankingDivergences, groundedViews, status),
      groundingNote,
      requiresHumanApproval: true,
    };
  }

  /** 某 topic 被 ≥2 个 grounded persona 提到即为共同话题（raisedBy 记提到者）。稳定序（topic 字典序）。 */
  private computeCommonTopics(grounded: readonly PersonaPerspective[]): { topic: string; raisedBy: string[] }[] {
    const byTopic = new Map<string, Set<string>>();
    for (const p of grounded) {
      for (const kp of p.keyPoints) {
        if (!byTopic.has(kp)) byTopic.set(kp, new Set());
        byTopic.get(kp)!.add(p.personaId);
      }
    }
    const topics: { topic: string; raisedBy: string[] }[] = [];
    for (const [topic, raisers] of byTopic) {
      if (raisers.size >= 2) topics.push({ topic, raisedBy: [...raisers].sort() });
    }
    return topics.sort((a, b) => a.topic.localeCompare(b.topic));
  }

  /** 同一 alternative 被 ≥2 persona 排到不同 rank → 分歧。稳定序（alternative 字典序）。 */
  private computeRankingDivergences(perspectives: readonly PersonaPerspective[]): CollaborativeReport['rankingDivergences'] {
    const byAlt = new Map<string, { personaId: string; rank: number }[]>();
    for (const p of perspectives) {
      for (const ra of p.rankedAlternatives ?? []) {
        if (!byAlt.has(ra.alternative)) byAlt.set(ra.alternative, []);
        byAlt.get(ra.alternative)!.push({ personaId: p.personaId, rank: ra.rank });
      }
    }
    const out: { alternative: string; rankings: { personaId: string; rank: number }[] }[] = [];
    for (const [alternative, rankings] of byAlt) {
      const ranks = new Set(rankings.map((r) => r.rank));
      if (rankings.length >= 2 && ranks.size >= 2) {
        out.push({ alternative, rankings: [...rankings].sort((a, b) => a.personaId.localeCompare(b.personaId)) });
      }
    }
    return out.sort((a, b) => a.alternative.localeCompare(b.alternative));
  }

  private groundingNote(g: number, total: number): string {
    if (g === 0) return '参与者对此问题均无相关积累，无法给出有据视角。';
    if (g < Math.ceil(total / 2)) return `多数参与者对此问题积累不足，仅 ${g} 个视角有依据。`;
    return `基于 ${total} 位数字人各自学习积累（${g} 个视角有据）。`;
  }

  /** 纯模板拼装证据摘要——不产新观点/新结论（约束 5）。 */
  private buildBrief(
    question: string,
    commonTopics: { topic: string; raisedBy: string[] }[],
    divergences: CollaborativeReport['rankingDivergences'],
    grounded: readonly PersonaPerspective[],
    status: CollaborativeReport['status'],
  ): string {
    if (status === 'insufficient_grounding') return `问题「${question}」：参与者均无相关积累，无证据摘要。`;
    const parts: string[] = [`问题「${question}」证据摘要（确定性汇总，非综合建议）：`];
    if (commonTopics.length > 0) parts.push(`共同关注话题：${commonTopics.map((t) => `${t.topic}（${t.raisedBy.join('、')}）`).join('；')}。`);
    if (divergences.length > 0) parts.push(`排序分歧：${divergences.map((d) => `${d.alternative}[${d.rankings.map((r) => `${r.personaId}=第${r.rank}`).join(',')}]`).join('；')}。`);
    for (const p of grounded) {
      const refs = p.evidence.slice(0, 3).map((e) => `${e.memoryId}:${e.excerpt.slice(0, 20)}`).join(' / ');
      parts.push(`- ${p.personaId} 依据：${refs}`);
    }
    return parts.join('\n');
  }
}
