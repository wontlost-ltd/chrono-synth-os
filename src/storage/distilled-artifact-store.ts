/**
 * 蒸馏工件存储（ADR-0047）— 薄适配器，委托 kernel query/command。
 *
 * 负责持久化与行↔领域对象映射；纯决策逻辑（validateArtifact / canAutoCompile /
 * transitionArtifact）在 kernel。payload/evidence 以 JSON 文本落库，读出时解析。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  distillQueryById, distillQueryByPersona, distillQueryByStatus,
  distillCmdInsert, distillCmdSetStatus,
  type DistilledArtifact,
  type DistilledArtifactRow,
  type ArtifactKind,
  type ArtifactSource,
  type ArtifactStatus,
  type ArtifactEvidence,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';

export class DistilledArtifactStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /** 插入新候选工件（调用方应已设 status='candidate'） */
  insert(personaId: string, artifact: DistilledArtifact): void {
    this.tx.execute(distillCmdInsert({
      id: artifact.id,
      tenantId: this.tenantId,
      personaId,
      kind: artifact.kind,
      source: artifact.source,
      payload: JSON.stringify(artifact.payload),
      confidence: artifact.confidence,
      evidence: JSON.stringify(artifact.evidence),
      status: artifact.status,
      reason: null,
      createdAt: artifact.createdAt,
    }));
  }

  /**
   * 推进状态（乐观并发：仅当当前状态 = expectedStatus 才更新）。
   * 返回是否成功（rowsAffected > 0）。
   */
  setStatus(
    id: string,
    expectedStatus: ArtifactStatus,
    next: ArtifactStatus,
    reason: string | null,
    compiledAt: number | null,
  ): boolean {
    const result = this.tx.execute(distillCmdSetStatus({
      id,
      tenantId: this.tenantId,
      expectedStatus,
      status: next,
      reason,
      compiledAt,
    }));
    return result.rowsAffected > 0;
  }

  getById(id: string): DistilledArtifact | undefined {
    const row = this.tx.queryOne(distillQueryById(id));
    return row ? this.toArtifact(row) : undefined;
  }

  listByPersona(personaId: string): DistilledArtifact[] {
    const rows = [...this.tx.queryMany(distillQueryByPersona({ tenantId: this.tenantId, personaId }))];
    return rows.map((r) => this.toArtifact(r));
  }

  listByStatus(personaId: string, status: ArtifactStatus): DistilledArtifact[] {
    const rows = [...this.tx.queryMany(distillQueryByStatus({ tenantId: this.tenantId, personaId, status }))];
    return rows.map((r) => this.toArtifact(r));
  }

  private toArtifact(row: DistilledArtifactRow): DistilledArtifact {
    const base: DistilledArtifact = {
      id: row.id,
      kind: row.kind as ArtifactKind,
      source: row.source as ArtifactSource,
      payload: safeParse(row.payload, {}),
      confidence: row.confidence,
      evidence: safeParse<ArtifactEvidence[]>(row.evidence, []),
      status: row.status as ArtifactStatus,
      createdAt: row.created_at,
    };
    return row.compiled_at !== null ? { ...base, compiledAt: row.compiled_at } : base;
  }
}

/** 安全解析 JSON；失败回退默认值（畸形持久化数据不应使读路径崩溃） */
function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
