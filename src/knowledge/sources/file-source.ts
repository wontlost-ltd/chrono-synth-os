/**
 * 文件知识源
 * 从指定路径读取文本文件
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { KnowledgeItem } from '../../types/avatar-autorun.js';
import type { KnowledgeSource, KnowledgeSourceFetchResult } from '../knowledge-source.js';

const MAX_FILE_SIZE = 1_048_576; /* 1 MB */

export class FileKnowledgeSource implements KnowledgeSource {
  readonly type = 'file' as const;

  async fetch(
    config: Record<string, unknown>,
    state: Record<string, unknown> | null,
    _signal: AbortSignal,
  ): Promise<KnowledgeSourceFetchResult> {
    const fileRef = config.fileRef as string | undefined;
    if (!fileRef) return { items: [] };

    let content: string;
    try {
      const buf = readFileSync(fileRef);
      if (buf.length > MAX_FILE_SIZE) throw new Error(`文件大小超限: ${buf.length} > ${MAX_FILE_SIZE}`);
      content = buf.toString('utf-8');
    } catch (err) {
      throw new Error(`文件读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!content.trim()) return { items: [] };

    const fingerprint = createHash('sha256').update(content).digest('hex').slice(0, 32);

    /* 跳过内容未变化的文件，避免重复摄入 */
    const previousHash = typeof state?.lastFileHash === 'string' ? state.lastFileHash : undefined;
    if (previousHash && previousHash === fingerprint) {
      return { items: [], nextState: { lastFileHash: previousHash } };
    }

    const item: KnowledgeItem = {
      sourceId: '',
      content,
      title: fileRef.split('/').pop() ?? fileRef,
      kind: 'semantic',
      salience: 0.5,
      valence: 0,
      fingerprint,
    };

    return { items: [item], nextState: { lastFileHash: fingerprint } };
  }
}
