/**
 * 数字员工协作 service（B1）——结构化的 agent-to-agent 通信，不是自由聊天。
 *
 * 蓝图铁律：协作必须可治理/可审计，不能绕开任务 DAG/审计链。本 service 强制：
 *   - 消息**结构化**（绑 org/线程，有明确 message_type，from/to 是组织内 worker）；
 *   - 通信**受限于组织关系**：只能在同一线程内、对组织内存在的 worker 发；
 *   - 不做自由文本「意图理解」——消息内容是确定性记录，渲染由确定性 responder 做（零-LLM）。
 *
 * 确定性、无副作用之外只写库（线程/消息）。复用 OrgWorkforceStore 的 worker 校验。
 */

import { randomUUID } from 'node:crypto';
import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgConversationThread, OrgMessage, ThreadType, MessageType } from './types.js';

/** 高治理消息类型：必须可追溯（自带 correlationId 或线程绑 task/goal），不能当自由聊天用。 */
const HIGH_GOVERNANCE_TYPES: ReadonlySet<MessageType> = new Set(['request', 'report', 'escalation']);

/** 协作非法（线程不存在/worker 不在组织/广播无效等）。 */
export class InvalidCollaborationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCollaborationError';
  }
}

export class AgentCommunicationService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly now: () => number,
    private readonly idgen: () => string = randomUUID,
    /** 该 service 作用的租户（用于返回对象带正确 tenantId，供上层审计/响应；与 store 同租户）。 */
    private readonly tenantId: string = 'default',
  ) {}

  /** 开一条协作线程（创建者必须是组织内 worker）。 */
  openThread(input: {
    orgId: string;
    threadType: ThreadType;
    createdByWorkerId: string;
    goalId?: string | null;
    taskId?: string | null;
  }): OrgConversationThread {
    this.assertWorkerInOrg(input.orgId, input.createdByWorkerId);
    const ts = this.now();
    const thread: Omit<OrgConversationThread, 'tenantId'> = {
      id: this.idgen(), orgId: input.orgId, threadType: input.threadType,
      goalId: input.goalId ?? null, taskId: input.taskId ?? null,
      createdByWorkerId: input.createdByWorkerId, status: 'open', createdAt: ts, updatedAt: ts,
    };
    this.store.insertThread(thread);
    return { ...thread, tenantId: this.tenantId };
  }

  /**
   * 发一条结构化消息：from/to 必须是组织内 worker，线程必须存在且 open。to 为 null = 线程广播。
   * 不做自由文本推理——content 是确定性记录。
   */
  sendMessage(input: {
    orgId: string;
    threadId: string;
    fromWorkerId: string;
    toWorkerId?: string | null;
    messageType: MessageType;
    content: string;
    correlationId?: string | null;
  }): OrgMessage {
    const thread = this.store.getThread(input.orgId, input.threadId);
    if (!thread) throw new InvalidCollaborationError(`线程 ${input.threadId} 不存在`);
    if (thread.status !== 'open') throw new InvalidCollaborationError('线程已关闭，不能再发消息');
    this.assertWorkerInOrg(input.orgId, input.fromWorkerId);
    if (input.toWorkerId != null) this.assertWorkerInOrg(input.orgId, input.toWorkerId);
    if (input.content.trim().length === 0) throw new InvalidCollaborationError('消息内容不能为空');

    /* 治理纪律（Codex 复审）：高治理类型（request/report/escalation）必须能挂到任务/审批证据链——
     * 要么消息自带 correlationId，要么线程绑了 task/goal。否则它们就成了无法追溯的自由聊天，违背
     * 「结构化、可治理」的初衷。note/response 是轻量类型，不强制。 */
    if (HIGH_GOVERNANCE_TYPES.has(input.messageType)) {
      const hasCorrelation = (input.correlationId ?? '').length > 0;
      const threadBound = thread.taskId !== null || thread.goalId !== null;
      if (!hasCorrelation && !threadBound) {
        throw new InvalidCollaborationError(`${input.messageType} 类型消息必须有 correlationId 或线程绑定 task/goal（可追溯）`);
      }
    }

    const msg: Omit<OrgMessage, 'tenantId'> = {
      id: this.idgen(), orgId: input.orgId, threadId: input.threadId,
      fromWorkerId: input.fromWorkerId, toWorkerId: input.toWorkerId ?? null,
      messageType: input.messageType, content: input.content,
      correlationId: input.correlationId ?? null, createdAt: this.now(),
    };
    this.store.insertMessage(msg);
    return { ...msg, tenantId: this.tenantId };
  }

  /** 关闭线程。 */
  closeThread(orgId: string, threadId: string): void {
    const thread = this.store.getThread(orgId, threadId);
    if (!thread) throw new InvalidCollaborationError(`线程 ${threadId} 不存在`);
    this.store.setThreadStatus(orgId, threadId, 'closed', this.now());
  }

  /** worker 必须存在于该组织（否则跨组织/虚构 worker 通信非法）。 */
  private assertWorkerInOrg(orgId: string, workerId: string): void {
    if (!this.store.getWorker(orgId, workerId)) {
      throw new InvalidCollaborationError(`worker ${workerId} 不在组织 ${orgId} 内`);
    }
  }
}
