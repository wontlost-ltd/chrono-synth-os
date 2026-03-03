/**
 * REST API 知识源
 * 通过 HTTP GET 获取 JSON 数据并解析为知识条目
 */

import { createHash } from 'node:crypto';
import type { KnowledgeItem } from '../../types/avatar-autorun.js';
import type { KnowledgeSource, KnowledgeSourceFetchResult } from '../knowledge-source.js';

export class ApiKnowledgeSource implements KnowledgeSource {
  readonly type = 'api' as const;

  async fetch(
    config: Record<string, unknown>,
    _state: Record<string, unknown> | null,
    signal: AbortSignal,
  ): Promise<KnowledgeSourceFetchResult> {
    const url = config.url as string | undefined;
    if (!url) return { items: [] };

    const headers = (config.headers as Record<string, string>) ?? {};
    const response = await fetch(url, {
      signal,
      headers: { 'Accept': 'application/json', ...headers },
    });
    if (!response.ok) throw new Error(`API 抓取失败: ${response.status}`);

    const body = await response.json() as unknown;

    /* 支持数组或 { data: [...] } 两种格式 */
    const entries = Array.isArray(body)
      ? body as Record<string, unknown>[]
      : Array.isArray((body as Record<string, unknown>)?.data)
        ? (body as Record<string, unknown>).data as Record<string, unknown>[]
        : [body as Record<string, unknown>];

    const items: KnowledgeItem[] = [];
    for (const entry of entries) {
      const content = (entry.content ?? entry.text ?? entry.body ?? entry.description ?? JSON.stringify(entry)) as string;
      if (!content || typeof content !== 'string') continue;

      items.push({
        sourceId: '',
        title: (entry.title as string) ?? undefined,
        content,
        url: (entry.url ?? entry.link) as string | undefined,
        kind: 'semantic',
        salience: 0.5,
        valence: 0,
        fingerprint: createHash('sha256').update(content).digest('hex').slice(0, 32),
      });
    }

    return { items };
  }
}
