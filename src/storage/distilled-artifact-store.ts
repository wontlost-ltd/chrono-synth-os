/**
 * 蒸馏工件存储（ADR-0047）— 薄适配器，委托 kernel query/command。
 *
 * 负责持久化与行↔领域对象映射；纯决策逻辑（validateArtifact / canAutoCompile /
 * transitionArtifact）在 kernel。payload/evidence 以 JSON 文本落库，读出时解析。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  distillQueryById, distillQueryByPersona, distillQueryByStatus, distillQueryCountAutoCompiled,
  distillCmdInsert, distillCmdSetStatus,
  type DistilledArtifact,
  type DistilledArtifactRow,
  type ArtifactKind,
  type ArtifactSource,
  type ArtifactStatus,
  type ArtifactEvidence,
  type CompiledVia,
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
   * 推进状态（乐观并发 + 对象级授权：仅当 id+tenant+persona+当前状态全匹配才更新）。
   * 返回是否成功（rowsAffected > 0）。
   */
  setStatus(
    personaId: string,
    id: string,
    expectedStatus: ArtifactStatus,
    next: ArtifactStatus,
    reason: string | null,
    compiledAt: number | null,
    compiledVia: CompiledVia | null = null,
  ): boolean {
    const result = this.tx.execute(distillCmdSetStatus({
      id,
      tenantId: this.tenantId,
      personaId,
      expectedStatus,
      status: next,
      reason,
      compiledAt,
      compiledVia,
    }));
    return result.rowsAffected > 0;
  }

  /** 按 id 读取，但强制 tenant + persona 归属（防 IDOR 越权） */
  getById(personaId: string, id: string): DistilledArtifact | undefined {
    const row = this.tx.queryOne(distillQueryById({ id, tenantId: this.tenantId, personaId }));
    return row ? this.toArtifact(row) : undefined;
  }

  listByPersona(personaId: string): DistilledArtifact[] {
    const rows = [...this.tx.queryMany(distillQueryByPersona({ tenantId: this.tenantId, personaId }))];
    return rows.map((r) => this.toArtifact(r));
  }

  /** 数 since 起窗口内 auto-compiled（未验证）工件数——不确定性预算用，SQL COUNT 不拉全表。 */
  countAutoCompiledSince(personaId: string, since: number): number {
    return this.tx.queryOne(distillQueryCountAutoCompiled({ tenantId: this.tenantId, personaId, since }))?.count ?? 0;
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
      ...(row.reason !== null ? { reason: row.reason } : {}),
    };
    const withCompiledAt = row.compiled_at !== null ? { ...base, compiledAt: row.compiled_at } : base;
    return row.compiled_via !== null
      ? { ...withCompiledAt, compiledVia: row.compiled_via as CompiledVia }
      : withCompiledAt;
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
