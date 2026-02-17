/**
 * 叙事存储：维护核心自我的叙事摘要
 */

import type { IDatabase } from '../storage/database.js';
import type { Clock } from '../utils/clock.js';

interface NarrativeRow {
  tenant_id: string;
  content: string;
  updated_at: number;
}

export class NarrativeStore {
  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
  ) {}

  /** 获取当前叙事 */
  get(): string {
    const row = this.db.prepare<NarrativeRow>(
      `SELECT content FROM narrative WHERE tenant_id = 'default'`,
    ).get();
    return row?.content ?? '';
  }

  /** 设置叙事内容；返回旧叙事 */
  set(content: string): string {
    const previous = this.get();
    const now = this.clock.now();
    this.db.prepare<void>(
      `INSERT INTO narrative (tenant_id, content, updated_at) VALUES ('default', ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    ).run(content, now);
    return previous;
  }
}
