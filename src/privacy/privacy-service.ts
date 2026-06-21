/**
 * 隐私与数据合规 Application Service
 * 封装 GDPR 数据导出与擦除的业务逻辑
 */

import { createHash, randomBytes } from 'node:crypto';
import type { ChronoSynthOS } from '../chrono-synth-os.js';
import type { AppConfig } from '../config/schema.js';
import type { IDatabase, SqlValue } from '../storage/database.js';
import type { TenantOSFactory } from '../multi-tenant/tenant-os-factory.js';
import { FieldEncryption } from '../storage/encryption.js';
import { TenantEnterpriseProfileService } from '../enterprise/tenant-enterprise-profile-service.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { compilePersonaState } from '../intelligence/persona-state.js';
import { countAuditLogs, queryAuditLog } from '../audit/audit-log-store.js';
import {
  PortabilityPackManifestV1Schema,
  ExportJobStatusV1Schema,
} from '@chrono/contracts';
import type { ExportJobStatusV1, ImportCommitResultV1, ImportDryRunReportV1 } from '@chrono/contracts';
import { buildPortabilityPack } from './export-pack-builder.js';
import {
  createExportJob,
  updateExportJob,
  getExportJob,
  listExportJobs as listExportJobRows,
} from './export-job-store.js';
import { createImportTokenStore, type ImportTokenStore } from './import-token-store.js';
import { LegalHoldService } from './legal-hold-service.js';
import { createObjectStorageClient, createTenantObjectStorageClient } from './object-storage-client.js';
import type { ObjectStorageClient } from './object-storage-client.js';

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
  /* ADR-0047/0048：蒸馏工件、并发租约、响应模板、规则均为 tenant/persona 数据，须随租户导出/擦除 */
  'distilled_artifacts', 'persona_leases', 'response_templates', 'persona_rules',
  /* GDPR 补齐（A 类：标准业务/配置/派生数据，无敏感凭证列，无保留义务） */
  /* tenant_llm_settings：BYOK active provider 偏好，非 secret 配置（key 在 llm_provider_credentials B 类） */
  'tenant_llm_settings',
  /* perception_events：感知行为审计（哈希+计数+元数据，无敏感列；表征原文不落库），A 类标准导出+擦除 */
  'perception_events',
  /* persona_governance_policy：per-persona 治理策略覆盖（categoryRoutes/AML/预算，非 secret 配置），A 类 */
  'persona_governance_policy',
  /* proactive_messages：ADR-0054 主动消息 outbound 队列（确定性文本+信号溯源，无敏感列），A 类标准导出+擦除 */
  'proactive_messages',
  /* notification_preferences：ADR-0054 红线9 per-user 推送同意+安静时段（非 secret 配置），A 类 */
  'notification_preferences',
  /* companion_identity：ADR-0055 数字人第一人称身份（name，per-persona，无敏感列），A 类标准导出+擦除 */
  'companion_identity',
  /* memory_translations：ADR-0055 记忆内容多语变体（无敏感列，随 memory 级联），A 类标准导出+擦除 */
  'memory_translations',
  /* companion_mood：ADR-0056 数字人当前心情（valence/arousal，per-persona，无敏感列），A 类标准导出+擦除 */
  'companion_mood',
  /* companion_relationship：ADR-0056 我-你关系（用户名/互动次数/时间戳，per-persona），A 类标准导出+擦除 */
  'companion_relationship',
  /* digital workforce M1：数字员工组织（岗位/员工/汇报/目标/任务/汇报，业务派生），A 类标准导出+擦除 */
  'org_positions', 'digital_workers', 'reporting_edges', 'org_goals', 'org_tasks', 'task_reports',
  /* digital workforce B1：数字员工协作（线程/消息，业务派生），A 类标准导出+擦除 */
  'org_conversation_threads', 'org_messages',
  /* digital workforce B2：任务 handoff（交接协商，业务派生），A 类标准导出+擦除 */
  'org_handoffs',
  'billing_outbox', 'ws_event_log', 'tenant_add_ons', 'entitlements',
  'observability_outbox', 'observability_rollups', 'observability_processed_events',
  'event_ledger', 'persona_core_ledger_outbox', 'projection_store', 'conflict_inbox',
  'import_jobs', 'tenant_key_versions', 'tenant_storage_bindings', 'drift_analysis_log',
  'persona_templates', 'bulk_knowledge_import_jobs', 'conversation_messages',
  'events_user_journey', 'core_values_snapshot',
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
  /* ── GDPR 补齐（B 类：含凭证/令牌/校验列，导出脱敏；擦除照常 WHERE tenant_id） ── */
  {
    /* api_keys.key_hash 是凭证校验材料，导出省略 */
    name: 'api_keys',
    exportSql: 'SELECT id, tenant_id, plan_id, is_revoked, created_at FROM api_keys WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM api_keys WHERE tenant_id = ?',
    params: (t) => [t],
  },
  {
    /* import_commit_tokens.token 是单次提交 bearer，导出省略 */
    name: 'import_commit_tokens',
    exportSql: 'SELECT tenant_id, import_id, manifest_checksum, expires_at, created_at FROM import_commit_tokens WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM import_commit_tokens WHERE tenant_id = ?',
    params: (t) => [t],
  },
  {
    /* user_oauth_tokens：access/refresh token 加密列必须省略，仅导出元数据 */
    name: 'user_oauth_tokens',
    exportSql: 'SELECT id, tenant_id, user_id, provider, scope, access_expires_at, granted_at, updated_at, revoked_at, revocation_reason FROM user_oauth_tokens WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM user_oauth_tokens WHERE tenant_id = ?',
    params: (t) => [t],
  },
  {
    /* llm_provider_credentials.api_key_encrypted 是 BYOK 密钥密文，导出省略，仅导出元数据（BYOK）*/
    name: 'llm_provider_credentials',
    exportSql: 'SELECT tenant_id, provider, created_by, created_at, updated_at FROM llm_provider_credentials WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM llm_provider_credentials WHERE tenant_id = ?',
    params: (t) => [t],
  },
  {
    /* perception_media_refs.object_key 能定位对象存储中的原始媒体（最敏 PII），导出省略 object_key，
     * 仅导出脱敏元数据（ADR-0052 Edge-P5）。
     *
     * GDPR 擦除（Codex Edge-P5 复审 — Art.17 对象存储闭环）：**不直接 DELETE 引用行**（否则 object_key
     * 随行丢失，对象存储里的原始媒体成为无法定位的孤儿，违反「被遗忘权」）。改为**标记 erased +
     * delete_after=0**（立即过期）——保留 object_key，由 retention worker（runMediaRetention）异步删
     * 对象存储对象 + 删引用行，达成「原始媒体最终被删」的合规闭环。privacy 同步擦除不阻塞、对象删除
     * 最终一致。erased tombstone 不含 PII（只剩待删 object_key + 脱敏元数据），导出已脱敏不泄露。 */
    name: 'perception_media_refs',
    exportSql: 'SELECT id, tenant_id, sha256, mime, size_bytes, duration_ms, retention_class, delete_after, status, created_at FROM perception_media_refs WHERE tenant_id = ?',
    deleteSql: "UPDATE perception_media_refs SET status = 'erased', delete_after = 0 WHERE tenant_id = ?",
    params: (t) => [t],
  },
  {
    /* tool_permissions.revocation_key 是带外撤销 bearer，导出省略 */
    name: 'tool_permissions',
    exportSql: 'SELECT id, tenant_id, persona_id, tool_id, scope, constraints_json, granted_by, granted_at, expires_at, revoked_at, revocation_reason FROM tool_permissions WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM tool_permissions WHERE tenant_id = ?',
    params: (t) => [t],
  },
  {
    /* agency_authorizations.revocation_key 同上，导出省略 */
    name: 'agency_authorizations',
    exportSql: 'SELECT id, tenant_id, persona_id, principal_user_id, scope, scope_description, allowed_tools_json, denied_tools_json, status, granted_at, expires_at, revoked_at, revocation_reason FROM agency_authorizations WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM agency_authorizations WHERE tenant_id = ?',
    params: (t) => [t],
  },
  {
    /* tool_invocations.input_hash 是校验材料、confirmation_token_id 关联 bearer，导出省略 */
    name: 'tool_invocations',
    exportSql: 'SELECT id, tenant_id, persona_id, tool_id, invoker_type, invoker_id, status, output_size_bytes, error_message, cost_cents, duration_ms, invoked_at, completed_at, invoker_user_id FROM tool_invocations WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM tool_invocations WHERE tenant_id = ?',
    params: (t) => [t],
  },
  {
    /* conversation_confirmation_tokens.id 是 bearer token、input_hash 是校验材料，导出省略 */
    name: 'conversation_confirmation_tokens',
    exportSql: 'SELECT tenant_id, persona_id, session_id, external_user_id, requested_topic, requested_rule, issued_at, expires_at, consumed_at FROM conversation_confirmation_tokens WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM conversation_confirmation_tokens WHERE tenant_id = ?',
    params: (t) => [t],
  },
  {
    /* export_jobs：download_url 可能是签名 bearer URL、pack_json 是临时导出产物，导出省略 */
    name: 'export_jobs',
    exportSql: 'SELECT id, tenant_id, state, percent, eta_ms, created_at, completed_at, error_code, warnings FROM export_jobs WHERE tenant_id = ?',
    deleteSql: 'DELETE FROM export_jobs WHERE tenant_id = ?',
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

/**
 * C 类：保留豁免表（GDPR Art.17(3)(b)：为遵守法律义务/审计完整性而保留）。
 * **从不擦除**——擦除会破坏审计链完整性、移除法律/合规证据或瓦解 legal hold。
 * 导出按需：含个人数据的审计记录数据主体有知情权（exportSql 给出）；纯系统完整性
 * 数据（hash chain 锚点）不入 DSAR 导出（exportSql = null）。
 *
 * ⚠️ 这些表的 erase 豁免不等于「数据主体无删除权」——而是删除权让位于更高位的法律
 * 义务（审计/诉讼保留）。逐表理由见 .claude/context-gdpr-tables.json 的 retentionBasis。
 */
const RETENTION_EXEMPT_TABLES: Array<{ name: string; exportSql: string | null }> = [
  /* KMS 密钥操作审计——安全问责记录，保留 */
  { name: 'kms_key_audit', exportSql: 'SELECT * FROM kms_key_audit WHERE tenant_id = ?' },
  /* 租户保险库操作审计——BYOK/BYOS 访问问责，保留 */
  { name: 'tenant_vault_audit', exportSql: 'SELECT * FROM tenant_vault_audit WHERE tenant_id = ?' },
  /* SOC2 合规证据——审计保留 + 完整性校验，保留 */
  { name: 'compliance_evidence', exportSql: 'SELECT * FROM compliance_evidence WHERE tenant_id = ?' },
  /* legal hold 登记表——存在目的就是阻止删除，擦除它将瓦解 hold，保留 */
  { name: 'legal_holds', exportSql: 'SELECT * FROM legal_holds WHERE tenant_id = ?' },
  /* 紧急 break-glass token 消费台账——安全审计 + 重放防护，保留 */
  { name: 'break_glass_jti_consumptions', exportSql: 'SELECT * FROM break_glass_jti_consumptions WHERE tenant_id = ?' },
  /* 审计 hash-chain 锚点——擦除破坏防篡改完整性；纯系统数据不导出，保留 */
  { name: 'audit_chain_anchors', exportSql: null },
  /* 审计 hash-chain 锚定失败证据——同上完整性监控，保留 */
  { name: 'audit_chain_anchor_failures', exportSql: null },
];

/**
 * 隐私导出/擦除覆盖的全部表名（直查 + 子查询关联 + 后置关联）。
 * 导出供完整性 guard 测试：断言每张 tenant-scoped DSL 表都在此集合中，
 * 防止新增表悄悄漏掉导出/擦除（GDPR 数据生命周期）。注意 RETENTION_EXEMPT 表
 * 单独登记（保留不擦除），不计入「会被擦除」的 covered 集。
 */
export const PRIVACY_COVERED_TABLES: ReadonlySet<string> = new Set<string>([
  ...TENANT_TABLES,
  ...RELATED_TABLES.map((r) => r.name),
  ...POST_TENANT_RELATED_TABLES.map((r) => r.name),
]);

/** C 类保留豁免表名（导出可能有，擦除一定没有）。供 ratchet 测试承认。 */
export const PRIVACY_RETENTION_EXEMPT_TABLES: ReadonlySet<string> = new Set<string>(
  RETENTION_EXEMPT_TABLES.map((r) => r.name),
);

/** eraseData 结果（判别联合）：blocked=true 表示 active legal hold 阻断、零删除。 */
export type EraseResult =
  | { deleted: true; blocked: false; tenantId: string; timestamp: number; tablesAffected: Record<string, number> }
  | { deleted: false; blocked: true; tenantId: string; timestamp: number; reason: string; blockingHoldId: string; tablesAffected: Record<string, number> };

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/* GDPR fail-closed（Art.17 擦除 / Art.20 导出）：删除/导出失败**绝不**静默吞成「0 行 / 空集」。
 * 旧实现 `catch { return 0 }` 会把 DELETE 抛错当成「删了 0 行」，事务照常提交，eraseData
 * 误报 deleted:true——用户被告知数据已删，实则未删。改为让 SQL 错误**向上抛**：擦除事务因此
 * 回滚、对外暴露失败；导出同理（导出失败 ≠ 该表为空，否则用户行权失败却拿到「成功的空导出」）。
 *
 * 仍保留的「非租户表 → 返回 0/[]」是**合法跳过**（白名单守卫，不是错误吞咽）：调用方按固定表清单
 * 迭代，这里只是拒绝越界表名，不触及任何 SQL 执行。 */
/** 在当前事务内把 FK 检查推迟到 COMMIT（方言感知）。全租户擦除最终 FK 自洽，删除途中中间态不必满足 FK。 */
function deferForeignKeys(db: IDatabase): void {
  db.exec(db.dialect === 'postgres' ? 'SET CONSTRAINTS ALL DEFERRED' : 'PRAGMA defer_foreign_keys=ON');
}

function eraseDelete(db: IDatabase, table: string, tenantId: string): number {
  if (!TENANT_TABLE_SET.has(table)) return 0;
  return db.prepare<void>(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId).changes;
}

function eraseDeleteQuery(db: IDatabase, sql: string, params: SqlValue[]): number {
  return db.prepare<void>(sql).run(...params).changes;
}

function exportTable(db: IDatabase, table: string, tenantId: string): unknown[] {
  if (!TENANT_TABLE_SET.has(table)) return [];
  return db.prepare<Record<string, unknown>>(`SELECT * FROM ${table} WHERE tenant_id = ?`).all(tenantId);
}

function exportQuery(db: IDatabase, sql: string, params: SqlValue[]): unknown[] {
  return db.prepare<Record<string, unknown>>(sql).all(...params);
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
  /** 平台签名密钥，用于 HMAC-SHA256 包签名 */
  private readonly signingKey: string;
  private readonly objectStorage: ObjectStorageClient;
  private readonly presignTtlSeconds: number;
  private readonly importTokenStore: ImportTokenStore;
  private readonly config: AppConfig | undefined;

  constructor(
    private readonly os: ChronoSynthOS,
    private readonly tenantFactory: TenantOSFactory | undefined,
    config?: AppConfig,
    objectStorage?: ObjectStorageClient,
    importTokenStore?: ImportTokenStore,
  ) {
    const db = os.getDatabase();
    this.config = config;
    this.importTokenStore = importTokenStore ?? createImportTokenStore(db);
    this.profileService = config ? new TenantEnterpriseProfileService(db, config) : undefined;
    this.fallbackEncryption = config?.encryption.enabled ? new FieldEncryption(config.encryption) : undefined;
    this.signingKey = config?.encryption.masterKey ?? 'change-me-in-production-32chars!';
    this.presignTtlSeconds = config?.objectStorage.presignTtlSeconds ?? 3600;
    // 允许注入自定义客户端（用于测试），否则从配置创建；无配置时退回 local 默认
    if (objectStorage) {
      this.objectStorage = objectStorage;
    } else if (config) {
      this.objectStorage = createObjectStorageClient(config);
    } else {
      this.objectStorage = createObjectStorageClient({
        objectStorage: {
          provider: 'local',
          localPath: '/tmp/chrono-exports',
          presignTtlSeconds: 3600,
          s3Bucket: '', s3Region: '', s3Endpoint: '', s3AccessKeyId: '', s3SecretAccessKey: '',
          gcsBucket: '', gcsProjectId: '', gcsKeyFile: '',
          azureConnectionString: '', azureContainer: '',
        },
      });
    }
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
    /* C 类保留豁免：导出（数据主体知情权）但绝不擦除；纯系统完整性表 exportSql=null 跳过 */
    for (const ex of RETENTION_EXEMPT_TABLES) {
      if (!ex.exportSql) continue;
      const rows = transformExportRows(ex.name, exportQuery(db, ex.exportSql, [tenantId]), encryption);
      if (rows.length > 0) tables[ex.name] = rows;
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
            ambiguityTolerance: persona.L3.ambiguityTolerance,
            analyticalIntuitive: persona.L3.analyticalIntuitive,
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

  eraseData(tenantId: string): EraseResult {
    const db = this.os.getDatabase();

    /* GDPR Art.17(3)(b)：active legal hold（诉讼/监管保留）期间禁止删除该租户数据。
     * 保守语义（findBlockingHold）：任一 active hold 即阻断整租户擦除——宁可不删，不可
     * 误删受保留义务保护的数据。否则会出现「保留了 legal_holds 表却删掉它要保护的数据」
     * 的自相矛盾。需先释放 hold 才能擦除。 */
    const blockingHold = new LegalHoldService(db).findBlockingHold(tenantId, 'tenant', null);
    if (blockingHold) {
      return {
        deleted: false,
        blocked: true as const,
        tenantId,
        timestamp: this.os.getClock().now(),
        reason: `legal hold active: ${blockingHold.id} on ${blockingHold.subject}${blockingHold.subjectId ? ':' + blockingHold.subjectId : ''} (${blockingHold.reason})`,
        blockingHoldId: blockingHold.id,
        tablesAffected: {} as Record<string, number>,
      };
    }

    const deletedCounts: Record<string, number> = {};

    /* fail-closed：任一 DELETE 抛错 → 事务回滚 + 错误向上抛，eraseData 绝不误报 deleted:true。
     * 全擦除是一个原子操作：要么全删成功，要么整体回滚由调用方处理（HTTP 层返回 5xx + 审计失败）。
     *
     * defer_foreign_keys：全租户擦除是「整租户数据全删」，最终状态 FK 自洽（父子全没），但**删除途中**
     * 的中间状态会瞬时违反 FK（删父表时子表还在）。把 FK 校验推迟到 COMMIT 时统一检查——这样删除顺序
     * 无需手工维护成完美拓扑序，而真正的孤儿/残留仍会在 COMMIT 时被 FK 拦截（不牺牲完整性，仍 fail-closed）。
     * 仅在本事务内生效，COMMIT/ROLLBACK 后自动复位。 */
    db.transaction(() => {
      /* 延迟 FK 检查到 COMMIT，跨方言（Codex ② 复审：privacy 服务用 IDatabase，存在 PostgresDatabase，
       * SQLite PRAGMA 在 PG 下会语法失败）。SQLite: PRAGMA defer_foreign_keys=ON（事务级，COMMIT 后自动复位）；
       * Postgres: SET CONSTRAINTS ALL DEFERRED（仅对 DEFERRABLE 约束生效，本事务内有效）。 */
      deferForeignKeys(db);
      for (const rel of RELATED_TABLES) {
        const count = eraseDeleteQuery(db, rel.deleteSql, rel.params(tenantId));
        if (count > 0) deletedCounts[rel.name] = count;
      }
      for (const table of TENANT_TABLES) {
        const count = eraseDelete(db, table, tenantId);
        if (count > 0) deletedCounts[table] = count;
      }
      for (const rel of POST_TENANT_RELATED_TABLES) {
        const count = eraseDeleteQuery(db, rel.deleteSql, rel.params(tenantId));
        if (count > 0) deletedCounts[rel.name] = count;
      }
    });

    if (this.tenantFactory) {
      this.tenantFactory.evict(tenantId);
    }

    return {
      deleted: true,
      blocked: false as const,
      tenantId,
      timestamp: this.os.getClock().now(),
      tablesAffected: deletedCounts,
    };
  }

  getAuditTrail(tenantId: string, page: number, pageSize: number) {
    const offset = (page - 1) * pageSize;
    const tx = this.os.getDatabase();
    const total = countAuditLogs(tx, { tenantId, eventKind: 'all' });
    const rows = queryAuditLog(tx, {
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

  /**
   * 启动异步导出任务，立即返回 queued 状态；实际导出在 setImmediate 中执行
   */
  startExportJob(tenantId: string): ExportJobStatusV1 {
    const db = this.os.getDatabase();
    const now = this.os.getClock().now();
    const jobId = createExportJob(db, tenantId, now);

    // Resolve per-tenant BYOS storage client and BYOK signing key
    const tenantProfile = this.profileService?.getProfile(tenantId);
    const effectiveStorage = tenantProfile && this.config
      ? createTenantObjectStorageClient(
          { provider: tenantProfile.byosProvider ?? 'platform', bucket: tenantProfile.byosBucket, keyPrefix: tenantProfile.byosKeyPrefix },
          this.config,
        )
      : this.objectStorage;
    const effectiveSigningKey = tenantProfile?.encryptionMode === 'tenant_dedicated' && tenantProfile.kmsKeyRef
      ? tenantProfile.kmsKeyRef
      : this.signingKey;

    // 异步执行实际导出逻辑
    void (async () => {
      try {
        updateExportJob(db, jobId, { state: 'running', percent: 10 });

        const exportResult = this.exportData(tenantId);
        const { manifest, payloads: payloadNdjsons, rawManifestJson } = buildPortabilityPack(exportResult, effectiveSigningKey);

        // 将 NDJSON 字符串解析回行数组，便于 commitImport 直接读取
        const payloadRows: Record<string, unknown[]> = {};
        for (const [path, ndjson] of Object.entries(payloadNdjsons)) {
          const tableName = path.replace(/^payloads\//, '').replace(/\.ndjson$/, '');
          payloadRows[tableName] = ndjson.trim() ? ndjson.split('\n').map((line) => JSON.parse(line) as unknown) : [];
        }

        // 打包为捆绑格式：manifest + 行数据，一起存入 pack_json
        const bundledPack = JSON.stringify({ manifest, payloads: payloadRows });

        // 上传 manifest JSON（外部可下载）到对象存储
        const packBuffer = Buffer.from(rawManifestJson, 'utf-8');
        const keyPrefix = tenantProfile?.byosKeyPrefix?.trim() ? `${tenantProfile.byosKeyPrefix.trim()}/` : '';
        const objectKey = `${keyPrefix}exports/${tenantId}/${jobId}.pack.json`;
        await effectiveStorage.upload(objectKey, packBuffer, 'application/json');
        const downloadUrl = await effectiveStorage.presignUrl(objectKey, this.presignTtlSeconds);

        const completedAt = this.os.getClock().now();
        updateExportJob(db, jobId, {
          state: 'completed',
          percent: 100,
          completed_at: completedAt,
          download_url: downloadUrl,
          pack_json: bundledPack,
        });
      } catch (err) {
        /* 导出失败 fail-closed：任务标记 failed（经 getExportJobStatus 对用户可见），并记录原因便于排障。
         * 不再静默——导出失败必须可诊断，否则数据主体行权失败却无从追因。 */
        this.os.getLogger().error('PrivacyService', `导出任务失败: ${jobId} — ${err instanceof Error ? err.message : String(err)}`);
        const completedAt = this.os.getClock().now();
        updateExportJob(db, jobId, {
          state: 'failed',
          completed_at: completedAt,
          error_code: 'EXPORT_FAILED',
        });
      }
    })();

    const createdAtIso = new Date(now).toISOString();
    return ExportJobStatusV1Schema.parse({
      schemaVersion: 'export-job-status.v1',
      exportId: jobId,
      state: 'queued',
      percent: 0,
      createdAt: createdAtIso,
      warnings: [],
    });
  }

  /**
   * 查询指定导出任务的当前状态
   */
  getExportJobStatus(tenantId: string, exportId: string): ExportJobStatusV1 | null {
    const db = this.os.getDatabase();
    const row = getExportJob(db, exportId);
    if (!row || row.tenant_id !== tenantId) return null;
    return this.rowToJobStatus(row);
  }

  /**
   * 列出租户的全部导出任务
   */
  listExportJobs(tenantId: string): ExportJobStatusV1[] {
    const db = this.os.getDatabase();
    const rows = listExportJobRows(db, tenantId);
    return rows.map((row) => this.rowToJobStatus(row));
  }

  /**
   * 将捆绑包 JSON 或纯 manifest JSON 解析为 manifest 对象。
   * 捆绑格式：{ manifest: {...}, payloads: {...} }
   * 旧格式：直接为 PortabilityPackManifestV1 对象
   */
  private extractManifestJson(packJson: string): string {
    try {
      const parsed = JSON.parse(packJson) as unknown;
      if (parsed !== null && typeof parsed === 'object' && 'manifest' in (parsed as object)) {
        return JSON.stringify((parsed as { manifest: unknown }).manifest);
      }
    } catch {
      // fall through
    }
    return packJson;
  }

  /**
   * 对导入包清单执行 dry-run 验证，返回报告（不写入任何数据）
   */
  dryRunImport(tenantId: string, packManifestJson: string): ImportDryRunReportV1 {
    const importId = generatePrefixedId('import');

    const manifestJson = this.extractManifestJson(packManifestJson);

    const parseResult = PortabilityPackManifestV1Schema.safeParse(
      (() => {
        try { return JSON.parse(manifestJson) as unknown; } catch { return null; }
      })(),
    );

    if (!parseResult.success) {
      return {
        schemaVersion: 'import-dryrun.v1',
        importId,
        packSchemaVersion: 'unknown',
        signatureValid: false,
        blockers: [{ code: 'INVALID_MANIFEST', messageId: 'import.error.invalidManifest' }],
        warnings: [],
        deltaSummary: {},
        estimatedDurationMs: 0,
        canCommit: false,
      };
    }

    const manifest = parseResult.data;
    const blockers: Array<{ code: string; messageId: string; entity?: string }> = [];
    const warnings: Array<{ code: string; messageId: string; entity?: string }> = [];

    // 验证 tenantId 匹配
    if (manifest.tenant.tenantId !== tenantId) {
      blockers.push({
        code: 'TENANT_MISMATCH',
        messageId: 'import.error.tenantMismatch',
        entity: manifest.tenant.tenantId,
      });
    }

    // 检查签名算法
    if (manifest.integrity.signatureAlgorithm !== 'hmac-sha256') {
      warnings.push({
        code: 'UNSUPPORTED_SIGNATURE_ALG',
        messageId: 'import.warning.unsupportedSignatureAlg',
        entity: manifest.integrity.signatureAlgorithm,
      });
    }

    // 构建 deltaSummary（每个 required payload 条目视为待创建）
    const deltaSummary: Record<string, { create: number; update: number; skip: number }> = {};
    for (const entry of manifest.payloads) {
      if (entry.required) {
        deltaSummary[entry.logicalName] = { create: 1, update: 0, skip: 0 };
      }
    }

    const canCommit = blockers.length === 0;
    let commitToken: string | undefined;
    if (canCommit) {
      commitToken = randomBytes(16).toString('hex');
      const manifestChecksum = sha256Hex(manifestJson);
      const expiresAt = Date.now() + 15 * 60 * 1000;
      this.importTokenStore.issue(commitToken, tenantId, importId, manifestChecksum, expiresAt);
    }

    return {
      schemaVersion: 'import-dryrun.v1',
      importId,
      packSchemaVersion: manifest.schemaVersion,
      signatureValid: manifest.integrity.signatureAlgorithm === 'hmac-sha256',
      blockers,
      warnings,
      deltaSummary,
      estimatedDurationMs: manifest.payloads.length * 100,
      canCommit,
      ...(commitToken !== undefined ? { commitToken } : {}),
    };
  }

  commitImport(
    tenantId: string,
    packJson: string,
    commitToken: string,
  ): ImportCommitResultV1 {
    const manifestJson = this.extractManifestJson(packJson);
    const manifestChecksum = sha256Hex(manifestJson);
    const consumed = this.importTokenStore.consume(commitToken, tenantId, manifestChecksum);
    if (!consumed) {
      throw new Error('invalid or expired import token');
    }

    const parsedJson = (() => {
      try { return JSON.parse(manifestJson) as unknown; } catch { return null; }
    })();
    const manifest = PortabilityPackManifestV1Schema.parse(parsedJson);

    // 从捆绑格式中提取行数据；旧格式无 payloads 字段则跳过写入
    let bundledPayloads: Record<string, unknown[]> | null = null;
    try {
      const raw = JSON.parse(packJson) as unknown;
      if (raw !== null && typeof raw === 'object' && 'payloads' in (raw as object)) {
        bundledPayloads = (raw as { payloads: Record<string, unknown[]> }).payloads;
      }
    } catch {
      // 纯 manifest JSON，无行数据
    }

    const db = this.os.getDatabase();
    const now = Date.now();
    let importedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let staleSkippedCount = 0;
    const failures: Array<{ logicalName: string; rowIndex: number; reason: string }> = [];
    const MAX_FAILURE_DETAILS = 50;

    /**
     * 表 schema 缓存：识别 PRIMARY KEY 列与是否拥有 updated_at，以决定 upsert 策略。
     *  - 有 updated_at + 单列 PK：版本感知 upsert（excluded.updated_at 严格大于本地才覆盖）
     *  - 否则：fallback 到 INSERT OR REPLACE（保留既有行为）
     */
    interface TableSchema {
      pkColumns: string[];
      hasUpdatedAt: boolean;
    }
    const schemaCache = new Map<string, TableSchema>();
    const introspectTable = (table: string): TableSchema => {
      const cached = schemaCache.get(table);
      if (cached) return cached;
      const rows = db.prepare<{ name: string; pk: number }>(
        `PRAGMA table_info(${table})`,
      ).all();
      const pkColumns = rows
        .filter((r) => r.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((r) => r.name);
      const hasUpdatedAt = rows.some((r) => r.name === 'updated_at');
      const schema: TableSchema = { pkColumns, hasUpdatedAt };
      schemaCache.set(table, schema);
      return schema;
    };

    db.exec('BEGIN');
    try {
      for (const payload of manifest.payloads) {
        if (!TENANT_TABLE_SET.has(payload.logicalName)) {
          skippedCount += 1;
          continue;
        }

        const rows = bundledPayloads?.[payload.logicalName];
        if (!rows || rows.length === 0) {
          skippedCount += 1;
          continue;
        }

        const schema = introspectTable(payload.logicalName);
        const versionAware = schema.hasUpdatedAt && schema.pkColumns.length === 1;

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (row === null || typeof row !== 'object') continue;
          const record = row as Record<string, unknown>;
          const cols = Object.keys(record);
          if (cols.length === 0) continue;

          const placeholders = cols.map(() => '?').join(', ');
          const values = cols.map((c) => {
            const v = record[c];
            if (v === null || v === undefined) return null;
            if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v as SqlValue;
            return JSON.stringify(v);
          }) as SqlValue[];

          try {
            if (versionAware && record['updated_at'] !== undefined && record['updated_at'] !== null) {
              const pk = schema.pkColumns[0]!;
              /* 仅当 excluded.updated_at 严格大于本地版本才覆盖；否则保留本地行（视作 staleSkipped） */
              const updateAssignments = cols
                .filter((c) => c !== pk)
                .map((c) => `${c} = excluded.${c}`)
                .join(', ');
              const sql = updateAssignments.length > 0
                ? `INSERT INTO ${payload.logicalName} (${cols.join(', ')}) VALUES (${placeholders})
                     ON CONFLICT(${pk}) DO UPDATE SET ${updateAssignments}
                     WHERE excluded.updated_at > ${payload.logicalName}.updated_at`
                : `INSERT OR IGNORE INTO ${payload.logicalName} (${cols.join(', ')}) VALUES (${placeholders})`;
              const result = db.prepare<void>(sql).run(...values);
              if (result.changes === 0) staleSkippedCount += 1;
            } else {
              db.prepare<void>(
                `INSERT OR REPLACE INTO ${payload.logicalName} (${cols.join(', ')}) VALUES (${placeholders})`,
              ).run(...values);
            }
          } catch (err) {
            failedCount += 1;
            if (failures.length < MAX_FAILURE_DETAILS) {
              const reason = err instanceof Error ? err.message : String(err);
              failures.push({ logicalName: payload.logicalName, rowIndex: i, reason });
            }
          }
        }

        importedCount += 1;
      }

      db.prepare<void>(
        `INSERT INTO import_jobs
           (id, tenant_id, state, manifest_checksum, imported_count, skipped_count, created_at, completed_at)
         VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`,
      ).run(consumed.importId, tenantId, manifestChecksum, importedCount, skippedCount, now, now);

      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      try { this.importTokenStore.pruneExpired(); } catch { /* best-effort */ }
    }

    return {
      schemaVersion: 'import-commit-result.v1',
      importId: consumed.importId,
      importedCount,
      skippedCount,
      failedCount,
      staleSkippedCount,
      failures,
    };
  }

  /** 将 ExportJobRow 转为 ExportJobStatusV1 契约对象 */
  private rowToJobStatus(row: import('./export-job-store.js').ExportJobRow): ExportJobStatusV1 {
    const base = {
      schemaVersion: 'export-job-status.v1' as const,
      exportId: row.id,
      state: row.state,
      percent: row.percent,
      createdAt: new Date(row.created_at).toISOString(),
      warnings: (() => {
        try { return JSON.parse(row.warnings) as Array<{ code: string; messageId: string }>; } catch { return []; }
      })(),
    };

    if (row.state === 'completed') {
      return ExportJobStatusV1Schema.parse({
        ...base,
        completedAt: new Date(row.completed_at!).toISOString(),
        downloadUrl: row.download_url ?? undefined,
      });
    }

    if (row.state === 'failed') {
      return ExportJobStatusV1Schema.parse({
        ...base,
        completedAt: new Date(row.completed_at!).toISOString(),
        errorCode: row.error_code ?? 'EXPORT_FAILED',
      });
    }

    if (row.state === 'partial') {
      return ExportJobStatusV1Schema.parse({
        ...base,
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
        downloadUrl: row.download_url ?? undefined,
      });
    }

    return ExportJobStatusV1Schema.parse(base);
  }
}
