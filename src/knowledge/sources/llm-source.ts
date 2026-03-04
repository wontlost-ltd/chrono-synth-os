/**
 * LLM 知识源
 * 通过 LLM 生成结构化知识条目，支持主题轮询与深度递进
 */

import { createHash } from 'node:crypto';
import type { KnowledgeItem } from '../../types/avatar-autorun.js';
import type { KnowledgeSource, KnowledgeSourceFetchResult } from '../knowledge-source.js';
import type { ModelRouter } from '../../intelligence/model-router.js';

/** 深度层级标签 */
const DEPTH_LABELS = ['基础', '中级', '高级', '专家'] as const;

/** LLM 返回的单条知识条目 */
interface LlmGeneratedItem {
  readonly title: string;
  readonly content: string;
  readonly salience?: number;
  readonly kind?: 'semantic' | 'procedural';
}

export class LlmKnowledgeSource implements KnowledgeSource {
  readonly type = 'llm' as const;

  constructor(private readonly router: ModelRouter) {}

  async fetch(
    config: Record<string, unknown>,
    state: Record<string, unknown> | null,
    signal: AbortSignal,
  ): Promise<KnowledgeSourceFetchResult> {
    const systemPrompt = config.systemPrompt as string | undefined;
    const topics = config.topics as string[] | undefined;
    if (!systemPrompt || !topics?.length) return { items: [] };

    const itemsPerRun = Math.min(Math.max(Number(config.itemsPerRun) || 5, 1), 20);

    /* 恢复进度状态 */
    let topicIndex = typeof state?.topicIndex === 'number' ? state.topicIndex as number : 0;
    let depth = typeof state?.depth === 'number' ? state.depth as number : 0;
    const generatedFingerprints = Array.isArray(state?.generatedFingerprints)
      ? new Set(state.generatedFingerprints as string[])
      : new Set<string>();

    /* 深度限制：最多到专家级 */
    if (depth >= DEPTH_LABELS.length) depth = DEPTH_LABELS.length - 1;

    /* 当前主题与深度 */
    const currentTopic = topics[topicIndex % topics.length];
    const depthLabel = DEPTH_LABELS[depth];

    /* 构建提示词 */
    const userPrompt = [
      `请为以下主题生成 ${itemsPerRun} 条【${depthLabel}】级别的知识条目：`,
      `主题：${currentTopic}`,
      '',
      '要求：',
      '1. 返回纯 JSON 数组（不要 markdown 代码块包裹）',
      '2. 每条格式：{"title":"标题","content":"详细内容（至少100字）","salience":0.0-1.0,"kind":"semantic 或 procedural"}',
      '3. 内容必须准确、专业，包含具体法规条款、计算公式或操作步骤',
      `4. 难度定位为【${depthLabel}】级别，避免过于浅显或过于深入`,
      '5. 每条内容互不重复，覆盖该主题的不同方面',
    ].join('\n');

    /* 调用 LLM */
    const response = await this.router.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { maxTokens: 4096, temperature: 0.7, responseFormat: 'json' },
    );

    if (signal.aborted) return { items: [] };

    /* 解析响应 */
    const parsed = this.parseResponse(response.content);
    const items: KnowledgeItem[] = [];

    for (const raw of parsed) {
      if (!raw.content || !raw.title) continue;

      const fingerprint = createHash('sha256')
        .update(`${currentTopic}:${depth}:${raw.title}`)
        .digest('hex')
        .slice(0, 32);

      /* 指纹去重：跳过已生成的内容 */
      if (generatedFingerprints.has(fingerprint)) continue;
      generatedFingerprints.add(fingerprint);

      const kind = raw.kind === 'procedural' ? 'procedural' : 'semantic';
      items.push({
        sourceId: '',
        title: raw.title,
        content: raw.content,
        kind,
        salience: typeof raw.salience === 'number'
          ? Math.max(0, Math.min(1, raw.salience))
          : 0.6,
        valence: 0,
        fingerprint,
      });
    }

    /* 推进状态：主题索引 + 1，遍历完一轮后深度 + 1 */
    let nextTopicIndex = topicIndex + 1;
    let nextDepth = depth;
    if (nextTopicIndex >= topics.length) {
      nextTopicIndex = 0;
      nextDepth = Math.min(depth + 1, DEPTH_LABELS.length - 1);
    }

    /* 指纹集合过大时截断（保留最近 2000 条） */
    const MAX_FINGERPRINTS = 2000;
    const fpArray = [...generatedFingerprints];
    const trimmedFp = fpArray.length > MAX_FINGERPRINTS
      ? fpArray.slice(fpArray.length - MAX_FINGERPRINTS)
      : fpArray;

    return {
      items,
      nextState: {
        topicIndex: nextTopicIndex,
        depth: nextDepth,
        generatedFingerprints: trimmedFp,
      },
    };
  }

  /** 解析 LLM 返回的 JSON 数组，兼容常见格式偏差 */
  private parseResponse(raw: string): LlmGeneratedItem[] {
    const trimmed = raw.trim();

    /* 移除 markdown 代码块包裹 */
    const stripped = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    try {
      const parsed: unknown = JSON.parse(stripped);

      /* 直接是数组 */
      if (Array.isArray(parsed)) return parsed as LlmGeneratedItem[];

      /* 对象包裹：取第一个数组属性 */
      if (typeof parsed === 'object' && parsed !== null) {
        for (const value of Object.values(parsed)) {
          if (Array.isArray(value)) return value as LlmGeneratedItem[];
        }
      }

      return [];
    } catch {
      return [];
    }
  }
}
