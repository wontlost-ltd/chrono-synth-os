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
import type { PersonaLeaseStore, LeaseHandle } from '../storage/persona-lease-store.js';
import type { ArtifactCompiler } from './artifact-compiler.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { distillationCompensationFailures } from '../observability/metrics.js';
import {
  validateArtifact, canAutoCompile, canTransition,
  DEFAULT_DISTILLATION_POLICY,
  GLOBAL_LEASE_PERSONA_ID,
  type DistilledArtifact,
  type DistillationPolicy,
  type ArtifactKind,
  type ArtifactSource,
  type ArtifactEvidence,
  type ArtifactStatus,
} from '@chrono/kernel';

const LAYER = 'DistillationService';
/* compile mutex 存活时长：远大于单次编译耗时，仅在持有者崩溃后供抢占。 */
const COMPILE_LEASE_TTL_MS = 60_000;

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
  /**
   * 租户级全局 compile mutex（ADR-0047 多实例 gating item）。可选：未注入时为
   * 单进程同步语义（向后兼容）；注入后用 GLOBAL_LEASE_PERSONA_ID 串行化整个租户的
   * 编译（**非 per-persona**——restoreFromSnapshot 回滚的是 system-global 快照，
   * 不同 persona 的并发编译也会互相覆盖，故必须全局互斥）。
   */
  leaseStore?: PersonaLeaseStore;
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
      if (compiled === 'lease_busy') {
        /* 全局 compile 锁被占：工件已 approved 落库，留待重试编译，按 pending 返回（非失败） */
        return { status: 'pending', artifact: { ...artifact, status: 'approved' } };
      }
      if (compiled) return { status: 'compiled', artifact: compiled };
      /* 编译失败已回滚 + 标记 rejected；返回 pending 语义不准确，按 rejected 返回 */
      return { status: 'rejected', reason: 'auto-compile failed and rolled back', problems: [] };
    }

    this.deps.logger.info(LAYER, `候选入库待审批: ${artifact.id} [${artifact.kind}]`);
    return { status: 'pending', artifact };
  }

  /**
   * 人工审批：candidate → approved → 编译（带快照/回滚）。personaId 强制对象级授权。
   *
   * 同时是 lease_busy 后的**重试入口**：若工件已是 approved（上一次因全局 compile 锁
   * 被占而 left-approved），再次调用本方法会跳过 candidate→approved，直接重试编译。
   * 这样「artifact left approved for retry」是可执行的——锁释放后重新 approve 即编译。
   */
  approve(personaId: string, artifactId: string): ReviewResult {
    const artifact = this.deps.store.getById(personaId, artifactId);
    if (!artifact) return { ok: false, reason: 'artifact not found' };

    /* 已 approved：lease_busy 后的重试路径——直接重编译，不再走 candidate→approved。
     * 防御性再校验：保持「compiled 必须来自合法工件」不变量（approved 理论上已校验过，
     * 但重试入口独立，显式校验避免被绕过）。 */
    if (artifact.status === 'approved') {
      const retryProblems = validateArtifact(artifact);
      if (retryProblems.length > 0) {
        return { ok: false, reason: `invalid artifact: ${retryProblems.join('; ')}` };
      }
      return this.finishCompile(personaId, this.compileApproved(personaId, artifact));
    }

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
    return this.finishCompile(personaId, this.compileApproved(personaId, { ...artifact, status: 'approved' }));
  }

  /** 把 compileApproved 的三态结果（编译件 / lease_busy / undefined）映射为 ReviewResult。 */
  private finishCompile(_personaId: string, compiled: DistilledArtifact | 'lease_busy' | undefined): ReviewResult {
    if (compiled === 'lease_busy') {
      /* 全局 compile 锁被占：工件已 approved，留待重试（再次 approve 即重编译）；
       * 区分于真实失败，不误导审计 */
      return { ok: false, reason: 'compile lease busy; artifact left approved for retry' };
    }
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
  private compileAndPersist(personaId: string, artifact: DistilledArtifact): DistilledArtifact | 'lease_busy' | undefined {
    if (!this.deps.store.setStatus(personaId, artifact.id, 'candidate', 'approved', 'auto-approved', null)) {
      this.deps.logger.warn(LAYER, `自动编译前置状态推进失败: ${artifact.id}`);
      return undefined;
    }
    return this.compileApproved(personaId, { ...artifact, status: 'approved' });
  }

  /**
   * approved → compiled，受 **租户级全局 compile mutex** 保护（ADR-0047 多实例 gating）。
   *
   * 锁粒度是全局而非 per-persona：编译走 system-global 的 createSnapshot/
   * restoreFromSnapshot（快照覆盖 coreSelf + 全部 personas + 全部 conflicts），
   * 所以不同 persona 的并发编译也必须互斥——否则两个 persona 各持一把 per-persona
   * 锁仍会互相覆盖全局快照。用 GLOBAL_LEASE_PERSONA_ID 让全租户编译竞争同一把锁。
   * 锁覆盖快照→编译→状态推进→补偿全程。未注入 leaseStore = 单进程同步语义。
   * 拿不到锁说明另一实例/另一 persona 正在编译，返回 'lease_busy'（工件留 approved 待重试）。
   */
  private compileApproved(personaId: string, artifact: DistilledArtifact): DistilledArtifact | 'lease_busy' | undefined {
    if (!this.deps.leaseStore) {
      return this.compileApprovedLocked(personaId, artifact);
    }
    const handle: LeaseHandle | null = this.deps.leaseStore.acquire(
      GLOBAL_LEASE_PERSONA_ID, 'compile', this.deps.clock.now(), COMPILE_LEASE_TTL_MS,
    );
    if (!handle) {
      this.deps.logger.warn(LAYER, `编译延后：全局 compile 锁被占用，另一编译进行中（persona=${personaId}）`);
      return 'lease_busy';
    }
    try {
      return this.compileApprovedLocked(personaId, artifact);
    } finally {
      this.deps.leaseStore.release(handle);
    }
  }

  /** 编译主体：持有 compile 锁（如启用）期间执行。 */
  private compileApprovedLocked(personaId: string, artifact: DistilledArtifact): DistilledArtifact | undefined {
    const snapshotId = this.deps.snapshotGuard.snapshot();
    const outcome = this.deps.compiler.compile(artifact);

    if (!outcome.ok) {
      /* 编译失败：与编译后失败走同一安全补偿（rollback/reject 各自 try/catch） */
      this.compensateAfterCompile(personaId, artifact.id, snapshotId, `compile failed: ${outcome.reason}`);
      return undefined;
    }

    /* 编译已应用到核心。推进工件到 compiled——这一步无论是返回 false（并发/未命中）
     * 还是抛异常（DB 锁/连接错误），都必须补偿：回滚核心写 + 标记终态，
     * 否则会留下"核心已变更 + 工件悬挂 approved"的不一致。 */
    const compiledAt = this.deps.clock.now();
    let advanced = false;
    try {
      advanced = this.deps.store.setStatus(personaId, artifact.id, 'approved', 'compiled', `compiled: ${outcome.applied}`, compiledAt);
    } catch (err) {
      this.compensateAfterCompile(personaId, artifact.id, snapshotId, `status advance threw: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    if (!advanced) {
      this.compensateAfterCompile(personaId, artifact.id, snapshotId, 'status advance not applied (concurrent change)');
      return undefined;
    }

    const compiled: DistilledArtifact = { ...artifact, status: 'compiled', compiledAt };
    this.deps.bus.emit('system:artifact-compiled', {
      artifactId: artifact.id, personaId, kind: artifact.kind, tenantId: this.tenantId,
    });
    this.deps.logger.info(LAYER, `工件已编译进内核: ${artifact.id} [${artifact.kind}] — ${outcome.applied}`);
    return compiled;
  }

  /**
   * 编译已应用但工件状态未能推进到 compiled 时的补偿：回滚核心写 + best-effort
   * 标记 rejected（approved→rejected 合法）。两步都记录成败，不静默失败。
   */
  private compensateAfterCompile(personaId: string, artifactId: string, snapshotId: string, why: string): void {
    let restored = false;
    try {
      restored = this.deps.snapshotGuard.rollback(snapshotId);
    } catch (err) {
      this.deps.logger.error(LAYER, `补偿回滚抛异常: ${artifactId} — ${err instanceof Error ? err.message : String(err)}`);
      distillationCompensationFailures.add(1, { step: 'rollback' });
    }
    let marked = false;
    try {
      marked = this.deps.store.setStatus(personaId, artifactId, 'approved', 'rejected', `rolled back: ${why}`, null);
    } catch (err) {
      this.deps.logger.error(LAYER, `补偿标记 rejected 抛异常: ${artifactId} — ${err instanceof Error ? err.message : String(err)}`);
    }
    /* reject 未命中（rowsAffected=0 且未抛）通常是并发已离开 approved——非不一致；
     * 但 reject 标记彻底失败（未 marked）意味着工件可能悬挂，计入需巡检指标。 */
    if (!marked) {
      distillationCompensationFailures.add(1, { step: 'reject' });
    }
    this.deps.logger.warn(LAYER, `编译后补偿(${why}): rollback=${restored ? 'ok' : 'FAILED'} reject=${marked ? 'ok' : 'FAILED'} — ${artifactId}`);
  }
}

export type { ArtifactStatus };
