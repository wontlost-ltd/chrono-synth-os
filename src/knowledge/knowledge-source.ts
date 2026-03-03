/**
 * 知识源抽象接口
 */

import type { KnowledgeSourceType, KnowledgeItem } from '../types/avatar-autorun.js';

/** 知识源抓取结果 */
export interface KnowledgeSourceFetchResult {
  readonly items: KnowledgeItem[];
  readonly nextState?: Record<string, unknown> | null;
}

/** 知识源接口 */
export interface KnowledgeSource {
  readonly type: KnowledgeSourceType;
  fetch(
    config: Record<string, unknown>,
    state: Record<string, unknown> | null,
    signal: AbortSignal,
  ): Promise<KnowledgeSourceFetchResult>;
}
