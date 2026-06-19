/**
 * 记忆内容多语变体 store（ADR-0055 内容多语）。
 *
 * per (tenant_id, memory_id, language) 存一条记忆在某语言下的内容变体。翻译由成长期 LLM 老师产出
 * （/companion/me/translate），运行时 chat 只读取已存变体（零-LLM）：按用户语言取变体匹配/呈现，
 * 无变体回退 memory_nodes.content（教学原语言）。
 *
 * 直接走 IDatabase.prepare（与 companion-identity-store 同款轻量读写，无需 kernel query 常量）。
 * 表 memory_translations 含 tenant_id → TenantDatabase 自动隔离；随 memory 级联删除；GDPR A 类。
 */

import type { IDatabase } from './database.js';
import type { SupportedLocale } from '../i18n/locale-resolver.js';

/** 单条翻译变体行。 */
export interface MemoryTranslationRow {
  readonly memoryId: string;
  readonly language: string;
  readonly text: string;
}

export class MemoryTranslationStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
  ) {}

  /** 取某记忆在某语言的变体；无 → undefined。 */
  get(memoryId: string, language: SupportedLocale): string | undefined {
    const row = this.db.prepare<{ text: string }>(
      'SELECT text FROM memory_translations WHERE tenant_id = ? AND memory_id = ? AND language = ?',
    ).get(this.tenantId, memoryId, language);
    const text = row?.text?.trim();
    return text && text.length > 0 ? text : undefined;
  }

  /** 一次性拉本租户某语言的全部变体（呈现/检索预加载）→ Map<memoryId, text>。 */
  listByLanguage(language: SupportedLocale): Map<string, string> {
    const rows = this.db.prepare<{ memory_id: string; text: string }>(
      'SELECT memory_id, text FROM memory_translations WHERE tenant_id = ? AND language = ?',
    ).all(this.tenantId, language);
    const map = new Map<string, string>();
    for (const r of rows) {
      const text = r.text?.trim();
      if (text && text.length > 0) map.set(r.memory_id, text);
    }
    return map;
  }

  /** 本租户某语言已翻译的 memory_id 集合（增量翻译时跳过已翻译的）。 */
  translatedIds(language: SupportedLocale): Set<string> {
    const rows = this.db.prepare<{ memory_id: string }>(
      'SELECT memory_id FROM memory_translations WHERE tenant_id = ? AND language = ?',
    ).all(this.tenantId, language);
    return new Set(rows.map((r) => r.memory_id));
  }

  /** upsert 某记忆的某语言变体（text 空则忽略，不落空变体）。 */
  upsert(memoryId: string, language: SupportedLocale, text: string, now: number, source = 'teacher'): void {
    const clean = text.trim();
    if (clean.length === 0) return;
    this.db.prepare<void>(
      `INSERT INTO memory_translations (tenant_id, memory_id, language, text, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, memory_id, language) DO UPDATE SET
         text = excluded.text, source = excluded.source, created_at = excluded.created_at`,
    ).run(this.tenantId, memoryId, language, clean, source, now);
  }
}
