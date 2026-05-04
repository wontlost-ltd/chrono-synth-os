/**
 * 知识源存储
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { KsrcRow } from '@chrono/kernel';
import {
  ksrcQueryById, ksrcQueryList, ksrcQueryCount, ksrcQueryEnabledByIds,
  ksrcCmdCreate, ksrcCmdUpdate, ksrcCmdUpdateState, ksrcCmdDelete,
} from '@chrono/kernel';
import { asUow, type UowOrDb } from './uow-helpers.js';
import { registerCoreSelfExecutors } from './executors/index.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { KnowledgeSourceRecord, KnowledgeSourceType } from '../types/avatar-autorun.js';

function rowToRecord(r: KsrcRow): KnowledgeSourceRecord {
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
  private readonly tx: SyncWriteUnitOfWork;

  constructor(uowOrDb: UowOrDb) {
    registerCoreSelfExecutors();
    this.tx = asUow(uowOrDb);
  }

  create(tenantId: string, data: { type: KnowledgeSourceType; name: string; configJson: string }): KnowledgeSourceRecord {
    const id = generatePrefixedId('ks');
    const now = Date.now();
    this.tx.execute(ksrcCmdCreate({ id, tenantId, type: data.type, name: data.name, configJson: data.configJson, now }));
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

    this.tx.execute(ksrcCmdUpdate({ id, tenantId, name, type, configJson, enabled: enabled ? 1 : 0, now }));

    return this.getById(id, tenantId);
  }

  getById(id: string, tenantId: string): KnowledgeSourceRecord | null {
    const row = this.tx.queryOne(ksrcQueryById({ id, tenantId }));
    return row ? rowToRecord(row) : null;
  }

  listByTenant(tenantId: string, limit: number, offset: number): { sources: KnowledgeSourceRecord[]; total: number } {
    const rows = this.tx.queryMany(ksrcQueryList({ tenantId, limit, offset })) as unknown as KsrcRow[];
    const countRow = this.tx.queryOne(ksrcQueryCount(tenantId));
    return {
      sources: rows.map(rowToRecord),
      total: countRow?.count ?? 0,
    };
  }

  listEnabledByIds(tenantId: string, ids: string[]): KnowledgeSourceRecord[] {
    if (ids.length === 0) return [];
    const rows = this.tx.queryMany(ksrcQueryEnabledByIds({ tenantId, ids })) as unknown as KsrcRow[];
    return rows.map(rowToRecord);
  }

  updateState(id: string, stateJson: string | null, lastIngestedAt: number): void {
    this.tx.execute(ksrcCmdUpdateState({ id, stateJson, lastIngestedAt, now: Date.now() }));
  }

  delete(id: string, tenantId: string): boolean {
    const result = this.tx.execute(ksrcCmdDelete({ id, tenantId }));
    return result.rowsAffected > 0;
  }
}
