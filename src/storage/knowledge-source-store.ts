/**
 * 知识源存储
 */

import type { IDatabase } from './database.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { KnowledgeSourceRecord, KnowledgeSourceType } from '../types/avatar-autorun.js';

interface KnowledgeSourceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly type: string;
  readonly name: string;
  readonly enabled: number;
  readonly config_json: string;
  readonly state_json: string | null;
  readonly last_ingested_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function rowToRecord(r: KnowledgeSourceRow): KnowledgeSourceRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.type as KnowledgeSourceType,
    name: r.name,
    enabled: r.enabled === 1,
    configJson: r.config_json,
    stateJson: r.state_json,
    lastIngestedAt: r.last_ingested_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class KnowledgeSourceStore {
  constructor(private readonly db: IDatabase) {}

  create(tenantId: string, data: { type: KnowledgeSourceType; name: string; configJson: string }): KnowledgeSourceRecord {
    const id = generatePrefixedId('ks');
    const now = Date.now();
    this.db.prepare<void>(
      `INSERT INTO knowledge_sources (id, tenant_id, type, name, enabled, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(id, tenantId, data.type, data.name, data.configJson, now, now);
    return {
      id, tenantId, type: data.type, name: data.name,
      enabled: true, configJson: data.configJson,
      stateJson: null, lastIngestedAt: null,
      createdAt: now, updatedAt: now,
    };
  }

  update(id: string, tenantId: string, data: Partial<{
    name: string;
    type: KnowledgeSourceType;
    configJson: string;
    enabled: boolean;
  }>): KnowledgeSourceRecord | null {
    const existing = this.getById(id, tenantId);
    if (!existing) return null;

    const now = Date.now();
    const name = data.name ?? existing.name;
    const type = data.type ?? existing.type;
    const configJson = data.configJson ?? existing.configJson;
    const enabled = data.enabled !== undefined ? data.enabled : existing.enabled;

    this.db.prepare<void>(
      `UPDATE knowledge_sources SET name = ?, type = ?, config_json = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(name, type, configJson, enabled ? 1 : 0, now, id, tenantId);

    return this.getById(id, tenantId);
  }

  getById(id: string, tenantId: string): KnowledgeSourceRecord | null {
    const row = this.db.prepare<KnowledgeSourceRow>(
      'SELECT * FROM knowledge_sources WHERE id = ? AND tenant_id = ?',
    ).get(id, tenantId);
    return row ? rowToRecord(row) : null;
  }

  listByTenant(tenantId: string, limit: number, offset: number): { sources: KnowledgeSourceRecord[]; total: number } {
    const rows = this.db.prepare<KnowledgeSourceRow>(
      'SELECT * FROM knowledge_sources WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(tenantId, limit, offset);
    const countRow = this.db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM knowledge_sources WHERE tenant_id = ?',
    ).get(tenantId);
    return {
      sources: rows.map(rowToRecord),
      total: countRow?.count ?? 0,
    };
  }

  listEnabledByIds(tenantId: string, ids: string[]): KnowledgeSourceRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare<KnowledgeSourceRow>(
      `SELECT * FROM knowledge_sources WHERE tenant_id = ? AND enabled = 1 AND id IN (${placeholders})`,
    ).all(tenantId, ...ids);
    return rows.map(rowToRecord);
  }

  updateState(id: string, stateJson: string | null, lastIngestedAt: number): void {
    this.db.prepare<void>(
      'UPDATE knowledge_sources SET state_json = ?, last_ingested_at = ?, updated_at = ? WHERE id = ?',
    ).run(stateJson, lastIngestedAt, Date.now(), id);
  }

  delete(id: string, tenantId: string): boolean {
    const result = this.db.prepare<void>(
      'DELETE FROM knowledge_sources WHERE id = ? AND tenant_id = ?',
    ).run(id, tenantId);
    return result.changes > 0;
  }
}
