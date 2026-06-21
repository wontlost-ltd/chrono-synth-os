import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, type WorkerSpec } from '../../workforce/org-chart-service.js';
import { EscalationService, InvalidEscalationError } from '../../workforce/escalation-service.js';

/* B 链升级链：raise→resolve / reescalate（多级链）/ cancel，确定性零-LLM 状态机。 */
describe('EscalationService（B 链升级链）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let svc: EscalationService;
  let topId: string;   /* 顶层（无上级） */
  let mgrId: string;   /* 中层（top 的下属、ic 的上级） */
  let icId: string;    /* 执行者 */
  let peerId: string;  /* ic 的平级 */
  let clock: number;
  let counter: number;
  let taskId: string;

  /* 三层组织：top → mgr → {ic, peer}。 */
  function org(): WorkerSpec[] {
    return [
      { roleCode: 'top', title: '总监', jobFamily: 'exec', seniority: 'exec', displayName: '总监', personaId: 'p-t', managerRoleCode: null },
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '主管', personaId: 'p-m', managerRoleCode: 'top' },
      { roleCode: 'ic', title: 'IC', jobFamily: 'ic', seniority: 'ic', displayName: 'IC', personaId: 'p-i', managerRoleCode: 'mgr' },
      { roleCode: 'peer', title: 'Peer', jobFamily: 'ic', seniority: 'ic', displayName: 'Peer', personaId: 'p-p', managerRoleCode: 'mgr' },
    ];
  }

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    clock = 1000;
    counter = 0;
    const chart = new OrgChartService(store, () => 1000, () => `id-${++counter}`);
    const boot = chart.bootstrap('org-1', org());
    topId = boot.workerIdByRole.get('top')!;
    mgrId = boot.workerIdByRole.get('mgr')!;
    icId = boot.workerIdByRole.get('ic')!;
    peerId = boot.workerIdByRole.get('peer')!;
    /* 一个委派给 ic 的任务（供升级）。 */
    taskId = `task-${++counter}`;
    store.insertTask({
      id: taskId, orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: icId, accountableWorkerId: mgrId,
      title: '阻塞任务', taskType: 'x', status: 'delegated', riskLevel: 'low', allowsToolExecution: false,
      acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null, dueAt: null, createdAt: 1000, updatedAt: 1000,
    });
    svc = new EscalationService(store, () => clock, () => `es-${++counter}`, 'tenant-a');
  });

  it('raise：执行者向直接上级升级 → pending，depth=0，链首', () => {
    const e = svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: '缺数据' });
    assert.equal(e.status, 'pending');
    assert.equal(e.fromWorkerId, icId);
    assert.equal(e.toWorkerId, mgrId, '升给直接上级 mgr');
    assert.equal(e.depth, 0);
    assert.equal(e.parentEscalationId, null);
  });

  it('resolve：被升级到的上级处置 → resolved + 处置说明', () => {
    const e = svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: '缺数据' });
    svc.resolve('org-1', e.id, mgrId, '已补数据源');
    const after = store.getEscalation('org-1', e.id)!;
    assert.equal(after.status, 'resolved');
    assert.equal(after.resolution, '已补数据源');
  });

  it('★升级链★：mgr 无法处置 → reescalate 给 top，原标 reescalated，新建 depth=1 parent 指向原', () => {
    const e0 = svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: '缺数据' });
    const e1 = svc.reescalate('org-1', e0.id, mgrId, '需总监批预算');
    /* 原升级标 reescalated。 */
    assert.equal(store.getEscalation('org-1', e0.id)!.status, 'reescalated');
    /* 新升级：from=mgr、to=top、depth=1、parent=e0。 */
    assert.equal(e1.status, 'pending');
    assert.equal(e1.fromWorkerId, mgrId);
    assert.equal(e1.toWorkerId, topId);
    assert.equal(e1.depth, 1);
    assert.equal(e1.parentEscalationId, e0.id);
    /* 链可观测：listEscalationsByTask 按 depth 升序。 */
    const chain = store.listEscalationsByTask('org-1', taskId);
    assert.equal(chain.length, 2);
    assert.deepEqual(chain.map((c) => c.depth), [0, 1]);
    /* top 处置链尾。 */
    svc.resolve('org-1', e1.id, topId, '批了预算');
    assert.equal(store.getEscalation('org-1', e1.id)!.status, 'resolved');
  });

  it('★顶层不能再升★：top 收到升级后无上级 → reescalate 抛错（须自行处置）', () => {
    const e0 = svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: 'x' });
    const e1 = svc.reescalate('org-1', e0.id, mgrId, 'y');
    assert.throws(() => svc.reescalate('org-1', e1.id, topId, 'z'), /顶层|不能再升/);
  });

  it('根 worker 无上级 → raise 抛错', () => {
    /* 把任务改派给 top（无上级），top raise 应失败。 */
    store.transitionTaskExecutionIfStatus('org-1', taskId, 'delegated', 'delegated', null, 1000); /* no-op 保持 delegated */
    const topTask = `task-top-${++counter}`;
    store.insertTask({
      id: topTask, orgId: 'org-1', goalId: 'g1', parentTaskId: null, assignedToWorkerId: topId, accountableWorkerId: topId,
      title: 't', taskType: 'x', status: 'delegated', riskLevel: 'low', allowsToolExecution: false,
      acceptanceCriteria: '', requiredCapabilities: [], resultSummary: null, dueAt: null, createdAt: 1000, updatedAt: 1000,
    });
    assert.throws(() => svc.raise({ orgId: 'org-1', taskId: topTask, fromWorkerId: topId, reason: 'x' }), /没有直接上级/);
  });

  it('不变量：只有任务当前执行者能 raise（平级不能）', () => {
    assert.throws(() => svc.raise({ orgId: 'org-1', taskId, fromWorkerId: peerId, reason: 'x' }), /当前执行者/);
  });

  it('不变量：只有被升级到的上级能 resolve（平级/越级不能）', () => {
    const e = svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: 'x' });
    assert.throws(() => svc.resolve('org-1', e.id, peerId, 'r'), /被升级到的上级/);
    assert.throws(() => svc.resolve('org-1', e.id, topId, 'r'), /被升级到的上级/);
  });

  it('cancel：发起者撤回（仅 pending）；非发起者不能撤回', () => {
    const e = svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: 'x' });
    assert.throws(() => svc.cancel('org-1', e.id, mgrId), /发起者/);
    svc.cancel('org-1', e.id, icId);
    assert.equal(store.getEscalation('org-1', e.id)!.status, 'cancelled');
  });

  it('★状态机★：已处置的升级不能再处置（resolve/reescalate/cancel 都拒）', () => {
    const e = svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: 'x' });
    svc.resolve('org-1', e.id, mgrId, 'done');
    assert.throws(() => svc.resolve('org-1', e.id, mgrId, 'again'), /已是 resolved/);
    assert.throws(() => svc.reescalate('org-1', e.id, mgrId, 'x'), /已是 resolved/);
    assert.throws(() => svc.cancel('org-1', e.id, icId), /已是 resolved/);
  });

  it('待我处置：listPendingEscalationsTo 返回升给我的 pending', () => {
    svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: 'x' });
    const mine = store.listPendingEscalationsTo('org-1', mgrId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.toWorkerId, mgrId);
    /* top 此刻没有待处置。 */
    assert.equal(store.listPendingEscalationsTo('org-1', topId).length, 0);
  });

  it('空原因被拒；确定性可复现（同序列同输出）', () => {
    assert.throws(() => svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: '  ' }), /原因不能为空/);
  });

  it('租户隔离：A 的升级 B 看不到', () => {
    const e = svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: 'x' });
    assert.equal(new OrgWorkforceStore(db, 'tenant-b').getEscalation('org-1', e.id), undefined);
  });

  it('InvalidEscalationError 可被捕获', () => {
    assert.throws(() => svc.raise({ orgId: 'org-1', taskId: 'ghost', fromWorkerId: icId, reason: 'x' }), InvalidEscalationError);
  });

  it('★reescalate 事务回滚★：新升级插入失败 → 原升级仍 pending（不留半链）', () => {
    const e0 = svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: 'x' });
    /* 构造 idgen 冲突：reescalate 内 create 用的 id 与一个已存在主键撞 → insert 失败 → 事务回滚。 */
    let n = 0;
    const collidingSvc = new EscalationService(store, () => clock, () => (n++ === 0 ? e0.id : `es-new-${n}`), 'tenant-a');
    assert.throws(() => collidingSvc.reescalate('org-1', e0.id, mgrId, 'y'));
    /* 原升级未被改成 reescalated（事务回滚），仍可正常处置。 */
    assert.equal(store.getEscalation('org-1', e0.id)!.status, 'pending', '事务回滚 → 原升级仍 pending');
    assert.equal(store.listEscalationsByTask('org-1', taskId).length, 1, '没留半链子节点');
  });

  it('★汇报图结构防环★：每个 worker 只能有一个上级（schema 唯一约束），升级链不可能成环', () => {
    /* reporting_edges 对 report_worker_id 唯一 → 一个 worker 只有一条「我向谁汇报」边 → 汇报图天然是树，
     * 升级沿树向上必在 ≤ 树高(<MAX_DEPTH) 步到根，绝不成环。这里证明连脏写第二条上级边都被 schema 拒。 */
    assert.throws(
      () => store.insertEdge({ id: 'dirty-edge', orgId: 'org-1', managerWorkerId: icId, reportWorkerId: mgrId, edgeType: 'solid', createdAt: 1000 }),
      /UNIQUE|constraint/i,
      'schema 阻止给 mgr 加第二个上级 → 无法构造环',
    );
    /* 正常链：ic→mgr→top（2 级）就到根，再升被拒，绝不无限。 */
    const e0 = svc.raise({ orgId: 'org-1', taskId, fromWorkerId: icId, reason: 'x' });
    const e1 = svc.reescalate('org-1', e0.id, mgrId, 'y');
    assert.throws(() => svc.reescalate('org-1', e1.id, topId, 'z'), /顶层|不能再升/, '到根即止');
  });
});
