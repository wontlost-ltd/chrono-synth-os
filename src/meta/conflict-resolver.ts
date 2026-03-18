/**
 * 冲突解决器 — 薄适配器，委托 kernel 领域逻辑
 * 纯计算（分歧检测、严重性分类）在 kernel，SQL 留在此处
 */

import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork, ConflictRow } from '@chrono/kernel';
import {
  conflictQueryUnresolved, conflictQueryAll,
  conflictCmdRecord, conflictCmdResolve, conflictCmdDeleteAll, conflictCmdRestore,
} from '@chrono/kernel';
import { arrayToJson, jsonToArray } from '../storage/serialization.js';
import type { Conflict, ConflictKind, ConflictSeverity } from '../types/meta-regulation.js';
import type { PersonaVersion } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import {
  detectValueDivergences, detectResourceContention, pairKey,
} from '@chrono/kernel';
import type { PersonaVersionSnapshot } from '@chrono/kernel';
import { directUnitOfWork } from '../storage/direct-uow-adapter.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

const VALID_KINDS = new Set<string>(['value_divergence', 'resource_contention', 'narrative_inconsistency']);
const VALID_SEVERITIES = new Set<string>(['low', 'medium', 'high', 'critical']);

export class ConflictResolver {
  private readonly tx: SyncWriteUnitOfWork;

  constructor(
    db: IDatabase,
    private readonly clock: Clock,
  ) {
    registerCoreSelfExecutors();
    this.tx = directUnitOfWork(db);
  }

  /** 检测价值分歧冲突（跳过已存在未解决冲突的版本对） */
  detectValueDivergence(personas: readonly PersonaVersion[], threshold = 0.3): Conflict[] {
    const existing = this.getUnresolved();
    const existingPairs = new Set(
      existing
        .filter(c => c.kind === 'value_divergence')
        .map(c => pairKey(c.involvedVersions)),
    );

    const snapshots: PersonaVersionSnapshot[] = personas.map(p => ({
      id: p.id,
      label: p.label,
      values: p.values,
      status: p.status,
      resourceQuota: p.resourceQuota,
    }));

    const divergences = detectValueDivergences(snapshots, threshold, existingPairs);
    const conflicts: Conflict[] = [];

    for (const d of divergences) {
      const conflict = this.record({
        kind: 'value_divergence',
        severity: d.severity,
        involvedVersions: [...d.involvedVersions],
        affectedValues: d.affectedValues,
        description: d.description,
      });
      conflicts.push(conflict);
    }

    return conflicts;
  }

  /** 检测资源争用冲突（跳过已有未解决的资源冲突） */
  detectResourceContention(personas: readonly PersonaVersion[]): Conflict | undefined {
    const existing = this.getUnresolved();
    if (existing.some(c => c.kind === 'resource_contention')) return undefined;

    const snapshots: PersonaVersionSnapshot[] = personas.map(p => ({
      id: p.id,
      label: p.label,
      values: p.values,
      status: p.status,
      resourceQuota: p.resourceQuota,
    }));

    const result = detectResourceContention(snapshots);
    if (!result) return undefined;

    return this.record({
      kind: 'resource_contention',
      severity: result.severity,
      involvedVersions: result.involvedVersions,
      affectedValues: [],
      description: result.description,
    });
  }

  /** 解决冲突 */
  resolve(conflictId: string, resolution: string): boolean {
    const now = this.clock.now();
    const result = this.tx.execute(conflictCmdResolve({ id: conflictId, resolvedAt: now, resolution }));
    return result.rowsAffected > 0;
  }

  /** 获取未解决的冲突 */
  getUnresolved(): Conflict[] {
    const rows = [...this.tx.queryMany(conflictQueryUnresolved())] as unknown as ConflictRow[];
    return rows.map(r => this.toConflict(r));
  }

  /** 获取所有冲突 */
  getAll(): Conflict[] {
    const rows = [...this.tx.queryMany(conflictQueryAll())] as unknown as ConflictRow[];
    return rows.map(r => this.toConflict(r));
  }

  /** 从快照恢复冲突（清空后重建；调用方负责事务保护） */
  restoreConflicts(conflicts: readonly Conflict[]): void {
    this.tx.execute(conflictCmdDeleteAll());
    for (const c of conflicts) {
      this.tx.execute(conflictCmdRestore({
        id: c.id,
        kind: c.kind,
        severity: c.severity,
        involvedVersionsJson: arrayToJson(c.involvedVersions as string[]),
        affectedValuesJson: arrayToJson(c.affectedValues as string[]),
        description: c.description,
        detectedAt: c.detectedAt,
        resolvedAt: c.resolvedAt ?? null,
        resolution: c.resolution ?? null,
      }));
    }
  }

  private record(params: {
    kind: ConflictKind;
    severity: ConflictSeverity;
    involvedVersions: string[];
    affectedValues: string[];
    description: string;
  }): Conflict {
    const id = generatePrefixedId('conflict');
    const now = this.clock.now();
    this.tx.execute(conflictCmdRecord({
      id,
      kind: params.kind,
      severity: params.severity,
      involvedVersionsJson: arrayToJson(params.involvedVersions),
      affectedValuesJson: arrayToJson(params.affectedValues),
      description: params.description,
      detectedAt: now,
    }));
    return {
      id,
      kind: params.kind,
      severity: params.severity,
      involvedVersions: params.involvedVersions,
      affectedValues: params.affectedValues,
      description: params.description,
      detectedAt: now,
    };
  }

  private toConflict(row: ConflictRow): Conflict {
    const kind = VALID_KINDS.has(row.kind) ? row.kind as ConflictKind : 'value_divergence';
    const severity = VALID_SEVERITIES.has(row.severity) ? row.severity as ConflictSeverity : 'low';
    return {
      id: row.id,
      kind,
      severity,
      involvedVersions: jsonToArray<string>(row.involved_versions_json),
      affectedValues: jsonToArray<string>(row.affected_values_json),
      description: row.description,
      detectedAt: row.detected_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolution: row.resolution ?? undefined,
    };
  }
}
