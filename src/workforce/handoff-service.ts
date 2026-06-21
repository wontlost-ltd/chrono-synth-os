/**
 * 任务 handoff service（B2）——任务执行权的有状态协商交接。
 *
 * 真实组织里任务会交接（请假/专长不匹配/负载）。handoff 不是直接改 assignee，而是**协商**：
 *   propose → (recipient) accept / reject，或 (proposer) cancel。
 * 接受后才在事务里真正把任务执行者改成 to worker（保留协商痕迹 + 审计）。
 *
 * 不变量：propose 者必须是任务**当前执行者**；to 必须是同组织 worker 且 ≠ from；只有 proposed 能
 * 响应；accept 原子（改 handoff 状态 + reassign 任务）。零-LLM 确定性状态机。
 */

import { randomUUID } from 'node:crypto';
import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgHandoff } from './types.js';

/** handoff 非法（任务不存在/from 非当前执行者/to 不在组织/状态错等）。 */
export class InvalidHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHandoffError';
  }
}

export class HandoffService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly now: () => number,
    private readonly idgen: () => string = randomUUID,
    private readonly tenantId: string = 'default',
  ) {}

  /**
   * 提议交接：fromWorker（必须是任务当前执行者）把 task 交给 toWorker（同组织、≠from）。
   * 只创建 proposed handoff，不改任务（待对方 accept）。
   */
  propose(input: { orgId: string; taskId: string; fromWorkerId: string; toWorkerId: string; reason?: string }): OrgHandoff {
    if (input.fromWorkerId === input.toWorkerId) throw new InvalidHandoffError('不能交接给自己');
    const task = this.store.getTask(input.orgId, input.taskId);
    if (!task) throw new InvalidHandoffError(`任务 ${input.taskId} 不存在`);
    if (task.assignedToWorkerId !== input.fromWorkerId) {
      throw new InvalidHandoffError('只有任务当前执行者能发起交接');
    }
    if (!this.store.getWorker(input.orgId, input.toWorkerId)) {
      throw new InvalidHandoffError(`接收者 ${input.toWorkerId} 不在组织 ${input.orgId} 内`);
    }
    const handoff: Omit<OrgHandoff, 'tenantId'> = {
      id: this.idgen(), orgId: input.orgId, taskId: input.taskId,
      fromWorkerId: input.fromWorkerId, toWorkerId: input.toWorkerId, reason: input.reason ?? '',
      status: 'proposed', createdAt: this.now(), respondedAt: null,
    };
    this.store.insertHandoff(handoff);
    return { ...handoff, tenantId: this.tenantId };
  }

  /**
   * 接受交接：必须 proposed，响应者是 to worker。**原子条件转移**（Codex 复审）：
   *   事务内 ① 条件改 handoff proposed→accepted（防并发双响应）② 条件 reassign 任务，
   *   **仅当任务当前执行者仍是 from**（防陈旧 handoff 抢走已交接出去的任务）。任一条件不满足 → 回滚 + 报错。
   */
  accept(orgId: string, handoffId: string, respondingWorkerId: string): void {
    const handoff = this.requireProposed(orgId, handoffId);
    if (respondingWorkerId !== handoff.toWorkerId) throw new InvalidHandoffError('只有接收者能接受交接');
    const ts = this.now();
    this.store.transaction(() => {
      /* 条件改状态：并发下只有一个能从 proposed 改成 accepted。 */
      if (!this.store.transitionHandoffIfProposed(orgId, handoffId, 'accepted', ts)) {
        throw new InvalidHandoffError('交接已被并发响应，状态不再是 proposed');
      }
      /* 条件 reassign：任务当前执行者必须仍是 from（否则是陈旧 handoff，不能抢任务）。 */
      if (!this.store.reassignTaskIfHeldBy(orgId, handoff.taskId, handoff.fromWorkerId, handoff.toWorkerId, ts)) {
        throw new InvalidHandoffError('任务当前执行者已变（陈旧交接），不能接受');
      }
    });
  }

  /** 拒绝交接：必须 proposed，响应者是 to worker。条件转移防并发。任务执行者不变。 */
  reject(orgId: string, handoffId: string, respondingWorkerId: string): void {
    const handoff = this.requireProposed(orgId, handoffId);
    if (respondingWorkerId !== handoff.toWorkerId) throw new InvalidHandoffError('只有接收者能拒绝交接');
    if (!this.store.transitionHandoffIfProposed(orgId, handoffId, 'rejected', this.now())) {
      throw new InvalidHandoffError('交接已被并发响应，状态不再是 proposed');
    }
  }

  /** 撤回交接：必须 proposed，撤回者是 from worker。条件转移防并发。 */
  cancel(orgId: string, handoffId: string, cancellingWorkerId: string): void {
    const handoff = this.requireProposed(orgId, handoffId);
    if (cancellingWorkerId !== handoff.fromWorkerId) throw new InvalidHandoffError('只有发起者能撤回交接');
    if (!this.store.transitionHandoffIfProposed(orgId, handoffId, 'cancelled', this.now())) {
      throw new InvalidHandoffError('交接已被并发响应，状态不再是 proposed');
    }
  }

  /** 预检（早返回友好错误）：真正的原子守卫在条件 UPDATE。 */
  private requireProposed(orgId: string, handoffId: string): OrgHandoff {
    const handoff = this.store.getHandoff(orgId, handoffId);
    if (!handoff) throw new InvalidHandoffError(`交接 ${handoffId} 不存在`);
    if (handoff.status !== 'proposed') throw new InvalidHandoffError(`交接已是 ${handoff.status} 状态，不能再响应`);
    return handoff;
  }
}
