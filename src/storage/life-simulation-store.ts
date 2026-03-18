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
import type { SyncWriteUnitOfWork, LifeSimRow, LifeSimPathRow } from '@chrono/kernel';
import {
  lsimQueryById, lsimQueryByIdTenant, lsimQueryByTenant,
  lsimQueryCountByTenant, lsimQueryPaginated,
  lsimQueryPathDetail, lsimQueryPathDetailTenant,
  lsimQueryVariants, lsimQueryVariantsTenant, lsimQueryPathsBySim,
  lsimCmdCreate, lsimCmdSetStatus, lsimCmdSetStatusCompleted,
  lsimCmdUpdateProgress, lsimCmdSaveSummary, lsimCmdSavePath,
} from '@chrono/kernel';
import { directUnitOfWork } from './direct-uow-adapter.js';
import { registerCoreSelfExecutors } from './executors/index.js';
import { generatePrefixedId } from '../utils/id-generator.js';

function rowToSimRecord(row: LifeSimRow): LifeSimulationRecord {
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

function rowToPathRecord(row: LifeSimPathRow): LifeSimulationPathRecord {
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
  private readonly tx: SyncWriteUnitOfWork;

  constructor(db: IDatabase) {
    registerCoreSelfExecutors();
    this.tx = directUnitOfWork(db);
  }

  /** 创建模拟记录 */
  create(id: string, tenantId: string, taskId: string, config: LifeSimulationConfig, baseSimulationId?: string): void {
    const now = Date.now();
    this.tx.execute(lsimCmdCreate({
      id, tenantId, taskId,
      baseSimulationId: baseSimulationId ?? null,
      configJson: JSON.stringify(config),
      now,
    }));
  }

  /** 更新状态 */
  setStatus(id: string, status: string, error?: string): void {
    const now = Date.now();
    if (status === 'completed') {
      this.tx.execute(lsimCmdSetStatusCompleted({ id, status, error: error ?? null, now }));
    } else {
      this.tx.execute(lsimCmdSetStatus({ id, status, error: error ?? null, now }));
    }
  }

  /** 更新进度 */
  updateProgress(id: string, progress: object): void {
    this.tx.execute(lsimCmdUpdateProgress({ id, progressJson: JSON.stringify(progress), now: Date.now() }));
  }

  /** 保存摘要（完整结果的精简版） */
  saveSummary(id: string, summary: object): void {
    this.tx.execute(lsimCmdSaveSummary({ id, summaryJson: JSON.stringify(summary), now: Date.now() }));
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

    this.tx.execute(lsimCmdSavePath({
      id: pathRecordId,
      simulationId: simId,
      pathId: pathResult.pathId,
      label: pathResult.label,
      summaryJson: JSON.stringify(summary),
      timelineJson: JSON.stringify(pathResult.timeline),
      branchesJson: JSON.stringify(pathResult.branches),
      now,
    }));
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
      ? this.tx.queryOne(lsimQueryByIdTenant(id, tenantId))
      : this.tx.queryOne(lsimQueryById(id));
    return row ? rowToSimRecord(row) : undefined;
  }

  /** 按租户查询 */
  getByTenant(tenantId: string, limit = 20): LifeSimulationRecord[] {
    const rows = this.tx.queryMany(lsimQueryByTenant(tenantId, limit));
    return [...rows].map(r => rowToSimRecord(r as unknown as LifeSimRow));
  }

  /** 按租户分页查询（SQL 级 OFFSET） */
  getByTenantPaginated(tenantId: string, limit: number, offset: number): { records: LifeSimulationRecord[]; total: number } {
    const total = Number(this.tx.queryOne(lsimQueryCountByTenant(tenantId))?.count ?? 0);
    const rows = this.tx.queryMany(lsimQueryPaginated(tenantId, limit, offset));
    const records = [...rows].map(r => rowToSimRecord(r as unknown as LifeSimRow));
    return { records, total };
  }

  /** 查询路径详情（可选租户隔离） */
  getPathDetail(simId: string, pathId: string, tenantId?: string): LifeSimulationPathRecord | undefined {
    const row = tenantId
      ? this.tx.queryOne(lsimQueryPathDetailTenant(simId, pathId, tenantId))
      : this.tx.queryOne(lsimQueryPathDetail(simId, pathId));
    return row ? rowToPathRecord(row) : undefined;
  }

  /** 查询基于某模拟的压力测试变体列表 */
  getVariants(baseSimulationId: string, tenantId?: string): LifeSimulationRecord[] {
    const rows = tenantId
      ? this.tx.queryMany(lsimQueryVariantsTenant(baseSimulationId, tenantId))
      : this.tx.queryMany(lsimQueryVariants(baseSimulationId));
    return [...rows].map(r => rowToSimRecord(r as unknown as LifeSimRow));
  }

  /** 查询模拟的所有路径摘要 */
  getPathsBySimulation(simId: string): LifeSimulationPathRecord[] {
    const rows = this.tx.queryMany(lsimQueryPathsBySim(simId));
    return [...rows].map(r => rowToPathRecord(r as unknown as LifeSimPathRow));
  }
}
