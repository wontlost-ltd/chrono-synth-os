/**
 * 人格引擎：管理人格版本的创建、状态转换和持久化
 */

import type { IDatabase } from '../storage/database.js';
import { mapToJson, jsonToMap, deepStringify, deepParse } from '../storage/serialization.js';
import type { PersonaVersion, PersonaVersionId, PersonaStatus, SimulationResult } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';

interface PersonaRow {
  id: string;
  label: string;
  values_json: string;
  status: string;
  results_json: string;
  resource_quota: number;
  created_at: number;
  updated_at: number;
}

export class PersonaEngine {
  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
  ) {}

  /** 从核心价值分叉创建新人格版本 */
  create(label: string, values: ReadonlyMap<string, number>, resourceQuota: number): PersonaVersion {
    if (!Number.isFinite(resourceQuota) || resourceQuota < 0 || resourceQuota > 1) throw new RangeError(`资源配额必须在 0-1 之间，收到 ${resourceQuota}`);
    const id = generatePrefixedId('persona');
    const now = this.clock.now();
    this.db.prepare<void>(
      `INSERT INTO persona_versions (id, label, values_json, status, results_json, resource_quota, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '[]', ?, ?, ?)`,
    ).run(id, label, mapToJson(values), resourceQuota, now, now);
    return {
      id, label, values, status: 'active',
      results: [], resourceQuota, createdAt: now, updatedAt: now,
    };
  }

  /** 更新人格状态 */
  setStatus(id: PersonaVersionId, status: PersonaStatus): boolean {
    const now = this.clock.now();
    const result = this.db.prepare<void>(
      'UPDATE persona_versions SET status = ?, updated_at = ? WHERE id = ?',
    ).run(status, now, id);
    return result.changes > 0;
  }

  /** 追加模拟结果 */
  addResult(id: PersonaVersionId, simResult: SimulationResult): boolean {
    const persona = this.getById(id);
    if (!persona) return false;
    const results = [...persona.results, simResult];
    const now = this.clock.now();
    this.db.prepare<void>(
      'UPDATE persona_versions SET results_json = ?, updated_at = ? WHERE id = ?',
    ).run(deepStringify(results), now, id);
    return true;
  }

  /** 更新资源配额 */
  setQuota(id: PersonaVersionId, quota: number): boolean {
    if (!Number.isFinite(quota) || quota < 0 || quota > 1) throw new RangeError(`资源配额必须在 0-1 之间，收到 ${quota}`);
    const now = this.clock.now();
    const result = this.db.prepare<void>(
      'UPDATE persona_versions SET resource_quota = ?, updated_at = ? WHERE id = ?',
    ).run(quota, now, id);
    return result.changes > 0;
  }

  /** 按 ID 获取 */
  getById(id: PersonaVersionId): PersonaVersion | undefined {
    const row = this.db.prepare<PersonaRow>(
      'SELECT * FROM persona_versions WHERE id = ?',
    ).get(id);
    return row ? this.toPersona(row) : undefined;
  }

  /** 获取所有活跃版本 */
  getActive(): PersonaVersion[] {
    const rows = this.db.prepare<PersonaRow>(
      "SELECT * FROM persona_versions WHERE status = 'active'",
    ).all();
    return rows.map(r => this.toPersona(r));
  }

  /** 获取全部版本 */
  getAll(): PersonaVersion[] {
    const rows = this.db.prepare<PersonaRow>(
      'SELECT * FROM persona_versions',
    ).all();
    return rows.map(r => this.toPersona(r));
  }

  /** 删除版本 */
  delete(id: PersonaVersionId): boolean {
    const result = this.db.prepare<void>(
      'DELETE FROM persona_versions WHERE id = ?',
    ).run(id);
    return result.changes > 0;
  }

  /** 删除所有版本 */
  deleteAll(): void {
    this.db.exec('DELETE FROM persona_versions');
  }

  /** 按原始数据插入（恢复用，保留原 ID 和所有字段） */
  insertRaw(persona: PersonaVersion): void {
    this.db.prepare<void>(
      `INSERT INTO persona_versions (id, label, values_json, status, results_json, resource_quota, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, values_json=excluded.values_json, status=excluded.status, results_json=excluded.results_json, resource_quota=excluded.resource_quota, created_at=excluded.created_at, updated_at=excluded.updated_at`,
    ).run(
      persona.id, persona.label, mapToJson(persona.values),
      persona.status, deepStringify(persona.results),
      persona.resourceQuota, persona.createdAt, persona.updatedAt,
    );
  }

  private toPersona(row: PersonaRow): PersonaVersion {
    return {
      id: row.id,
      label: row.label,
      values: jsonToMap<number>(row.values_json),
      status: row.status as PersonaStatus,
      results: deepParse<SimulationResult[]>(row.results_json),
      resourceQuota: row.resource_quota,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
