/**
 * 隐私与数据合规 Application Service
 * 封装 GDPR 数据导出与擦除的业务逻辑
 */

import type { ChronoSynthOS } from '../chrono-synth-os.js';
import type { AppConfig } from '../config/schema.js';
import type { IDatabase, SqlValue } from '../storage/database.js';
import type { TenantOSFactory } from '../multi-tenant/tenant-os-factory.js';
import { FieldEncryption } from '../storage/encryption.js';
import { TenantEnterpriseProfileService } from '../enterprise/tenant-enterprise-profile-service.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { compilePersonaState } from '../intelligence/persona-state.js';
import { countAuditLogs, queryAuditLog } from '../audit/audit-log-store.js';

/** 直接按 tenant_id 查询的表（外键依赖顺序：子表在前） */
const TENANT_TABLES = [
  'tenant_enterprise_profiles',
  'organization_role_bindings', 'organization_memberships', 'workspaces', 'organizations',
  'usage_meters', 'billing_invoices',
  'settlement_reconciliation_runs',
  'persona_memory_edges', 'persona_working_memory', 'persona_memory_nodes',
  'runtime_sessions', 'task_results', 'task_assignments', 'task_applications',
  'governance_actions', 'governance_cases',
  'wallet_transactions', 'wallet_payout_requests', 'wallet_settlements',
  'persona_transfers', 'reputation_history',
  'persona_daily_metrics', 'marketplace_daily_metrics',
  'persona_governance_events', 'persona_growth_events',
  'persona_memories', 'persona_knowledge_items',
  'marketplace_tasks', 'persona_forks', 'persona_wallets', 'persona_core',
  'decision_feedbacks', 'decision_runs', 'decision_cases',
  'onboarding_sessions', 'llm_usage',
  'life_simulations',
  'memory_edges', 'memory_embeddings', 'working_memory', 'memory_nodes',
  'pending_updates',
  'core_values', 'survival_anchors', 'persona_versions', 'conflicts',
  'snapshots', 'evolution_records',
  'narrative', 'decision_style', 'cognitive_model',
  'tasks', 'quota_usage', 'quota_limits',
  'usage_records', 'subscriptions',
  'idempotency_keys',
  'platform_dlq_events',
  'avatar_autorun_runlog', 'avatar_autorun_config', 'knowledge_sources',
  'audit_log',
] as const;

/** 需要子查询关联的表 */
const RELATED_TABLES: Array<{
  name: string;
  exportSql: string;
  deleteSql: string;
  params: (tenantId: string) => SqlValue[];
}> = [
  {
    name: 'life_simulation_paths',
    exportSql: 'SELECT p.* FROM life_simulation_paths p INNER JOIN life_simulations s ON p.simulation_id = s.id WHERE s.tenant_id = ?',
    deleteSql: 'DELETE FROM life_simulation_paths WHERE simulation_id IN (SELECT id FROM life_simulations WHERE tenant_id = ?)',
    params: (t) => [t],
  },
  {
    name: 'shared_simulations',
    exportSql: 'SELECT * FROM shared_simulations WHERE simulation_id IN (SELECT id FROM life_simulations WHERE tenant_id = ?) OR owner_user_id IN (SELECT id FROM users WHERE tenant_id = ?) OR shared_with_user_id IN (SELECT id FROM users WHERE tenant_id = ?)',
    deleteSql: 'DELETE FROM shared_simulations WHERE simulation_id IN (SELECT id FROM life_simulations WHERE tenant_id = ?) OR owner_user_id IN (SELECT id FROM users WHERE tenant_id = ?) OR shared_with_user_id IN (SELECT id FROM users WHERE tenant_id = ?)',
    params: (t) => [t, t, t],
  },
  {
    name: 'refresh_tokens',
    exportSql: 'SELECT id, user_id, is_revoked, expires_at, created_at FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)',
    deleteSql: 'DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)',
    params: (t) => [t],
  },
  {
    name: 'users',
    exportSql: 'SELECT id, email, role, tenant_id, created_at, updated_at FROM users WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM users WHERE tenant_id = ?',
    params: (t) => [t],
  },
];

const POST_TENANT_RELATED_TABLES: Array<{
  name: string;
  exportSql: string;
  deleteSql: string;
  params: (tenantId: string) => SqlValue[];
}> = [
  {
    name: 'device_avatars',
    exportSql: 'SELECT da.* FROM device_avatars da INNER JOIN devices d ON d.id = da.device_id WHERE d.tenant_id = ?',
    deleteSql: 'DELETE FROM device_avatars WHERE device_id IN (SELECT id FROM devices WHERE tenant_id = ?)',
    params: (t) => [t],
  },
  {
    name: 'avatars',
    exportSql: 'SELECT a.* FROM avatars a INNER JOIN identities i ON i.id = a.identity_id WHERE i.tenant_id = ?',
    deleteSql: 'DELETE FROM avatars WHERE identity_id IN (SELECT id FROM identities WHERE tenant_id = ?)',
    params: (t) => [t],
  },
  {
    name: 'identities',
    exportSql: 'SELECT * FROM identities WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM identities WHERE tenant_id = ?',
    params: (t) => [t],
  },
  {
    name: 'devices',
    exportSql: 'SELECT * FROM devices WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM devices WHERE tenant_id = ?',
    params: (t) => [t],
  },
];

const TENANT_TABLE_SET: ReadonlySet<string> = new Set(TENANT_TABLES);

function safeDelete(db: IDatabase, table: string, tenantId: string): number {
  if (!TENANT_TABLE_SET.has(table)) return 0;
  try {
    return db.prepare<void>(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId).changes;
  } catch {
    return 0;
  }
}

function safeDeleteQuery(db: IDatabase, sql: string, params: SqlValue[]): number {
  try {
    return db.prepare<void>(sql).run(...params).changes;
  } catch {
    return 0;
  }
}

function exportTable(db: IDatabase, table: string, tenantId: string): unknown[] {
  if (!TENANT_TABLE_SET.has(table)) return [];
  try {
    return db.prepare<Record<string, unknown>>(`SELECT * FROM ${table} WHERE tenant_id = ?`).all(tenantId);
  } catch {
    return [];
  }
}

function exportQuery(db: IDatabase, sql: string, params: SqlValue[]): unknown[] {
  try {
    return db.prepare<Record<string, unknown>>(sql).all(...params);
  } catch {
    return [];
  }
}

function decryptIfNeeded(encryption: FieldEncryption | undefined, value: unknown): unknown {
  if (!encryption || typeof value !== 'string') return value;
  try {
    return encryption.decrypt(value);
  } catch {
    return value;
  }
}

function transformExportRows(table: string, rows: unknown[], encryption: FieldEncryption | undefined): unknown[] {
  if (!encryption) return rows;
  if (table === 'memory_nodes') {
    return rows.map((row) => {
      const next = { ...(row as Record<string, unknown>) };
      next.content = decryptIfNeeded(encryption, next.content);
      return next;
    });
  }
  if (table === 'persona_memory_nodes') {
    return rows.map((row) => {
      const next = { ...(row as Record<string, unknown>) };
      next.content = decryptIfNeeded(encryption, next.content);
      return next;
    });
  }
  if (table === 'persona_memories') {
    return rows.map((row) => {
      const next = { ...(row as Record<string, unknown>) };
      if (next.is_encrypted) {
        next.summary = decryptIfNeeded(encryption, next.summary);
        next.content_json = decryptIfNeeded(encryption, next.content_json);
      }
      return next;
    });
  }
  return rows;
}

export class PrivacyService {
  private readonly profileService: TenantEnterpriseProfileService | undefined;
  private readonly fallbackEncryption: FieldEncryption | undefined;

  constructor(
    private readonly os: ChronoSynthOS,
    private readonly tenantFactory: TenantOSFactory | undefined,
    config?: AppConfig,
  ) {
    const db = os.getDatabase();
    this.profileService = config ? new TenantEnterpriseProfileService(db, config) : undefined;
    this.fallbackEncryption = config?.encryption.enabled ? new FieldEncryption(config.encryption) : undefined;
  }

  private getOS(tenantId: string): ChronoSynthOS {
    if (this.tenantFactory && tenantId !== 'default') return this.tenantFactory.getTenantOS(tenantId);
    return this.os;
  }

  private getEncryption(tenantId: string): FieldEncryption | undefined {
    return this.profileService?.getTenantEncryption(tenantId) ?? this.fallbackEncryption;
  }

  exportData(tenantId: string) {
    const exportId = generatePrefixedId('exp');
    const db = this.os.getDatabase();
    const tenantOS = this.getOS(tenantId);
    const persona = compilePersonaState(tenantOS.core);
    const encryption = this.getEncryption(tenantId);

    const tables: Record<string, unknown[]> = {};
    for (const table of TENANT_TABLES) {
      const rows = transformExportRows(table, exportTable(db, table, tenantId), encryption);
      if (rows.length > 0) tables[table] = rows;
    }
    for (const rel of RELATED_TABLES) {
      const rows = transformExportRows(rel.name, exportQuery(db, rel.exportSql, rel.params(tenantId)), encryption);
      if (rows.length > 0) tables[rel.name] = rows;
    }
    for (const rel of POST_TENANT_RELATED_TABLES) {
      const rows = transformExportRows(rel.name, exportQuery(db, rel.exportSql, rel.params(tenantId)), encryption);
      if (rows.length > 0) tables[rel.name] = rows;
    }

    return {
      exportId,
      tenantId,
      format: 'json' as const,
      exportedAt: tenantOS.getClock().now(),
      content: {
        persona: {
          L0: persona.L0,
          L1: [...persona.L1.values()],
          L2: persona.L2,
          L3: {
            beliefs: Object.fromEntries(persona.L3.beliefs),
            biasWeights: Object.fromEntries(persona.L3.biasWeights),
            attributionStyle: persona.L3.attributionStyle,
            growthMindset: persona.L3.growthMindset,
          },
          L4: {
            narrative: persona.L4.narrative,
            memoryCount: persona.L4.memories.size,
          },
        },
        tables,
      },
    };
  }

  eraseData(tenantId: string) {
    const db = this.os.getDatabase();
    const deletedCounts: Record<string, number> = {};

    db.transaction(() => {
      for (const rel of RELATED_TABLES) {
        const count = safeDeleteQuery(db, rel.deleteSql, rel.params(tenantId));
        if (count > 0) deletedCounts[rel.name] = count;
      }
      for (const table of TENANT_TABLES) {
        const count = safeDelete(db, table, tenantId);
        if (count > 0) deletedCounts[table] = count;
      }
      for (const rel of POST_TENANT_RELATED_TABLES) {
        const count = safeDeleteQuery(db, rel.deleteSql, rel.params(tenantId));
        if (count > 0) deletedCounts[rel.name] = count;
      }
    });

    if (this.tenantFactory) {
      this.tenantFactory.evict(tenantId);
    }

    return {
      deleted: true,
      tenantId,
      timestamp: this.os.getClock().now(),
      tablesAffected: deletedCounts,
    };
  }

  getAuditTrail(tenantId: string, page: number, pageSize: number) {
    const offset = (page - 1) * pageSize;
    const db = this.os.getDatabase();
    const total = countAuditLogs(db, { tenantId, eventKind: 'all' });
    const rows = queryAuditLog(db, {
      tenantId,
      eventKind: 'all',
      limit: pageSize,
      offset,
    });
    return {
      data: rows,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1 },
    };
  }
}
