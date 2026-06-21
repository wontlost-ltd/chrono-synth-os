/**
 * 数字员工升级链 service（B 链扩展）——下属阻塞时沿汇报链逐级上升求助，确定性零-LLM 状态机。
 *
 * B1(结构化消息)/B2(handoff) 之上的**多级升级**：
 *   - raise：阻塞的 worker 在某任务上向其**直接上级**发起 escalation（pending，depth=0，链首）；
 *   - resolve：被升级到的上级给出处置 → resolved（条件转移防并发）；
 *   - reescalate：上级无法处置 → 再升给**自己的上级**，原升级标 reescalated，新建 pending（depth+1，
 *     parent 指向上一条），串成升级链。根 worker（无上级）不能再升（顶层必须自行 resolve）。
 *   - cancel：升级发起者撤回（仅 pending）。
 *
 * 不变量：raise 者必须是任务**当前执行者**；升级只能升给**直接上级**（有效 solid 汇报边）；
 * 只有 pending 能被处置；处置走条件状态转移（CAS 防并发双处置）。MAX_DEPTH 防无限升级。
 */

import { randomUUID } from 'node:crypto';
import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgEscalation } from './types.js';

/** 升级链最大层级（防异常配置导致无限升级；正常组织层级远小于此）。 */
const MAX_DEPTH = 16;

/** 升级非法（任务/worker/层级/状态不满足）。 */
export class InvalidEscalationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEscalationError';
  }
}

export class EscalationService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly now: () => number,
    private readonly idgen: () => string = randomUUID,
    private readonly tenantId: string = 'default',
  ) {}

  /**
   * 发起升级（链首）：阻塞的任务执行者向其**直接上级**求助。
   * 校验：任务存在 + raiser 是任务当前执行者 + raiser 有直接上级（否则根 worker 无处可升）。
   */
  raise(input: { orgId: string; taskId: string; fromWorkerId: string; reason: string; correlationId?: string | null }): OrgEscalation {
    const task = this.store.getTask(input.orgId, input.taskId);
    if (!task) throw new InvalidEscalationError(`任务 ${input.taskId} 不存在`);
    if (task.assignedToWorkerId !== input.fromWorkerId) {
      throw new InvalidEscalationError('只有任务当前执行者能发起升级');
    }
    if ((input.reason ?? '').trim().length === 0) throw new InvalidEscalationError('升级原因不能为空');
    const manager = this.store.getManagerOf(input.orgId, input.fromWorkerId);
    if (!manager) throw new InvalidEscalationError('发起者没有直接上级，无法升级（顶层须自行处置）');
    return this.create(input.orgId, input.taskId, input.fromWorkerId, manager, null, 0, input.reason, input.correlationId ?? null);
  }

  /** 处置升级（被升级到的上级 resolve）：仅 pending，处置者必须是 to worker。条件转移防并发。 */
  resolve(orgId: string, escalationId: string, resolvingWorkerId: string, resolution: string): void {
    const esc = this.requirePending(orgId, escalationId);
    if (resolvingWorkerId !== esc.toWorkerId) throw new InvalidEscalationError('只有被升级到的上级能处置该升级');
    if ((resolution ?? '').trim().length === 0) throw new InvalidEscalationError('处置说明不能为空');
    if (!this.store.transitionEscalationIfPending(orgId, escalationId, 'resolved', resolution, this.now())) {
      throw new InvalidEscalationError('升级已被并发处置，状态不再是 pending');
    }
  }

  /**
   * 再升级（上级无法处置 → 升给自己的上级）：仅 pending，操作者必须是当前 to worker，
   * 且其有直接上级。**原子**（条件标 reescalated + 建新 pending depth+1，parent 指向原升级）。
   * 返回新建的链上升级。
   */
  reescalate(orgId: string, escalationId: string, byWorkerId: string, reason: string): OrgEscalation {
    const esc = this.requirePending(orgId, escalationId);
    if (byWorkerId !== esc.toWorkerId) throw new InvalidEscalationError('只有被升级到的上级能再升级');
    if ((reason ?? '').trim().length === 0) throw new InvalidEscalationError('再升级原因不能为空');
    if (esc.depth + 1 > MAX_DEPTH) throw new InvalidEscalationError('升级链已达最大层级，不能再升');
    const nextManager = this.store.getManagerOf(orgId, byWorkerId);
    if (!nextManager) throw new InvalidEscalationError('已到顶层（无上级），不能再升，请自行处置');
    return this.store.transaction(() => {
      /* 先条件标原升级为 reescalated（防并发：抢不到说明已被别的处置改了状态）。 */
      if (!this.store.transitionEscalationIfPending(orgId, escalationId, 'reescalated', null, this.now())) {
        throw new InvalidEscalationError('升级已被并发处置，状态不再是 pending');
      }
      /* 新建链上升级：from=当前上级、to=再上一级、parent=原升级、depth+1。 */
      return this.create(orgId, esc.taskId, byWorkerId, nextManager, esc.id, esc.depth + 1, reason, esc.correlationId);
    });
  }

  /** 撤回升级（发起者，仅 pending）。条件转移防并发。 */
  cancel(orgId: string, escalationId: string, byWorkerId: string): void {
    const esc = this.requirePending(orgId, escalationId);
    if (byWorkerId !== esc.fromWorkerId) throw new InvalidEscalationError('只有升级发起者能撤回');
    if (!this.store.transitionEscalationIfPending(orgId, escalationId, 'cancelled', null, this.now())) {
      throw new InvalidEscalationError('升级已被并发处置，状态不再是 pending');
    }
  }

  private create(orgId: string, taskId: string, fromWorkerId: string, toWorkerId: string, parentEscalationId: string | null, depth: number, reason: string, correlationId: string | null): OrgEscalation {
    const esc: Omit<OrgEscalation, 'tenantId'> = {
      id: this.idgen(), orgId, taskId, fromWorkerId, toWorkerId,
      parentEscalationId, depth, status: 'pending', reason, resolution: null,
      correlationId, createdAt: this.now(), decidedAt: null,
    };
    this.store.insertEscalation(esc);
    return { ...esc, tenantId: this.tenantId };
  }

  private requirePending(orgId: string, escalationId: string): OrgEscalation {
    const e = this.store.getEscalation(orgId, escalationId);
    if (!e) throw new InvalidEscalationError(`升级 ${escalationId} 不存在`);
    if (e.status !== 'pending') throw new InvalidEscalationError(`升级已是 ${e.status} 状态，不能再处置`);
    return e;
  }
}
