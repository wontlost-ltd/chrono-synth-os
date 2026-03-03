/**
 * 知识源注册表
 */

import type { KnowledgeSourceType } from '../types/avatar-autorun.js';
import type { KnowledgeSource } from './knowledge-source.js';

export class KnowledgeSourceRegistry {
  private readonly sources = new Map<KnowledgeSourceType, KnowledgeSource>();

  register(type: KnowledgeSourceType, source: KnowledgeSource): void {
    this.sources.set(type, source);
  }

  get(type: KnowledgeSourceType): KnowledgeSource {
    const source = this.sources.get(type);
    if (!source) throw new Error(`未注册的知识源类型: ${type}`);
    return source;
  }

  has(type: KnowledgeSourceType): boolean {
    return this.sources.has(type);
  }
}
