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
 * knowledge_import/onboarding/perception）由调用方在 growth 模式下产出后交给本服务门控。
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
  type CompiledVia,
} from '@chrono/kernel';

const LAYER = 'DistillationService';
/* compile mutex 存活时长：远大于单次编译耗时，仅在持有者崩溃后供抢占。 */
const COMPILE_LEASE_TTL_MS = 60_000;
/**
 * 待修标记前缀（ADR-0047 F3 debt 收口）：编译后补偿**回滚失败**时，工件被迫保留 approved（核心可能已脏），
 * 其 reason 打上本前缀。approve() 见此前缀即**拒绝重编译**——把「approved 假可重试」与「待修（核心可能不一致）」
 * 从语义上分开，避免人工/巡检误触 approve 二次编译污染核心。用 reason 前缀而非新增 status：distilled_artifacts
 * 的 status CHECK 改动需核心表 rebuild 迁移（本仓刻意避免，见 perception 复用既有 source 值的先例），
 * reason 标记是等效且零迁移的守卫。修复流程另行处置带此标记的工件（回滚核心 / 人工核对后显式清标记）。
 */
export const NEEDS_REPAIR_REASON_PREFIX = 'NEEDS_REPAIR: ';

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
  /**
   * 编译前创建快照，返回快照 id。
   * personaId（ADR-0056 K5）：快照该 persona 自己的内核——读写对称，编译写哪个 persona core，
   * 回滚就恢复哪个。省略回落 default（向后兼容）。
   */
  snapshot(personaId?: string): string;
  /** 失败时回滚到快照（快照已记录其 persona，恢复时自动恢复同一 persona）；返回是否成功 */
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
   * per-persona 不确定性预算解析器（可选 DI）：给定 personaId 返回该 persona 的预算上限覆盖，
   * 无覆盖返回 undefined（回退全局 policy 预算）。未注入 → 始终用全局 policy 预算（向后兼容）。
   * 由 app 接线为查 governance store（避免 DistillationService 直依赖 governance store）。
   */
  budgetResolver?: (personaId: string) => number | undefined;
  /**
   * 租户级全局 compile mutex（ADR-0047 多实例 gating item）。可选：未注入时为
   * 单进程同步语义（向后兼容）；注入后用 GLOBAL_LEASE_PERSONA_ID 串行化整个租户的
   * 编译。**仍是租户级全局而非 per-persona**：ADR-0056 K5 后 coreSelf 快照/回滚已按 persona
   * 隔离，且 rollback 用 coreSelfOnly（不再恢复租户级状态）。保持租户级全局的原因转为：
   * value_shift/memory_edge 底层 ValueStore/CognitiveMemoryGraph 仍 tenant 共享（K5b 前），不同
   * persona 的并发编译会在这些**共享价值/记忆**上互相覆盖；待 K5b 宽表 persona-aware 后可重新评估
   * 是否降为 per-persona 锁。
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

    /* 不确定性预算（ADR-0047 成长治理）：本条满足自动编译门，但若该 persona 在窗口内已 auto-compiled
     * 的未验证(distilled)工件数达预算上限，则**降级人工审批**——防止短期吸收过多未验证成长侵蚀核心人格。
     * 此处仅是**快速短路**（明显超预算就不必抢锁）；预算的**权威判定在 compile 锁内**由 compileAndPersist
     * 重查——否则多实例并发在此各读 count<预算、各自过关、各自编译，绕过上限（TOCTOU，功能评审 Codex 确认 High）。 */
    if (canAutoCompile(artifact, this.policy)) {
      if (this.unverifiedGrowthBudgetExceeded(personaId)) {
        this.deps.logger.info(LAYER, `候选入库待审批（预算已用尽，降级人工）: ${artifact.id} [${artifact.kind}]`);
        return { status: 'pending', artifact };
      }
      const compiled = this.compileAndPersist(personaId, artifact);
      if (compiled === 'lease_busy') {
        /* 全局 compile 锁被占：TOCTOU 修复后 candidate→approved 推进已移进锁内，本路径**未进锁**，
         * 故工件此刻**仍是 candidate**（不再谎报 approved）。按 pending 返回（非失败），留待重试
         * ——重试入口 approve() 对 candidate/approved 均可编译，故 candidate 直接可重编。 */
        return { status: 'pending', artifact };
      }
      if (compiled === 'budget_exceeded') {
        /* 锁内重查预算已用尽（并发实例先落编译，抢占了额度）：工件仍留 candidate，降级人工审批。 */
        this.deps.logger.info(LAYER, `候选入库待审批（锁内复核预算已用尽，降级人工）: ${artifact.id} [${artifact.kind}]`);
        return { status: 'pending', artifact };
      }
      if (compiled) return { status: 'compiled', artifact: compiled };
      /* 编译失败已回滚 + 标记 rejected；返回 pending 语义不准确，按 rejected 返回 */
      return { status: 'rejected', reason: 'auto-compile failed and rolled back', problems: [] };
    }

    this.deps.logger.info(LAYER, `候选入库待审批: ${artifact.id} [${artifact.kind}]`);
    return { status: 'pending', artifact };
  }

  /**
   * 不确定性预算判定：该 persona 在 unverifiedGrowthWindowMs 窗口内已 auto-compiled 的 distilled 工件数
   * 是否达预算上限。用 store SQL COUNT（status=compiled ∧ compiled_via='auto' ∧ compiled_at≥窗口起点）——
   * 只数 auto（未验证）；人工审批(approved)已验证、历史(null)保守，均不计入。SQL COUNT 取代 listByPersona
   * 全表扫（Codex 复审性能债已还清）。默认预算极大 → 恒 false（向后兼容，不限，跳过查询）。
   */
  private unverifiedGrowthBudgetExceeded(personaId: string): boolean {
    /* per-persona 覆盖优先（owner 经 governance 配置）；无覆盖回退全局 policy 预算。 */
    const budget = this.deps.budgetResolver?.(personaId) ?? this.policy.unverifiedGrowthBudgetPerWindow;
    if (budget >= Number.MAX_SAFE_INTEGER) return false; /* 不限：跳过统计开销 */
    const windowStart = this.deps.clock.now() - this.policy.unverifiedGrowthWindowMs;
    const count = this.deps.store.countAutoCompiledSince(personaId, windowStart);
    if (count >= budget) {
      this.deps.logger.info(LAYER, `不确定性预算已用尽 persona=${personaId} (${count}≥${budget})，降级人工审批`);
      return true;
    }
    return false;
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
      /* F3 待修守卫：若该 approved 工件带 NEEDS_REPAIR 标记（上次编译后补偿回滚失败，核心可能已脏），
       * **拒绝重编译**——避免在可能不一致的核心上再次编译加剧污染。须由修复流程核对/回滚核心后显式清标记。 */
      if (artifact.reason?.startsWith(NEEDS_REPAIR_REASON_PREFIX)) {
        return { ok: false, reason: `artifact needs repair (prior compensation rollback failed); manual repair required before recompile: ${artifact.reason}` };
      }
      const retryProblems = validateArtifact(artifact);
      if (retryProblems.length > 0) {
        return { ok: false, reason: `invalid artifact: ${retryProblems.join('; ')}` };
      }
      /* via='approved'：人工审批路径——已验证，不进未确定性预算统计。 */
      return this.finishCompile(personaId, this.compileApproved(personaId, artifact, 'approved'));
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
    /* via='approved'：人工审批路径——已验证，不进未确定性预算统计。 */
    return this.finishCompile(personaId, this.compileApproved(personaId, { ...artifact, status: 'approved' }, 'approved'));
  }

  /** 把 compileApproved 的结果（编译件 / lease_busy / budget_exceeded / undefined）映射为 ReviewResult。 */
  private finishCompile(_personaId: string, compiled: DistilledArtifact | 'lease_busy' | 'budget_exceeded' | undefined): ReviewResult {
    if (compiled === 'budget_exceeded') {
      /* 人工审批路径不查预算（checkBudget=false），理论不可达；防御性映射为失败，不静默当成功。 */
      return { ok: false, reason: 'compile skipped: uncertainty budget exceeded' };
    }
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

  /**
   * 自动编译路径：candidate → approved → compiled（带快照/回滚）。
   * **candidate→approved 推进与预算复核都在 compile 锁内**（checkBudget=true）——预算权威判定必须与编译原子，
   * 否则多实例各自锁外读预算过关、各自编译、绕过上限（TOCTOU）。锁内复核超预算 → 工件留 candidate，返回
   * 'budget_exceeded' 降级人工。
   */
  private compileAndPersist(personaId: string, artifact: DistilledArtifact): DistilledArtifact | 'lease_busy' | 'budget_exceeded' | undefined {
    /* via='auto'：自动编译路径——记为未验证成长，进不确定性预算统计。传 candidate 工件，锁内再推进到 approved。 */
    return this.compileApproved(personaId, artifact, 'auto', true);
  }

  /**
   * approved → compiled，受 **租户级全局 compile mutex** 保护（ADR-0047 多实例 gating）。
   *
   * 锁粒度是全局而非 per-persona：ADR-0056 K5 后 coreSelf 快照/回滚已按 persona 隔离，且 rollback 用
   * coreSelfOnly（不再恢复租户级状态）。保持全局的原因转为 value_shift/memory_edge 底层 ValueStore/
   * CognitiveMemoryGraph 仍 tenant 共享（K5b 前），不同 persona 的并发编译会在这些**共享价值/记忆**上互相
   * 覆盖，故仍必须互斥。用 GLOBAL_LEASE_PERSONA_ID 让全租户编译竞争同一把锁。
   * 锁覆盖快照→编译→状态推进→补偿全程。未注入 leaseStore = 单进程同步语义。
   * 拿不到锁说明另一实例/另一 persona 正在编译，返回 'lease_busy' 待重试。此时工件状态**取决于入锁前进度**：
   * 自动路径（checkBudget=true，candidate→approved 推进已移进锁内）拿不到锁时**仍是 candidate**；人工 approve
   * 路径传入的已是 approved 工件，故仍 approved。两者的重试入口都是 approve()（对 candidate/approved 均可编译）。
   */
  private compileApproved(personaId: string, artifact: DistilledArtifact, via: CompiledVia, checkBudget = false): DistilledArtifact | 'lease_busy' | 'budget_exceeded' | undefined {
    if (!this.deps.leaseStore) {
      return this.compileApprovedLocked(personaId, artifact, via, checkBudget);
    }
    const handle: LeaseHandle | null = this.deps.leaseStore.acquire(
      GLOBAL_LEASE_PERSONA_ID, 'compile', this.deps.clock.now(), COMPILE_LEASE_TTL_MS,
    );
    if (!handle) {
      this.deps.logger.warn(LAYER, `编译延后：全局 compile 锁被占用，另一编译进行中（persona=${personaId}）`);
      return 'lease_busy';
    }
    try {
      return this.compileApprovedLocked(personaId, artifact, via, checkBudget);
    } finally {
      this.deps.leaseStore.release(handle);
    }
  }

  /**
   * 编译主体：持有 compile 锁（如启用）期间执行。via 标记编译路径（auto/approved），随状态推进落库。
   * checkBudget（仅自动路径 true）：**在锁内**复核不确定性预算——此刻锁串行化全租户编译，COUNT 已含所有并发
   * 实例先前落库的编译，是权威判定。超预算 → 不推进不编译，工件留 candidate，返回 'budget_exceeded' 降级人工。
   * 传入的 artifact 为 candidate（自动路径）时，candidate→approved 推进也在锁内做（预算通过后），保证
   * {复核预算 → approve → compile} 三步对其他编译者原子。
   */
  private compileApprovedLocked(personaId: string, artifact: DistilledArtifact, via: CompiledVia, checkBudget = false): DistilledArtifact | 'budget_exceeded' | undefined {
    /* 锁内预算权威复核（仅自动路径）：并发实例可能在本次抢锁前已把额度用满。 */
    if (checkBudget && this.unverifiedGrowthBudgetExceeded(personaId)) {
      return 'budget_exceeded';
    }
    /* 自动路径：candidate→approved 推进移进锁内（预算通过后再 approve），使预算判定与编译原子。 */
    let approved = artifact;
    if (artifact.status === 'candidate') {
      if (!this.deps.store.setStatus(personaId, artifact.id, 'candidate', 'approved', 'auto-approved', null)) {
        this.deps.logger.warn(LAYER, `自动编译前置状态推进失败: ${artifact.id}`);
        return undefined;
      }
      approved = { ...artifact, status: 'approved' };
    }
    /* 快照该 persona 自己的内核（ADR-0056 K5）：编译落 getCore(personaId)，回滚也恢复同一 persona。 */
    const snapshotId = this.deps.snapshotGuard.snapshot(personaId);
    const outcome = this.deps.compiler.compile(personaId, approved);

    if (!outcome.ok) {
      /* 编译失败：与编译后失败走同一安全补偿（rollback/reject 各自 try/catch） */
      this.compensateAfterCompile(personaId, approved.id, snapshotId, `compile failed: ${outcome.reason}`);
      return undefined;
    }

    /* 编译已应用到核心。推进工件到 compiled——这一步无论是返回 false（并发/未命中）
     * 还是抛异常（DB 锁/连接错误），都必须补偿：回滚核心写 + 标记终态，
     * 否则会留下"核心已变更 + 工件悬挂 approved"的不一致。 */
    const compiledAt = this.deps.clock.now();
    let advanced = false;
    try {
      advanced = this.deps.store.setStatus(personaId, approved.id, 'approved', 'compiled', `compiled: ${outcome.applied}`, compiledAt, via);
    } catch (err) {
      this.compensateAfterCompile(personaId, approved.id, snapshotId, `status advance threw: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    if (!advanced) {
      this.compensateAfterCompile(personaId, approved.id, snapshotId, 'status advance not applied (concurrent change)');
      return undefined;
    }

    const compiled: DistilledArtifact = { ...approved, status: 'compiled', compiledAt };
    this.deps.bus.emit('system:artifact-compiled', {
      artifactId: approved.id, personaId, kind: approved.kind, tenantId: this.tenantId,
    });
    this.deps.logger.info(LAYER, `工件已编译进内核: ${approved.id} [${approved.kind}] — ${outcome.applied}`);
    return compiled;
  }

  /**
   * 编译已应用但工件状态未能推进到 compiled 时的补偿：回滚核心写 + best-effort 标记 rejected。
   *
   * 两步非原子（快照恢复 + 状态标记不在同一事务）。关键一致性守则（全维评审 F3，Codex 确认）：
   * **回滚失败时绝不把工件标 rejected**——否则会留下「核心已脏（回滚没成功）但工件看似 rejected 已了结」的
   * 隐蔽不一致（比悬挂 approved 更危险，因为看起来已解决、巡检不会发现）。故回滚失败 → 保留工件 approved
   * 作为**可见的待修信号**，并计 step='rollback' 指标；只有回滚成功后才标 rejected 收尾。
   * 回滚成功但标记失败 → 工件悬挂 approved（可重试/巡检），计 step='reject' 指标——这是安全侧不一致。
   */
  private compensateAfterCompile(personaId: string, artifactId: string, snapshotId: string, why: string): void {
    let restored = false;
    try {
      restored = this.deps.snapshotGuard.rollback(snapshotId);
    } catch (err) {
      this.deps.logger.error(LAYER, `补偿回滚抛异常: ${artifactId} — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!restored) {
      /* 回滚未成功：核心可能已脏。**不**标 rejected——保留 approved 作为待修信号，避免「假了结」掩盖核心不一致。
       * 同时给 reason 打上 NEEDS_REPAIR 前缀（approved→approved 自转移写 reason），使 approve() 拒绝重编译
       * （F3：区分「待修·核心可能脏」与「approved·干净可重试」）。写标记 best-effort，失败也已有指标+日志兜底。 */
      distillationCompensationFailures.add(1, { step: 'rollback' });
      try {
        this.deps.store.setStatus(personaId, artifactId, 'approved', 'approved', `${NEEDS_REPAIR_REASON_PREFIX}${why}`, null);
      } catch (err) {
        this.deps.logger.error(LAYER, `补偿写待修标记抛异常: ${artifactId} — ${err instanceof Error ? err.message : String(err)}`);
      }
      this.deps.logger.error(LAYER, `编译后补偿(${why}): rollback=FAILED → 工件标记 NEEDS_REPAIR（核心可能不一致，approve 将拒绝重编译，待修复流程处置）— ${artifactId}`);
      return;
    }
    /* 回滚成功，核心已复原：标记工件 rejected 收尾（approved→rejected 合法）。 */
    let marked = false;
    try {
      marked = this.deps.store.setStatus(personaId, artifactId, 'approved', 'rejected', `rolled back: ${why}`, null);
    } catch (err) {
      this.deps.logger.error(LAYER, `补偿标记 rejected 抛异常: ${artifactId} — ${err instanceof Error ? err.message : String(err)}`);
    }
    /* reject 未命中（rowsAffected=0 且未抛）通常是并发已离开 approved——非不一致；
     * 但 reject 标记彻底失败（未 marked）意味着工件可能悬挂 approved（核心已回滚，安全侧）——计需巡检指标。 */
    if (!marked) {
      distillationCompensationFailures.add(1, { step: 'reject' });
    }
    this.deps.logger.warn(LAYER, `编译后补偿(${why}): rollback=ok reject=${marked ? 'ok' : 'FAILED'} — ${artifactId}`);
  }
}

export type { ArtifactStatus };
