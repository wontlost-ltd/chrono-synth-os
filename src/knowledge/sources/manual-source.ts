/**
 * 手动输入知识源
 */

import { createHash } from 'node:crypto';
import type { KnowledgeItem } from '../../types/avatar-autorun.js';
import type { KnowledgeSource, KnowledgeSourceFetchResult } from '../knowledge-source.js';

export class ManualKnowledgeSource implements KnowledgeSource {
  readonly type = 'manual' as const;

  async fetch(
    config: Record<string, unknown>,
    _state: Record<string, unknown> | null,
    _signal: AbortSignal,
  ): Promise<KnowledgeSourceFetchResult> {
    const text = config.manualText as string | undefined;
    if (!text) return { items: [] };

    const item: KnowledgeItem = {
      sourceId: '',
      content: text,
      kind: 'semantic',
      salience: 0.5,
      valence: 0,
      fingerprint: createHash('sha256').update(text).digest('hex').slice(0, 32),
    };

    return { items: [item], nextState: { ingested: true } };
  }
}
