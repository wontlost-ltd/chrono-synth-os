import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { AgentCommunicationService, InvalidCollaborationError } from '../../workforce/agent-communication-service.js';

/* B1 协作：结构化 agent-to-agent 通信（不是自由聊天），受组织关系约束。 */
describe('AgentCommunicationService（B1 结构化协作）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let comm: AgentCommunicationService;
  let mgrId: string;
  let icId: string;
  let counter: number;

  function pod(): WorkerSpec[] {
    return [
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: null },
      { roleCode: 'ic', title: 'IC', jobFamily: 'ic', seniority: 'ic', displayName: 'IC', personaId: 'p-i', managerRoleCode: 'mgr' },
    ];
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    counter = 0;
    const idg = (): string => `id-${++counter}`;
    const chart = new OrgChartService(store, () => 1000, idg);
    const boot = chart.bootstrap('org-1', pod());
    mgrId = boot.workerIdByRole.get('mgr')!;
    icId = boot.workerIdByRole.get('ic')!;
    comm = new AgentCommunicationService(store, () => 1000, idg, 'tenant-a');
  });

  it('开线程 + 发结构化消息 + 列消息 round-trip', () => {
    const thread = comm.openThread({ orgId: 'org-1', threadType: 'delegation', createdByWorkerId: mgrId, taskId: 't-1' });
    assert.equal(thread.status, 'open');
    comm.sendMessage({ orgId: 'org-1', threadId: thread.id, fromWorkerId: mgrId, toWorkerId: icId, messageType: 'request', content: '请处理任务 t-1', correlationId: 't-1' });
    comm.sendMessage({ orgId: 'org-1', threadId: thread.id, fromWorkerId: icId, toWorkerId: mgrId, messageType: 'response', content: '已接受' });
    const msgs = store.listMessages('org-1', thread.id);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.messageType, 'request');
    assert.equal(msgs[0]!.correlationId, 't-1', 'correlation 落库保审计链');
    assert.equal(msgs[1]!.messageType, 'response');
  });

  it('受组织约束：给不在组织里的 worker 发 → 拒绝', () => {
    const thread = comm.openThread({ orgId: 'org-1', threadType: 'coordination', createdByWorkerId: mgrId });
    assert.throws(
      () => comm.sendMessage({ orgId: 'org-1', threadId: thread.id, fromWorkerId: mgrId, toWorkerId: 'ghost-worker', messageType: 'note', content: 'hi' }),
      InvalidCollaborationError,
    );
  });

  it('受组织约束：非组织 worker 开线程 → 拒绝', () => {
    assert.throws(
      () => comm.openThread({ orgId: 'org-1', threadType: 'coordination', createdByWorkerId: 'ghost' }),
      InvalidCollaborationError,
    );
  });

  it('线程不存在 / 已关闭 → 拒绝发消息', () => {
    assert.throws(
      () => comm.sendMessage({ orgId: 'org-1', threadId: 'nope', fromWorkerId: mgrId, messageType: 'note', content: 'x' }),
      InvalidCollaborationError,
    );
    const thread = comm.openThread({ orgId: 'org-1', threadType: 'coordination', createdByWorkerId: mgrId });
    comm.closeThread('org-1', thread.id);
    assert.throws(
      () => comm.sendMessage({ orgId: 'org-1', threadId: thread.id, fromWorkerId: mgrId, messageType: 'note', content: 'x' }),
      /已关闭/,
    );
  });

  it('空内容 → 拒绝（结构化消息不能空）', () => {
    const thread = comm.openThread({ orgId: 'org-1', threadType: 'coordination', createdByWorkerId: mgrId });
    assert.throws(
      () => comm.sendMessage({ orgId: 'org-1', threadId: thread.id, fromWorkerId: mgrId, messageType: 'note', content: '   ' }),
      /不能为空/,
    );
  });

  it('广播消息（toWorkerId=null）合法', () => {
    /* note 是轻量类型，无需可追溯绑定，广播合法。 */
    const thread = comm.openThread({ orgId: 'org-1', threadType: 'coordination', createdByWorkerId: mgrId });
    const msg = comm.sendMessage({ orgId: 'org-1', threadId: thread.id, fromWorkerId: mgrId, toWorkerId: null, messageType: 'note', content: '同步一下' });
    assert.equal(msg.toWorkerId, null);
    assert.equal(msg.tenantId, 'tenant-a', '返回对象带正确 tenantId');
  });

  it('治理纪律（Codex 复审）：高治理类型(request/report/escalation)无可追溯绑定 → 拒绝', () => {
    /* 线程未绑 task/goal + 消息无 correlationId → report/request/escalation 拒绝（防自由聊天）。 */
    const thread = comm.openThread({ orgId: 'org-1', threadType: 'coordination', createdByWorkerId: mgrId });
    for (const mt of ['request', 'report', 'escalation'] as const) {
      assert.throws(
        () => comm.sendMessage({ orgId: 'org-1', threadId: thread.id, fromWorkerId: mgrId, toWorkerId: icId, messageType: mt, content: 'x' }),
        /必须有 correlationId 或线程绑定/,
        `${mt} 无绑定应拒`,
      );
    }
    /* 但 note 轻量类型不强制，可发。 */
    const note = comm.sendMessage({ orgId: 'org-1', threadId: thread.id, fromWorkerId: mgrId, toWorkerId: icId, messageType: 'note', content: 'x' });
    assert.equal(note.messageType, 'note');
    /* 高治理类型只要带 correlationId 就可发。 */
    const req = comm.sendMessage({ orgId: 'org-1', threadId: thread.id, fromWorkerId: mgrId, toWorkerId: icId, messageType: 'request', content: 'x', correlationId: 'task-9' });
    assert.equal(req.correlationId, 'task-9');
  });

  it('租户隔离：A 的线程 B 看不到', () => {
    const thread = comm.openThread({ orgId: 'org-1', threadType: 'coordination', createdByWorkerId: mgrId });
    const storeB = new OrgWorkforceStore(db, 'tenant-b');
    assert.equal(storeB.getThread('org-1', thread.id), undefined);
    assert.equal(storeB.listThreads('org-1').length, 0);
  });
});
