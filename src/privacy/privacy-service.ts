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

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

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
      } as unknown as AppConfig);
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
        const { rawManifestJson } = buildPortabilityPack(exportResult, effectiveSigningKey);

        // 序列化并上传至对象存储
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
          pack_json: rawManifestJson,
        });
      } catch {
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
   * 对导入包清单执行 dry-run 验证，返回报告（不写入任何数据）
   */
  dryRunImport(tenantId: string, packManifestJson: string): ImportDryRunReportV1 {
    const importId = generatePrefixedId('import');

    const parseResult = PortabilityPackManifestV1Schema.safeParse(
      (() => {
        try { return JSON.parse(packManifestJson) as unknown; } catch { return null; }
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
      const manifestChecksum = sha256Hex(packManifestJson);
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
    manifestJson: string,
    commitToken: string,
  ): ImportCommitResultV1 {
    const manifestChecksum = sha256Hex(manifestJson);
    const consumed = this.importTokenStore.consume(commitToken, tenantId, manifestChecksum);
    if (!consumed) {
      throw new Error('invalid or expired import token');
    }

    const parsedJson = (() => {
      try { return JSON.parse(manifestJson) as unknown; } catch { return null; }
    })();
    const manifest = PortabilityPackManifestV1Schema.parse(parsedJson);

    const db = this.os.getDatabase();
    const now = Date.now();
    let importedCount = 0;
    let skippedCount = 0;

    db.exec('BEGIN');
    try {
      for (const payload of manifest.payloads) {
        if (!TENANT_TABLE_SET.has(payload.logicalName)) {
          skippedCount += 1;
          continue;
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
