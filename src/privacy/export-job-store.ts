/**
 * 导出任务存储 — 操作 export_jobs 表的薄 DAO 层
 */

import type { IDatabase, SqlValue } from '../storage/database.js';
import { generatePrefixedId } from '../utils/id-generator.js';

/** 与 export_jobs 表结构对应的行接口 */
export interface ExportJobRow {
  id: string;
  tenant_id: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'partial';
  percent: number;
  eta_ms: number | null;
  created_at: number;
  completed_at: number | null;
  download_url: string | null;
  error_code: string | null;
  warnings: string;
  pack_json: string | null;
}

/** updateExportJob 支持的可更新字段 */
export interface ExportJobPatch {
  state?: ExportJobRow['state'];
  percent?: number;
  eta_ms?: number | null;
  completed_at?: number | null;
  download_url?: string | null;
  error_code?: string | null;
  warnings?: string;
  pack_json?: string | null;
}

/**
 * 创建一个 queued 状态的导出任务，返回新任务 id
 */
export function createExportJob(db: IDatabase, tenantId: string, now: number): string {
  const id = generatePrefixedId('expjob');
  db.prepare<void>(
    `INSERT INTO export_jobs (id, tenant_id, state, percent, created_at, warnings)
     VALUES (?, ?, 'queued', 0, ?, '[]')`,
  ).run(id, tenantId, now);
  return id;
}

/**
 * 更新导出任务的指定字段
 */
export function updateExportJob(db: IDatabase, id: string, patch: ExportJobPatch): void {
  const sets: string[] = [];
  const values: SqlValue[] = [];

  if (patch.state !== undefined) { sets.push('state = ?'); values.push(patch.state); }
  if (patch.percent !== undefined) { sets.push('percent = ?'); values.push(patch.percent); }
  if ('eta_ms' in patch) { sets.push('eta_ms = ?'); values.push(patch.eta_ms ?? null); }
  if ('completed_at' in patch) { sets.push('completed_at = ?'); values.push(patch.completed_at ?? null); }
  if ('download_url' in patch) { sets.push('download_url = ?'); values.push(patch.download_url ?? null); }
  if ('error_code' in patch) { sets.push('error_code = ?'); values.push(patch.error_code ?? null); }
  if (patch.warnings !== undefined) { sets.push('warnings = ?'); values.push(patch.warnings); }
  if ('pack_json' in patch) { sets.push('pack_json = ?'); values.push(patch.pack_json ?? null); }

  if (sets.length === 0) return;

  values.push(id);
  db.prepare<void>(`UPDATE export_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * 按 id 查询导出任务，不存在时返回 null
 */
export function getExportJob(db: IDatabase, id: string): ExportJobRow | null {
  const row = db.prepare<ExportJobRow>('SELECT * FROM export_jobs WHERE id = ?').get(id);
  return row ?? null;
}

/**
 * 列出指定租户的全部导出任务（按创建时间倒序）
 */
export function listExportJobs(db: IDatabase, tenantId: string): ExportJobRow[] {
  return db.prepare<ExportJobRow>(
    'SELECT * FROM export_jobs WHERE tenant_id = ? ORDER BY created_at DESC',
  ).all(tenantId);
}
