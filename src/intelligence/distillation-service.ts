/**
 * 蒸馏服务（ADR-0047 D3）— LLM 教学输出 → 确定性内核的门控管线编排。
 *
 * 不变量（D3）：LLM 输出永不直接写核心状态。每件工件先落库为 candidate，经：
 *   1. validateArtifact（结构校验，畸形拒绝）
 *   2. canAutoCompile（置信度 + 交叉验证门）→ 自动编译；否则留待人工审批
 *   3. 编译前快照、失败回滚（编译是对 core 的破坏性写，必须可回滚）
 *   4. transitionArtifact（状态机唯一写入口）+ 持久化 + 审计事件
 *
 * 纯确定性：本服务不调用 LLM。candidate 的来源（reflection/conversation/
 * knowledge_import/onboarding）由调用方在 growth 模式下产出后交给本服务门控。
 */

import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../utils/logger.js';
import type { Clock } from '../utils/clock.js';
import type { DistilledArtifactStore } from '../storage/distilled-artifact-store.js';
import type { ArtifactCompiler } from './artifact-compiler.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import {
  validateArtifact, canAutoCompile, canTransition,
  DEFAULT_DISTILLATION_POLICY,
  type DistilledArtifact,
  type DistillationPolicy,
  type ArtifactKind,
  type ArtifactSource,
  type ArtifactEvidence,
  type ArtifactStatus,
} from '@chrono/kernel';

const LAYER = 'DistillationService';

/** 蒸馏候选输入（调用方提供；service 负责赋 id/createdAt/status） */
export interface CandidateInput {
  readonly kind: ArtifactKind;
  readonly source: ArtifactSource;
  readonly payload: unknown;
  readonly confidence: number;
  readonly evidence: readonly ArtifactEvidence[];
}

export type IngestResult =
  | { readonly status: 'compiled'; readonly artifact: DistilledArtifact }
  | { readonly status: 'pending'; readonly artifact: DistilledArtifact }
  | { readonly status: 'rejected'; readonly reason: string; readonly problems: readonly string[] };

export type ReviewResult =
  | { readonly ok: true; readonly artifact: DistilledArtifact }
  | { readonly ok: false; readonly reason: string };

/** ChronoSynthOS 注入的快照/回滚钩子（解耦，便于测试） */
export interface SnapshotGuard {
  /** 编译前创建快照，返回快照 id */
  snapshot(): string;
  /** 失败时回滚到快照；返回是否成功 */
  rollback(snapshotId: string): boolean;
}

export interface DistillationServiceDeps {
  store: DistilledArtifactStore;
  compiler: ArtifactCompiler;
  snapshotGuard: SnapshotGuard;
  bus: EventBus;
  clock: Clock;
  logger: Logger;
  tenantId?: string;
  policy?: DistillationPolicy;
}

export class DistillationService {
  private readonly policy: DistillationPolicy;
  private readonly tenantId: string;

  constructor(private readonly deps: DistillationServiceDeps) {
    this.policy = deps.policy ?? DEFAULT_DISTILLATION_POLICY;
    this.tenantId = deps.tenantId ?? 'default';
  }

  /**
   * 摄入一个蒸馏候选：校验 → 落库 candidate → 符合门槛则自动编译，否则待审批。
   */
  ingest(personaId: string, input: CandidateInput): IngestResult {
    const artifact: DistilledArtifact = {
      id: generatePrefixedId('dart'),
      kind: input.kind,
      source: input.source,
      payload: input.payload,
      confidence: input.confidence,
      evidence: input.evidence,
      status: 'candidate',
      createdAt: this.deps.clock.now(),
    };

    const problems = validateArtifact(artifact);
    if (problems.length > 0) {
      this.deps.logger.warn(LAYER, `候选被拒（校验失败）: ${problems.join('; ')}`);
      return { status: 'rejected', reason: 'validation failed', problems };
    }

    this.deps.store.insert(personaId, artifact);

    if (canAutoCompile(artifact, this.policy)) {
      const compiled = this.compileAndPersist(personaId, artifact);
      if (compiled) return { status: 'compiled', artifact: compiled };
      /* 编译失败已回滚 + 标记 rejected；返回 pending 语义不准确，按 rejected 返回 */
      return { status: 'rejected', reason: 'auto-compile failed and rolled back', problems: [] };
    }

    this.deps.logger.info(LAYER, `候选入库待审批: ${artifact.id} [${artifact.kind}]`);
    return { status: 'pending', artifact };
  }

  /** 人工审批：candidate → approved → 编译（带快照/回滚）。personaId 强制对象级授权 */
  approve(personaId: string, artifactId: string): ReviewResult {
    const artifact = this.deps.store.getById(personaId, artifactId);
    if (!artifact) return { ok: false, reason: 'artifact not found' };
    if (artifact.status !== 'candidate') {
      return { ok: false, reason: `cannot approve from status ${artifact.status}` };
    }
    const problems = validateArtifact(artifact);
    if (problems.length > 0) {
      return { ok: false, reason: `invalid artifact: ${problems.join('; ')}` };
    }
    /* candidate → approved（乐观并发 + 对象级授权持久化） */
    if (!this.deps.store.setStatus(personaId, artifactId, 'candidate', 'approved', 'manually approved', null)) {
      return { ok: false, reason: 'status changed concurrently' };
    }
    const compiled = this.compileApproved(personaId, { ...artifact, status: 'approved' });
    return compiled
      ? { ok: true, artifact: compiled }
      : { ok: false, reason: 'compile failed and rolled back' };
  }

  /** 人工拒绝：candidate → rejected。personaId 强制对象级授权 */
  reject(personaId: string, artifactId: string, reason: string): ReviewResult {
    const artifact = this.deps.store.getById(personaId, artifactId);
    if (!artifact) return { ok: false, reason: 'artifact not found' };
    if (!canTransition(artifact.status, 'rejected')) {
      return { ok: false, reason: `cannot reject from status ${artifact.status}` };
    }
    if (!this.deps.store.setStatus(personaId, artifactId, artifact.status, 'rejected', reason, null)) {
      return { ok: false, reason: 'status changed concurrently' };
    }
    this.deps.logger.info(LAYER, `工件已拒绝: ${artifactId} (${reason})`);
    return { ok: true, artifact: { ...artifact, status: 'rejected' } };
  }

  listCandidates(personaId: string): DistilledArtifact[] {
    return this.deps.store.listByStatus(personaId, 'candidate');
  }

  listByPersona(personaId: string): DistilledArtifact[] {
    return this.deps.store.listByPersona(personaId);
  }

  /** 自动编译路径：candidate → approved → compiled（带快照/回滚） */
  private compileAndPersist(personaId: string, artifact: DistilledArtifact): DistilledArtifact | undefined {
    if (!this.deps.store.setStatus(personaId, artifact.id, 'candidate', 'approved', 'auto-approved', null)) {
      this.deps.logger.warn(LAYER, `自动编译前置状态推进失败: ${artifact.id}`);
      return undefined;
    }
    return this.compileApproved(personaId, { ...artifact, status: 'approved' });
  }

  /** approved → compiled：快照 → 编译 → 失败回滚 + 标记终态（rejected/rolled_back） */
  private compileApproved(personaId: string, artifact: DistilledArtifact): DistilledArtifact | undefined {
    const snapshotId = this.deps.snapshotGuard.snapshot();
    const outcome = this.deps.compiler.compile(artifact);

    if (!outcome.ok) {
      const restored = this.deps.snapshotGuard.rollback(snapshotId);
      this.deps.store.setStatus(personaId, artifact.id, 'approved', 'rejected', `compile failed: ${outcome.reason}`, null);
      this.deps.logger.warn(LAYER, `编译失败已回滚(${restored ? 'ok' : 'FAILED'}): ${artifact.id} — ${outcome.reason}`);
      return undefined;
    }

    const compiledAt = this.deps.clock.now();
    if (!this.deps.store.setStatus(personaId, artifact.id, 'approved', 'compiled', `compiled: ${outcome.applied}`, compiledAt)) {
      /* 状态被并发改动：回滚已应用的核心写，并把工件推进到终态 rejected，
       * 不留 approved 悬挂（否则可被重复编译）。approved→rejected 是合法转移。
       * 注意：此 setStatus 仍带 expectedStatus='approved'——若是因并发已离开 approved
       * 则此次更新不命中（rowsAffected=0），不会误改他方推进后的状态。 */
      this.deps.snapshotGuard.rollback(snapshotId);
      this.deps.store.setStatus(personaId, artifact.id, 'approved', 'rejected', 'compiled but status advance failed; rolled back', null);
      this.deps.logger.warn(LAYER, `编译后状态推进失败，已回滚并标记 rejected: ${artifact.id}`);
      return undefined;
    }

    const compiled: DistilledArtifact = { ...artifact, status: 'compiled', compiledAt };
    this.deps.bus.emit('system:artifact-compiled', {
      artifactId: artifact.id, personaId, kind: artifact.kind, tenantId: this.tenantId,
    });
    this.deps.logger.info(LAYER, `工件已编译进内核: ${artifact.id} [${artifact.kind}] — ${outcome.applied}`);
    return compiled;
  }
}

export type { ArtifactStatus };
