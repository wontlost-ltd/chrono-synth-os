/**
 * 人生模拟持久化存储
 * 管理 life_simulations 和 life_simulation_paths 两张表的 CRUD
 */

import type { IDatabase } from './database.js';
import type {
  LifeSimulationConfig,
  LifeSimulationResult,
  LifePathResult,
  LifeSimulationRecord,
  LifeSimulationPathRecord,
} from '../types/life-simulation.js';
import { generatePrefixedId } from '../utils/id-generator.js';

interface SimRow {
  id: string;
  tenant_id: string;
  task_id: string;
  base_simulation_id: string | null;
  config_json: string;
  status: string;
  summary_json: string | null;
  progress_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface PathRow {
  id: string;
  simulation_id: string;
  path_id: string;
  label: string;
  status: string;
  summary_json: string | null;
  timeline_json: string | null;
  branches_json: string | null;
  retrospective_json: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSimRecord(row: SimRow): LifeSimulationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    baseSimulationId: row.base_simulation_id,
    configJson: row.config_json,
    status: row.status as LifeSimulationRecord['status'],
    summaryJson: row.summary_json,
    progressJson: row.progress_json,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToPathRecord(row: PathRow): LifeSimulationPathRecord {
  return {
    id: row.id,
    simulationId: row.simulation_id,
    pathId: row.path_id,
    label: row.label,
    status: row.status as LifeSimulationPathRecord['status'],
    summaryJson: row.summary_json,
    timelineJson: row.timeline_json,
    branchesJson: row.branches_json,
    retrospectiveJson: row.retrospective_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LifeSimulationStore {
  constructor(private readonly db: IDatabase) {}

  /** 创建模拟记录 */
  create(id: string, tenantId: string, taskId: string, config: LifeSimulationConfig, baseSimulationId?: string): void {
    const now = Date.now();
    this.db.prepare<void>(
      `INSERT INTO life_simulations (id, tenant_id, task_id, base_simulation_id, config_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(id, tenantId, taskId, baseSimulationId ?? null, JSON.stringify(config), now, now);
  }

  /** 更新状态 */
  setStatus(id: string, status: string, error?: string): void {
    const now = Date.now();
    if (status === 'completed') {
      this.db.prepare<void>(
        'UPDATE life_simulations SET status = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?',
      ).run(status, error ?? null, now, now, id);
    } else {
      this.db.prepare<void>(
        'UPDATE life_simulations SET status = ?, error = ?, updated_at = ? WHERE id = ?',
      ).run(status, error ?? null, now, id);
    }
  }

  /** 更新进度 */
  updateProgress(id: string, progress: object): void {
    this.db.prepare<void>(
      'UPDATE life_simulations SET progress_json = ?, updated_at = ? WHERE id = ?',
    ).run(JSON.stringify(progress), Date.now(), id);
  }

  /** 保存摘要（完整结果的精简版） */
  saveSummary(id: string, summary: object): void {
    this.db.prepare<void>(
      'UPDATE life_simulations SET summary_json = ?, updated_at = ? WHERE id = ?',
    ).run(JSON.stringify(summary), Date.now(), id);
  }

  /** 保存单路径结果 */
  savePathResult(simId: string, pathResult: LifePathResult): void {
    const now = Date.now();
    const pathRecordId = generatePrefixedId('lsp');
    const summary = {
      compositeScore: pathResult.compositeScore,
      regretProbability: pathResult.regretProbability,
      branchCount: pathResult.branches.length,
      timelineYears: pathResult.timeline.length,
    };

    this.db.prepare<void>(
      `INSERT INTO life_simulation_paths (id, simulation_id, path_id, label, status, summary_json, timeline_json, branches_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = 'completed', summary_json = excluded.summary_json,
         timeline_json = excluded.timeline_json, branches_json = excluded.branches_json,
         updated_at = excluded.updated_at`,
    ).run(
      pathRecordId, simId, pathResult.pathId, pathResult.label,
      JSON.stringify(summary), JSON.stringify(pathResult.timeline),
      JSON.stringify(pathResult.branches), now, now,
    );
  }

  /** 保存完整结果摘要 */
  saveResult(id: string, result: LifeSimulationResult): void {
    const summary = {
      recommendedPathId: result.recommendedPathId,
      paths: result.paths.map(p => ({
        pathId: p.pathId,
        label: p.label,
        compositeScore: p.compositeScore,
        regretProbability: p.regretProbability,
      })),
      retrospective: result.retrospective,
      completedAt: result.completedAt,
    };
    this.saveSummary(id, summary);
  }

  /** 按 ID 查询（可选租户隔离） */
  getById(id: string, tenantId?: string): LifeSimulationRecord | undefined {
    const row = tenantId
      ? this.db.prepare<SimRow>(
        'SELECT * FROM life_simulations WHERE id = ? AND tenant_id = ?',
      ).get(id, tenantId)
      : this.db.prepare<SimRow>(
        'SELECT * FROM life_simulations WHERE id = ?',
      ).get(id);
    return row ? rowToSimRecord(row) : undefined;
  }

  /** 按租户查询 */
  getByTenant(tenantId: string, limit = 20): LifeSimulationRecord[] {
    return this.db.prepare<SimRow>(
      'SELECT * FROM life_simulations WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(tenantId, limit).map(rowToSimRecord);
  }

  /** 按租户分页查询（SQL 级 OFFSET） */
  getByTenantPaginated(tenantId: string, limit: number, offset: number): { records: LifeSimulationRecord[]; total: number } {
    const total = this.db.prepare<{ count: number }>(
      'SELECT COUNT(*) as count FROM life_simulations WHERE tenant_id = ?',
    ).get(tenantId)?.count ?? 0;
    const records = this.db.prepare<SimRow>(
      'SELECT * FROM life_simulations WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(tenantId, limit, offset).map(rowToSimRecord);
    return { records, total };
  }

  /** 查询路径详情（可选租户隔离） */
  getPathDetail(simId: string, pathId: string, tenantId?: string): LifeSimulationPathRecord | undefined {
    const row = tenantId
      ? this.db.prepare<PathRow>(
        `SELECT p.* FROM life_simulation_paths p
         JOIN life_simulations s ON s.id = p.simulation_id
         WHERE p.simulation_id = ? AND p.path_id = ? AND s.tenant_id = ?`,
      ).get(simId, pathId, tenantId)
      : this.db.prepare<PathRow>(
        'SELECT * FROM life_simulation_paths WHERE simulation_id = ? AND path_id = ?',
      ).get(simId, pathId);
    return row ? rowToPathRecord(row) : undefined;
  }

  /** 查询基于某模拟的压力测试变体列表 */
  getVariants(baseSimulationId: string, tenantId?: string): LifeSimulationRecord[] {
    const rows = tenantId
      ? this.db.prepare<SimRow>(
        'SELECT * FROM life_simulations WHERE base_simulation_id = ? AND tenant_id = ? ORDER BY created_at ASC',
      ).all(baseSimulationId, tenantId)
      : this.db.prepare<SimRow>(
        'SELECT * FROM life_simulations WHERE base_simulation_id = ? ORDER BY created_at ASC',
      ).all(baseSimulationId);
    return rows.map(rowToSimRecord);
  }

  /** 查询模拟的所有路径摘要 */
  getPathsBySimulation(simId: string): LifeSimulationPathRecord[] {
    return this.db.prepare<PathRow>(
      'SELECT * FROM life_simulation_paths WHERE simulation_id = ? ORDER BY created_at ASC',
    ).all(simId).map(rowToPathRecord);
  }
}
