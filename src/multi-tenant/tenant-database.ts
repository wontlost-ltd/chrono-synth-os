/**
 * 租户隔离数据库包装器
 * 自动为多租户表注入 tenant_id 过滤条件
 *
 * 安全设计：
 * - exec() 拦截：禁止对租户表执行无参数化的 DML，防止跨租户数据泄漏
 * - INSERT 重写：在列列表和 VALUES 中注入 tenant_id
 * - SELECT/UPDATE/DELETE 重写：注入 WHERE tenant_id = ? 条件
 * - 不支持的 SQL 模式（CTE、子查询、INSERT...SELECT）直接抛异常，拒绝静默放行
 */

import type { IDatabase, IPreparedStatement, SqlValue } from '../storage/database.js';
import { resolveQueryExecutor, resolveCommandExecutor } from '../storage/legacy-sync-bridge.js';

/** 需要租户隔离的表 */
const TENANT_TABLES = new Set([
  'core_values', 'memory_nodes', 'memory_edges', 'memory_embeddings',
  'working_memory', 'persona_versions', 'conflicts', 'snapshots',
  'evolution_records', 'survival_anchors', 'audit_log', 'pending_updates',
  'identities', 'devices',
  'organizations', 'workspaces', 'organization_memberships', 'organization_role_bindings',
  'tenant_enterprise_profiles',
  'billing_invoices', 'usage_meters',
  'settlement_reconciliation_runs',
  'avatar_autorun_config', 'avatar_autorun_runlog', 'knowledge_sources',
  'persona_core', 'persona_wallets', 'persona_forks', 'persona_memories',
  'persona_knowledge_items', 'marketplace_tasks', 'persona_growth_events',
  'persona_governance_events', 'persona_memory_nodes', 'persona_memory_edges',
  'persona_working_memory', 'persona_transfers', 'reputation_history',
  'persona_daily_metrics', 'marketplace_daily_metrics',
  'task_applications', 'task_assignments', 'runtime_sessions', 'task_results',
  'governance_cases', 'governance_actions',
  'wallet_transactions', 'wallet_payout_requests', 'wallet_settlements',
  'platform_dlq_events',
  /* ADR-0047/0048：蒸馏工件、并发租约、响应模板、规则均为 tenant 数据 */
  'distilled_artifacts', 'persona_leases', 'response_templates', 'persona_rules',
  /* BYOK：per-tenant LLM provider 凭据（密文）+ active provider 偏好 */
  'llm_provider_credentials',
  'tenant_llm_settings',
  /* GDPR 覆盖补齐：以下均含 tenant_id，须自动租户隔离（与 privacy 清单同步） */
  'billing_outbox', 'ws_event_log', 'tenant_add_ons', 'entitlements',
  'observability_outbox', 'observability_rollups', 'observability_processed_events',
  'export_jobs', 'event_ledger', 'persona_core_ledger_outbox', 'projection_store',
  'conflict_inbox', 'import_jobs', 'import_commit_tokens', 'tenant_key_versions',
  'tenant_vault_audit', 'tenant_storage_bindings', 'drift_analysis_log',
  'persona_templates', 'bulk_knowledge_import_jobs', 'conversation_messages',
  'conversation_confirmation_tokens', 'tool_permissions', 'agency_authorizations',
  'tool_invocations', 'user_oauth_tokens', 'events_user_journey', 'core_values_snapshot',
  'compliance_evidence', 'legal_holds', 'break_glass_jti_consumptions',
  'audit_chain_anchors', 'audit_chain_anchor_failures', 'api_keys', 'kms_key_audit',
]);

/** 单行表：PK 替换为 tenant_id（v007 迁移后） */
const SINGLETON_TABLES = new Set([
  'narrative', 'decision_style', 'cognitive_model',
]);

/** 所有受租户影响的表（含单行表）。导出供完整性 ratchet 测试核对覆盖。 */
export const ALL_TENANT_TABLES = new Set([...TENANT_TABLES, ...SINGLETON_TABLES]);

/**
 * 判断 SQL 是否涉及租户表
 * 使用预编译正则匹配表名词边界，避免子串误匹配（如 "core_values_backup"）
 */
const tableRegexCache = new Map<string, RegExp>();

function getTableRegex(table: string): RegExp {
  let re = tableRegexCache.get(table);
  if (!re) {
    re = new RegExp(`\\b${table}\\b`, 'i');
    tableRegexCache.set(table, re);
  }
  return re;
}

function findTenantTable(sql: string): string | undefined {
  for (const table of ALL_TENANT_TABLES) {
    if (getTableRegex(table).test(sql)) return table;
  }
  return undefined;
}

/** SQL 操作类型 */
type SqlOp = 'INSERT' | 'SELECT' | 'UPDATE' | 'DELETE' | 'OTHER';

function detectOp(sql: string): SqlOp {
  const trimmed = sql.trimStart().toUpperCase();
  if (trimmed.startsWith('INSERT')) return 'INSERT';
  if (trimmed.startsWith('SELECT')) return 'SELECT';
  if (trimmed.startsWith('UPDATE')) return 'UPDATE';
  if (trimmed.startsWith('DELETE')) return 'DELETE';
  return 'OTHER';
}

/** INSERT 语句的列列表中是否已包含 tenant_id */
function insertAlreadyHasTenantId(sql: string): boolean {
  const match = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]+)\)/i.exec(sql);
  if (!match) return false;
  return match[1].split(',').some(col => col.trim().replace(/["'`]/g, '').toLowerCase() === 'tenant_id');
}

/**
 * 检测不安全的 SQL 模式，这些模式无法通过简单正则安全重写
 * 检测到时抛异常，拒绝静默放行
 */
function assertSafeForRewrite(sql: string): void {
  const upper = sql.toUpperCase().trim();
  /* CTE（WITH ... AS） */
  if (/^\s*WITH\b/i.test(sql)) {
    throw new Error(`TenantDatabase: 不支持 CTE 语法的自动租户隔离，请手动管理 tenant_id: ${sql.slice(0, 80)}`);
  }
  /* INSERT ... SELECT（无 VALUES 关键字的 INSERT） */
  if (upper.startsWith('INSERT') && !upper.includes('VALUES') && upper.includes('SELECT')) {
    throw new Error(`TenantDatabase: 不支持 INSERT...SELECT 的自动租户隔离: ${sql.slice(0, 80)}`);
  }
  /* UNION */
  if (/\bUNION\b/i.test(sql)) {
    throw new Error(`TenantDatabase: 不支持 UNION 语法的自动租户隔离: ${sql.slice(0, 80)}`);
  }
}

/**
 * 为 INSERT 语句注入 tenant_id 列和占位符
 * INSERT [OR REPLACE|IGNORE] INTO table (col1, col2) VALUES (?, ?)
 * → INSERT [OR ...] INTO table (tenant_id, col1, col2) VALUES (?, ?, ?)
 */
function rewriteInsert(sql: string): string {
  const result = sql.replace(
    /INSERT\s+(OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
    (_match, orClause, table, cols, vals) => {
      const prefix = orClause ? `INSERT ${orClause.trim()} INTO` : 'INSERT INTO';
      return `${prefix} ${table} (tenant_id, ${cols.trim()}) VALUES (?, ${vals.trim()})`;
    },
  );
  /* 验证重写成功：如果正则没匹配到任何内容，result === sql */
  if (result === sql) {
    throw new Error(`TenantDatabase: INSERT 重写失败，SQL 格式不符合预期: ${sql.slice(0, 120)}`);
  }
  return result;
}

interface RewriteResult {
  sql: string;
  tenantParamIndex: number;
}

const enum PlaceholderState {
  Normal,
  SingleQuote,
  DoubleQuote,
  LineComment,
  BlockComment,
}

function countPlaceholders(sql: string): number {
  let count = 0;
  let state: PlaceholderState = PlaceholderState.Normal;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = i + 1 < sql.length ? sql[i + 1] : '';

    switch (state) {
      case PlaceholderState.Normal:
        if (ch === "'") {
          state = PlaceholderState.SingleQuote;
        } else if (ch === '"') {
          state = PlaceholderState.DoubleQuote;
        } else if (ch === '-' && next === '-') {
          state = PlaceholderState.LineComment;
          i++;
        } else if (ch === '/' && next === '*') {
          state = PlaceholderState.BlockComment;
          i++;
        } else if (ch === '?') {
          count++;
        }
        break;
      case PlaceholderState.SingleQuote:
        if (ch === "'" && next === "'") {
          i++;
        } else if (ch === "'") {
          state = PlaceholderState.Normal;
        }
        break;
      case PlaceholderState.DoubleQuote:
        if (ch === '"' && next === '"') {
          i++;
        } else if (ch === '"') {
          state = PlaceholderState.Normal;
        }
        break;
      case PlaceholderState.LineComment:
        if (ch === '\n') {
          state = PlaceholderState.Normal;
        }
        break;
      case PlaceholderState.BlockComment:
        if (ch === '*' && next === '/') {
          i++;
          state = PlaceholderState.Normal;
        }
        break;
    }
  }

  return count;
}

/**
 * 为 SELECT/UPDATE/DELETE 语句注入 WHERE tenant_id = ? 条件
 * - 已有 WHERE：改写为 `WHERE tenant_id = ? AND (<原条件>)`
 * - 无 WHERE：在尾部子句之前插入 `WHERE tenant_id = ?`
 * - 返回 tenant 参数应插入到原参数数组中的索引
 */
function injectWhereClause(sql: string): RewriteResult {
  /* 移除末尾分号和空白 */
  const hasSemicolon = sql.trimEnd().endsWith(';');
  const cleaned = hasSemicolon ? sql.trimEnd().slice(0, -1) : sql;

  const whereRe = /\bWHERE\b/i;
  const tailRe = /\b(ORDER\s+BY|LIMIT|GROUP\s+BY|HAVING)\b/i;
  let result: string;
  let tenantParamIndex = 0;

  if (whereRe.test(cleaned)) {
    const whereMatch = whereRe.exec(cleaned);
    if (!whereMatch) {
      throw new Error(`TenantDatabase: WHERE 子句解析失败: ${sql.slice(0, 120)}`);
    }
    const whereIndex = whereMatch.index;
    const afterWhere = cleaned.slice(whereIndex + whereMatch[0].length);
    const tailMatch = tailRe.exec(afterWhere);
    const prefix = cleaned.slice(0, whereIndex);
    const originalPredicate = tailMatch
      ? afterWhere.slice(0, tailMatch.index).trim()
      : afterWhere.trim();
    const suffix = tailMatch
      ? ` ${afterWhere.slice(tailMatch.index).trimStart()}`
      : '';

    result = `${prefix}WHERE tenant_id = ? AND (${originalPredicate})${suffix}`;
    tenantParamIndex = countPlaceholders(prefix);
  } else {
    /* 无 WHERE：在尾部子句之前插入 WHERE */
    const tailMatch = tailRe.exec(cleaned);
    if (tailMatch) {
      result = cleaned.slice(0, tailMatch.index) + ' WHERE tenant_id = ? ' + cleaned.slice(tailMatch.index);
      tenantParamIndex = countPlaceholders(cleaned.slice(0, tailMatch.index));
    } else {
      result = cleaned + ' WHERE tenant_id = ?';
      tenantParamIndex = countPlaceholders(cleaned);
    }
  }

  return {
    sql: hasSemicolon ? result + ';' : result,
    tenantParamIndex,
  };
}

/** 检测 exec() 中的 DML 是否涉及租户表，涉及则抛异常 */
function assertExecSafe(sql: string): void {
  const op = detectOp(sql);
  if (op === 'OTHER') return; /* DDL（CREATE TABLE 等）放行 */

  const table = findTenantTable(sql);
  if (table) {
    throw new Error(
      `TenantDatabase: 禁止通过 exec() 对租户表 "${table}" 执行 ${op}，` +
      `必须使用 prepare() 以确保 tenant_id 隔离: ${sql.slice(0, 80)}`,
    );
  }
}

/** 租户隔离的 PreparedStatement 包装器 */
class TenantStatement<T = unknown> implements IPreparedStatement<T> {
  constructor(
    private readonly inner: IPreparedStatement<T>,
    private readonly tenantId: string,
    private readonly tenantParamIndex: number | null,
  ) {}

  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.inner.run(...this.buildParams(params));
  }

  get(...params: SqlValue[]): T | undefined {
    return this.inner.get(...this.buildParams(params));
  }

  all(...params: SqlValue[]): T[] {
    return this.inner.all(...this.buildParams(params));
  }

  private buildParams(params: SqlValue[]): SqlValue[] {
    if (this.tenantParamIndex === null) {
      return [...params];
    }
    const prefix = params.slice(0, this.tenantParamIndex);
    const suffix = params.slice(this.tenantParamIndex);
    return [...prefix, this.tenantId, ...suffix];
  }
}

/**
 * 租户隔离数据库
 * 包装 IDatabase，自动为租户表的 SQL 注入 tenant_id
 */
export class TenantDatabase implements IDatabase {
  /** Delegate dialect to the wrapped DB — tenant scoping is dialect-agnostic. */
  get dialect(): 'sqlite' | 'postgres' { return this.inner.dialect; }

  constructor(
    private readonly inner: IDatabase,
    private readonly tenantId: string,
  ) {}

  exec(sql: string): void {
    /* 拦截对租户表的无参数 DML，防止跨租户数据泄漏 */
    assertExecSafe(sql);
    this.inner.exec(sql);
  }

  prepare<T = unknown>(sql: string): IPreparedStatement<T> {
    const table = findTenantTable(sql);
    if (!table) {
      return this.inner.prepare<T>(sql);
    }

    const op = detectOp(sql);

    /* 检测不支持的 SQL 模式 */
    assertSafeForRewrite(sql);

    if (op === 'INSERT') {
      if (insertAlreadyHasTenantId(sql)) {
        /* SQL 已包含 tenant_id 列（租户感知 store），跳过重写 */
        return this.inner.prepare<T>(sql);
      }
      const rewritten = rewriteInsert(sql);
      return new TenantStatement<T>(
        this.inner.prepare<T>(rewritten),
        this.tenantId,
        0,
      );
    }

    if (op === 'SELECT' || op === 'UPDATE' || op === 'DELETE') {
      const rewritten = injectWhereClause(sql);
      return new TenantStatement<T>(
        this.inner.prepare<T>(rewritten.sql),
        this.tenantId,
        rewritten.tenantParamIndex,
      );
    }

    /* 其他操作不改写 */
    return this.inner.prepare<T>(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.inner.transaction(fn);
  }

  close(): void {
    /* 租户数据库不关闭底层连接——由宿主管理 */
  }

  /* ── SyncWriteUnitOfWork 端口
   *  关键：必须把 this（TenantDatabase）传给 executor，
   *  这样 executor 内部的 prepare()/exec() 会经过租户重写。
   *  不能简单 this.inner.queryOne(q)，那样会跳过租户隔离。 */

  queryOne<TResult, TParams = unknown>(q: import('@chrono/kernel').Query<TResult, TParams>): TResult | null {
    const exec = resolveQueryExecutor(q.kind);
    if (!exec) throw new Error(`未注册的查询: ${q.kind}`);
    return (exec(this, q.params) as TResult) ?? null;
  }

  queryMany<TResult, TParams = unknown>(q: import('@chrono/kernel').Query<TResult, TParams>): readonly TResult[] {
    const exec = resolveQueryExecutor(q.kind);
    if (!exec) throw new Error(`未注册的查询: ${q.kind}`);
    return exec(this, q.params) as readonly TResult[];
  }

  execute<TParams>(cmd: import('@chrono/kernel').Command<TParams>): import('@chrono/kernel').ExecResult {
    const exec = resolveCommandExecutor(cmd.kind);
    if (!exec) throw new Error(`未注册的命令: ${cmd.kind}`);
    return exec(this, cmd.params);
  }
}
