/**
 * 人格引擎：管理人格版本的创建、状态转换和持久化
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  pengQueryById, pengQueryActive, pengQueryAll,
  pengCmdCreate, pengCmdSetStatus, pengCmdSetResults,
  pengCmdSetQuota, pengCmdDelete, pengCmdDeleteAll, pengCmdInsertRaw,
} from '@chrono/kernel';
import type { PengRow } from '@chrono/kernel';
import type { IDatabase } from '../storage/database.js';
import { mapToJson, jsonToMap, deepStringify, deepParse } from '../storage/serialization.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { PersonaVersion, PersonaVersionId, PersonaStatus, SimulationResult } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';

const VALID_STATUSES = new Set<string>(['active', 'paused', 'completed', 'failed']);

export class PersonaEngine {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(
    db: IDatabase,
    private readonly clock: Clock,
  ) {
    registerCoreSelfExecutors();
    this.tx = db;
  }

  /** 从核心价值分叉创建新人格版本 */
  create(label: string, values: ReadonlyMap<string, number>, resourceQuota: number): PersonaVersion {
    this.validateQuota(resourceQuota);
    const id = generatePrefixedId('persona');
    const now = this.clock.now();
    this.tx.execute(pengCmdCreate({
      id, label, valuesJson: mapToJson(values), resourceQuota, now,
    }));
    return {
      id, label, values, status: 'active',
      results: [], resourceQuota, createdAt: now, updatedAt: now,
    };
  }

  /** 更新人格状态 */
  setStatus(id: PersonaVersionId, status: PersonaStatus): boolean {
    const now = this.clock.now();
    const result = this.tx.execute(pengCmdSetStatus({ id, status, now }));
    return result.rowsAffected > 0;
  }

  /** 追加模拟结果 */
  addResult(id: PersonaVersionId, simResult: SimulationResult): boolean {
    const persona = this.getById(id);
    if (!persona) return false;
    const results = [...persona.results, simResult];
    const now = this.clock.now();
    this.tx.execute(pengCmdSetResults({ id, resultsJson: deepStringify(results), now }));
    return true;
  }

  /** 更新资源配额 */
  setQuota(id: PersonaVersionId, quota: number): boolean {
    this.validateQuota(quota);
    const now = this.clock.now();
    const result = this.tx.execute(pengCmdSetQuota({ id, quota, now }));
    return result.rowsAffected > 0;
  }

  /** 按 ID 获取 */
  getById(id: PersonaVersionId): PersonaVersion | undefined {
    const row = this.tx.queryOne(pengQueryById(id));
    return row ? this.toPersona(row) : undefined;
  }

  /** 获取所有活跃版本 */
  getActive(): PersonaVersion[] {
    const rows = this.tx.queryMany(pengQueryActive()) as unknown as PengRow[];
    return rows.map(r => this.toPersona(r));
  }

  /** 获取全部版本 */
  getAll(): PersonaVersion[] {
    const rows = this.tx.queryMany(pengQueryAll()) as unknown as PengRow[];
    return rows.map(r => this.toPersona(r));
  }

  /** 删除版本 */
  delete(id: PersonaVersionId): boolean {
    const result = this.tx.execute(pengCmdDelete(id));
    return result.rowsAffected > 0;
  }

  /** 删除所有版本 */
  deleteAll(): void {
    this.tx.execute(pengCmdDeleteAll());
  }

  /** 按原始数据插入（恢复用，保留原 ID 和所有字段） */
  insertRaw(persona: PersonaVersion): void {
    this.tx.execute(pengCmdInsertRaw({
      id: persona.id,
      label: persona.label,
      valuesJson: mapToJson(persona.values),
      status: persona.status,
      resultsJson: deepStringify(persona.results),
      resourceQuota: persona.resourceQuota,
      createdAt: persona.createdAt,
      updatedAt: persona.updatedAt,
    }));
  }

  private validateQuota(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`资源配额必须在 0-1 之间，收到 ${value}`);
    }
  }

  private toPersona(row: PengRow): PersonaVersion {
    const status = VALID_STATUSES.has(row.status) ? row.status as PersonaStatus : 'failed';
    return {
      id: row.id,
      label: row.label,
      values: jsonToMap<number>(row.values_json),
      status,
      results: deepParse<SimulationResult[]>(row.results_json) ?? [],
      resourceQuota: row.resource_quota,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
