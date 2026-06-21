/**
 * 执行审批 service（D2，ADR-0055）——高风险动作的人类审批门，确定性零-LLM。
 *
 * 铁律：
 *   1. 有效风险只升不降（execution-risk.assessExecutionRisk）；
 *   2. medium 上级 worker 审批有确定性边界（不自批/同 org/有效 reporting edge/默认人类）；
 *   3. requires_human 的审批**只能人类批**（上级 worker 批不算）；
 *   4. 审批门与 pipeline confirmation 叠加（本切片只管门，D3 接执行时叠加）。
 *
 * 本切片建审批门 + 决策（request/approveByHuman/approveByWorker/reject/isCleared），**不接真实执行**。
 */

import { randomUUID } from 'node:crypto';
import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgApproval, ApprovalSubjectType, RiskLevel } from './types.js';
import { assessExecutionRisk, routeApproval, type ExecutionRiskSignals } from './execution-risk.js';

/** 风险等级序（用于「批准风险不得低于本次执行有效风险」校验）。 */
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** 执行审批绑定校验的输入（D3 执行门用，确保审批确实是为「这次执行」批的）。 */
export interface ExecutionApprovalCheck {
  readonly orgId: string;
  readonly approvalId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: string;
  readonly requesterWorkerId: string;
  /** 本次执行的有效风险——批准的风险**不得低于**它（防 medium 批准放行 high 执行）。 */
  readonly effectiveRisk: RiskLevel;
}

/** 审批非法（subject 不存在/审批人无权/状态错/陈旧等）。 */
export class InvalidApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidApprovalError';
  }
}

/** request 的结果：要么直接放行（low 无需审批），要么产生一个 pending 审批。 */
export type RequestApprovalResult =
  | { readonly kind: 'auto_cleared'; readonly effectiveRisk: 'low' }
  | { readonly kind: 'pending'; readonly approval: OrgApproval };

export class ApprovalService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly now: () => number,
    private readonly idgen: () => string = randomUUID,
    private readonly tenantId: string = 'default',
  ) {}

  /**
   * 请求执行审批：确定性算有效风险 → 路由。
   *   - low → auto_cleared（无需审批）；
   *   - medium/high → 建 pending 审批（requiresHuman 据风险定）。
   * @param ttlMs 审批有效期（pending 超过则 expired，不放行）；undefined=不过期。
   */
  request(input: {
    orgId: string;
    subjectType: ApprovalSubjectType;
    subjectId: string;
    requesterWorkerId: string;
    risk: ExecutionRiskSignals;
    allowWorkerApproval: boolean;
    correlationId?: string | null;
    ttlMs?: number;
  }): RequestApprovalResult {
    if (!this.store.getWorker(input.orgId, input.requesterWorkerId)) {
      throw new InvalidApprovalError(`发起者 ${input.requesterWorkerId} 不在组织 ${input.orgId} 内`);
    }
    const assessment = assessExecutionRisk(input.risk);
    const route = routeApproval(assessment, input.allowWorkerApproval);
    if (route.kind === 'no_approval') {
      return { kind: 'auto_cleared', effectiveRisk: 'low' };
    }
    const ts = this.now();
    /* 路由结果**持久化**为 approvalMode（Codex 复审 FATAL1）：human_only 时 approveByWorker 会被挡，
     * 否则「medium + policy 关」的「只人类」策略会被上级 worker 绕过批掉。 */
    const approval: Omit<OrgApproval, 'tenantId'> = {
      id: this.idgen(), orgId: input.orgId, subjectType: input.subjectType, subjectId: input.subjectId,
      requesterWorkerId: input.requesterWorkerId, effectiveRisk: assessment.effectiveRisk,
      requiresHuman: assessment.requiresHuman,
      approvalMode: route.kind === 'org_or_human' ? 'org_or_human' : 'human_only',
      status: 'pending',
      approverWorkerId: null, approverUserId: null, reason: assessment.rationale,
      correlationId: input.correlationId ?? null, createdAt: ts,
      expiresAt: input.ttlMs !== undefined ? ts + input.ttlMs : null, decidedAt: null,
    };
    this.store.insertApproval(approval);
    return { kind: 'pending', approval: { ...approval, tenantId: this.tenantId } };
  }

  /** 人类批准（任何风险都可——人类是法律 principal）。条件转移防并发/过期。 */
  approveByHuman(orgId: string, approvalId: string, approverUserId: string): void {
    if ((approverUserId ?? '').trim().length === 0) throw new InvalidApprovalError('人类审批必须有 approverUserId');
    this.requirePending(orgId, approvalId);
    if (!this.store.decideApprovalIfPending(orgId, approvalId, 'approved', null, approverUserId, this.now())) {
      throw new InvalidApprovalError('审批已被并发响应或已过期');
    }
  }

  /**
   * 上级数字员工批准（仅 medium 且**非 requiresHuman**；铁律3）。确定性边界：
   * 不自批 / approver 必须是 requester 的直接上级（有效 reporting edge）/ active worker。
   */
  approveByWorker(orgId: string, approvalId: string, approverWorkerId: string): void {
    const approval = this.requirePending(orgId, approvalId);
    if (approval.requiresHuman) {
      throw new InvalidApprovalError('该审批要求人类批准，上级数字员工批准不充分（ADR-0055 铁律3）');
    }
    this.assertWorkerMayDispose(orgId, approval, approverWorkerId);
    if (!this.store.decideApprovalIfPending(orgId, approvalId, 'approved', approverWorkerId, null, this.now())) {
      throw new InvalidApprovalError('审批已被并发响应或已过期');
    }
  }

  /** 拒绝（人类，或 org_or_human 模式下的直接上级 worker，二选一不可兼填）。条件转移防并发。 */
  reject(orgId: string, approvalId: string, by: { workerId?: string; userId?: string }): void {
    const approval = this.requirePending(orgId, approvalId);
    const human = (by.userId ?? '').trim();
    const worker = (by.workerId ?? '').trim();
    /* 拒绝者必须**恰好**二选一：防 human+worker 兼填把 worker 边界绕过却仍写入 approver_worker_id 污染审计。 */
    if (human.length === 0 && worker.length === 0) {
      throw new InvalidApprovalError('拒绝必须标明拒绝者（userId 或 workerId）');
    }
    if (human.length > 0 && worker.length > 0) {
      throw new InvalidApprovalError('拒绝者只能二选一（userId 或 workerId），不能兼填');
    }
    /* worker 拒绝须满足与 worker 批准**完全相同**的边界（同一 helper，杜绝不对称越权面，Codex 复审）。 */
    if (worker.length > 0) {
      this.assertWorkerMayDispose(orgId, approval, worker);
    }
    if (!this.store.decideApprovalIfPending(orgId, approvalId, 'rejected', worker.length > 0 ? worker : null, human.length > 0 ? human : null, this.now())) {
      throw new InvalidApprovalError('审批已被并发响应或已过期');
    }
  }

  /**
   * 数字员工处置（批准/拒绝）一个 org_or_human 审批的**统一边界**——approve 与 reject 共用，杜绝漂移。
   * 顺序：approvalMode（human_only 禁）→ 不自批 → 须 active 数字员工 → 须是发起者的直接上级（有效 reporting edge）。
   */
  private assertWorkerMayDispose(orgId: string, approval: OrgApproval, workerId: string): void {
    /* approvalMode 持久化的路由结果（Codex 复审 FATAL1）：human_only（如 medium+policy 关）禁 worker 处置。 */
    if (approval.approvalMode !== 'org_or_human') {
      throw new InvalidApprovalError('该审批模式为 human_only，不允许上级数字员工处置（policy 未开 worker 审批）');
    }
    if (workerId === approval.requesterWorkerId) {
      throw new InvalidApprovalError('不能自处置');
    }
    const approver = this.store.getWorker(orgId, workerId);
    if (!approver || approver.employmentStatus !== 'active') {
      throw new InvalidApprovalError('处置者须是组织内 active 数字员工');
    }
    if (!this.store.listDirectReports(orgId, workerId).includes(approval.requesterWorkerId)) {
      throw new InvalidApprovalError('上级数字员工处置：必须是发起者的直接上级');
    }
  }

  /**
   * **某个具体审批**是否已放行（D3 执行前用 request() 拿到的 approvalId 查）。
   * Codex 复审 FATAL2：必须按**当前 approvalId**校验，不能按 subject 找任意旧 approved——否则同一 task
   * 之前 medium 批过，之后新建 high pending 会被旧 approved 误放行（陈旧批准复用越权）。
   * 先把过期的标 expired，再看**这个**审批是否 approved（pending/rejected/expired 都不放行，无审批不执行硬门）。
   */
  isApprovalCleared(orgId: string, approvalId: string): boolean {
    this.store.expireStaleApprovals(orgId, this.now());
    return this.store.getApproval(orgId, approvalId)?.status === 'approved';
  }
  /* ⚠️ isApprovalCleared 只看 status，**不得**用于 D3 执行门——执行放行必须用下方 isExecutionApprovalCleared
   * （绑定 subject/发起者/风险），否则同 org 任意 approved id 都能放行（跨任务/低风险越权）。 */

  /**
   * **执行门**用的绑定校验（D3，Codex 复审致命修复）：放行不仅看 status=approved，还必须**确认这个审批
   * 确实是为「这次执行」批的**——否则同 org 任意 approved id 都能放行（medium 批准放行 high 执行/跨任务复用越权）。
   * 校验（全部满足才放行）：
   *   - approval 存在且 status=approved（先 expire 过期的）；
   *   - subjectType / subjectId / requesterWorkerId 与本次执行一致（审批是为这个 task、这个发起者批的）；
   *   - 批准时的 effectiveRisk **不低于**本次执行的有效风险（铁律1：不能用低风险批准放行高风险执行）。
   */
  isExecutionApprovalCleared(check: ExecutionApprovalCheck): boolean {
    this.store.expireStaleApprovals(check.orgId, this.now());
    const a = this.store.getApproval(check.orgId, check.approvalId);
    if (!a || a.status !== 'approved') return false;
    if (a.subjectType !== check.subjectType) return false;
    if (a.subjectId !== check.subjectId) return false;
    if (a.requesterWorkerId !== check.requesterWorkerId) return false;
    /* 批准的风险不得低于本次执行有效风险（low 批准不能放行 medium/high）。 */
    return RISK_ORDER[a.effectiveRisk] >= RISK_ORDER[check.effectiveRisk];
  }

  private requirePending(orgId: string, approvalId: string): OrgApproval {
    const a = this.store.getApproval(orgId, approvalId);
    if (!a) throw new InvalidApprovalError(`审批 ${approvalId} 不存在`);
    if (a.status !== 'pending') throw new InvalidApprovalError(`审批已是 ${a.status} 状态`);
    return a;
  }
}
