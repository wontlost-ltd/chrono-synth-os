/**
 * 租户隔离数据库包装器
 * 自动为多租户表注入 tenant_id 过滤条件
 */

import type { IDatabase, IPreparedStatement, SqlValue } from '../storage/database.js';

/** 需要租户隔离的表 */
const TENANT_TABLES = new Set([
  'core_values', 'memory_nodes', 'memory_edges', 'memory_embeddings',
  'working_memory', 'persona_versions', 'conflicts', 'snapshots',
  'evolution_records', 'survival_anchors', 'audit_log', 'pending_updates',
  'avatar_autorun_config', 'avatar_autorun_runlog', 'knowledge_sources',
]);

/** 单行表：PK 替换为 tenant_id（v007 迁移后） */
const SINGLETON_TABLES = new Set([
  'narrative', 'decision_style', 'cognitive_model',
]);

/** 所有受租户影响的表 */
const ALL_TENANT_TABLES = new Set([...TENANT_TABLES, ...SINGLETON_TABLES]);

/**
 * 判断 SQL 是否涉及租户表
 * 简单匹配：检查 SQL 中是否包含任何租户表名
 */
function findTenantTable(sql: string): string | undefined {
  const upper = sql.toUpperCase();
  for (const table of ALL_TENANT_TABLES) {
    /* 匹配表名后跟空白或括号，避免子串误匹配 */
    const re = new RegExp(`\\b${table.toUpperCase()}\\b`);
    if (re.test(upper)) return table;
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
 * 为 INSERT 语句注入 tenant_id 列和占位符
 * INSERT INTO table (col1, col2) VALUES (?, ?)
 * → INSERT INTO table (tenant_id, col1, col2) VALUES (?, ?, ?)
 */
function rewriteInsert(sql: string): string {
  return sql.replace(
    /INSERT\s+(OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
    (_match, orClause, table, cols, vals) => {
      const prefix = orClause ? `INSERT ${orClause.trim()} INTO` : 'INSERT INTO';
      return `${prefix} ${table} (tenant_id, ${cols.trim()}) VALUES (?, ${vals.trim()})`;
    },
  );
}

/**
 * 为 SELECT/UPDATE/DELETE 语句注入 WHERE tenant_id = ? 条件
 */
function injectWhereClause(sql: string): string {
  const whereRe = /\bWHERE\b/i;
  if (whereRe.test(sql)) {
    /* 已有 WHERE：在末尾追加 AND tenant_id = ?（tenant_id 参数附在原始参数之后） */
    const tailRe = /\b(ORDER\s+BY|LIMIT|GROUP\s+BY|HAVING)\b/i;
    const tailMatch = tailRe.exec(sql);
    if (tailMatch) {
      return sql.slice(0, tailMatch.index) + ' AND tenant_id = ? ' + sql.slice(tailMatch.index);
    }
    return sql + ' AND tenant_id = ?';
  }
  /* 无 WHERE：在语句末尾的 ORDER BY / LIMIT / GROUP BY 之前插入 */
  const tailRe = /\b(ORDER\s+BY|LIMIT|GROUP\s+BY|HAVING)\b/i;
  const tailMatch = tailRe.exec(sql);
  if (tailMatch) {
    return sql.slice(0, tailMatch.index) + ' WHERE tenant_id = ? ' + sql.slice(tailMatch.index);
  }
  return sql + ' WHERE tenant_id = ?';
}

/** 租户隔离的 PreparedStatement 包装器 */
class TenantStatement<T = unknown> implements IPreparedStatement<T> {
  constructor(
    private readonly inner: IPreparedStatement<T>,
    private readonly tenantId: string,
    private readonly prependTenant: boolean,
    private readonly appendTenant: boolean,
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
    const result: SqlValue[] = [];
    if (this.prependTenant) result.push(this.tenantId);
    result.push(...params);
    if (this.appendTenant) result.push(this.tenantId);
    return result;
  }
}

/**
 * 租户隔离数据库
 * 包装 IDatabase，自动为租户表的 SQL 注入 tenant_id
 */
export class TenantDatabase implements IDatabase {
  constructor(
    private readonly inner: IDatabase,
    private readonly tenantId: string,
  ) {}

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  prepare<T = unknown>(sql: string): IPreparedStatement<T> {
    const table = findTenantTable(sql);
    if (!table) {
      return this.inner.prepare<T>(sql);
    }

    const op = detectOp(sql);

    if (op === 'INSERT') {
      if (insertAlreadyHasTenantId(sql)) {
        /* SQL 已包含 tenant_id 列（租户感知 store），跳过重写 */
        return this.inner.prepare<T>(sql);
      }
      const rewritten = rewriteInsert(sql);
      return new TenantStatement<T>(
        this.inner.prepare<T>(rewritten),
        this.tenantId,
        true,   /* prepend tenant_id 值 */
        false,
      );
    }

    if (op === 'SELECT' || op === 'UPDATE' || op === 'DELETE') {
      const rewritten = injectWhereClause(sql);
      return new TenantStatement<T>(
        this.inner.prepare<T>(rewritten),
        this.tenantId,
        false,
        true,   /* append tenant_id 值（WHERE 子句末尾的 ?） */
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
}
