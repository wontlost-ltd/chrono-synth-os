/**
 * 学习请求 service + 账本单元测试（ADR-0057 L2）。
 *
 * 锁住 L2 不变量：缺口→登记；同 (persona,capability) 幂等去重（active 不重复）；unknown 标记；
 * 已学（passed）能力作为缺口差集来源；per-persona 隔离；多能力多请求；状态推进。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { LearningRequestService } from '../../workforce/learning-request-service.js';

describe('LearningRequestService（ADR-0057 L2 学习请求账本）', () => {
  let db: IDatabase;
  let store: LearningRequestStore;
  let svc: LearningRequestService;
  let clock: number;
  let counter: number;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new LearningRequestStore(db, 'tenant-a');
    clock = 1000;
    counter = 0;
    svc = new LearningRequestService(store, () => clock, () => `lr-${++counter}`, 'tenant-a');
  });

  it('★缺口→登记★：任务要求 [research,writing]，persona 未学 → 登记两条 pending', () => {
    const out = svc.detectAndRegister({
      orgId: 'org-1', personaId: 'p-alice',
      requiredCapabilities: ['research', 'writing'], taskId: 'task-1', priority: 'high',
    });
    assert.equal(out.length, 2);
    assert.ok(out.every((o) => o.kind === 'registered'));
    assert.deepEqual(out.map((o) => o.capability), ['research', 'writing']);
    assert.ok(out.every((o) => o.request.status === 'pending' && o.request.priority === 'high'));
    assert.equal(store.listByOrg('org-1', 'pending').length, 2);
  });

  it('★幂等去重★：同 (persona,capability) 再次缺口 → deduped，不重复登记', () => {
    svc.detectAndRegister({ orgId: 'org-1', personaId: 'p-alice', requiredCapabilities: ['research'], taskId: 'task-1' });
    /* 另一个任务也缺 research → 复用同一 active 请求，不新建。 */
    const out = svc.detectAndRegister({ orgId: 'org-1', personaId: 'p-alice', requiredCapabilities: ['research'], taskId: 'task-2' });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, 'deduped');
    assert.equal(store.listByOrg('org-1').length, 1, '账本仍只一条（防请教风暴）');
  });

  it('★已学不再缺★：persona 已 passed research → 不登记 research，只登记新缺口', () => {
    /* 先让 research 学会（passed）。 */
    const r = svc.registerGap({ orgId: 'org-1', personaId: 'p-alice', capability: 'research', evidence: 'e', priority: 'medium' });
    store.transitionStatus(r.request.id, 'pending', 'passed', clock);
    /* 任务要求 [research, writing]：research 已学 → 只缺 writing。 */
    const out = svc.detectAndRegister({ orgId: 'org-1', personaId: 'p-alice', requiredCapabilities: ['research', 'writing'] });
    assert.deepEqual(out.map((o) => o.capability), ['writing']);
  });

  it('★unknown 标记★：词表外能力（typo）登记时标 isUnknown，已知能力不标', () => {
    const out = svc.detectAndRegister({ orgId: 'org-1', personaId: 'p-alice', requiredCapabilities: ['reserch', 'research'] });
    const reserch = out.find((o) => o.capability === 'reserch')!;
    const research = out.find((o) => o.capability === 'research')!;
    assert.equal(reserch.request.isUnknown, true, 'typo 标 unknown 供人工归并');
    assert.equal(research.request.isUnknown, false, '已知能力不标');
  });

  it('★per-persona 隔离★：alice 的学习请求 bob 看不到（已学能力也按 persona）', () => {
    svc.registerGap({ orgId: 'org-1', personaId: 'p-alice', capability: 'research', evidence: 'e', priority: 'medium' });
    /* bob 缺 research → 登记自己的（不被 alice 的 active 去重）。 */
    const out = svc.detectAndRegister({ orgId: 'org-1', personaId: 'p-bob', requiredCapabilities: ['research'] });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, 'registered', 'bob 独立登记，不被 alice 去重');
    /* alice passed research 不让 bob「免学」。 */
    const aliceReqs = store.listByOrg('org-1').filter((r) => r.personaId === 'p-alice');
    store.transitionStatus(aliceReqs[0]!.id, 'pending', 'passed', clock);
    assert.deepEqual(svc.listLearnedCapabilities('p-bob'), [], 'bob 未学 research');
    assert.deepEqual(svc.listLearnedCapabilities('p-alice'), ['research'], 'alice 已学');
  });

  it('★无缺口 → 空登记★：persona 覆盖全部所需 → 不产学习请求（可零-LLM 直接执行）', () => {
    const r = svc.registerGap({ orgId: 'org-1', personaId: 'p-alice', capability: 'review', evidence: 'e', priority: 'medium' });
    store.transitionStatus(r.request.id, 'pending', 'passed', clock);
    const out = svc.detectAndRegister({ orgId: 'org-1', personaId: 'p-alice', requiredCapabilities: ['review'] });
    assert.equal(out.length, 0);
  });

  it('★状态推进 CAS★：pending→learning→passed；错误 from 状态不命中', () => {
    const r = svc.registerGap({ orgId: 'org-1', personaId: 'p-alice', capability: 'qa', evidence: 'e', priority: 'low' });
    assert.equal(store.transitionStatus(r.request.id, 'pending', 'learning', clock), true);
    assert.equal(store.transitionStatus(r.request.id, 'pending', 'passed', clock), false, '已不是 pending → 不命中（防并发）');
    assert.equal(store.transitionStatus(r.request.id, 'learning', 'passed', clock), true);
    assert.equal(store.getById(r.request.id)!.status, 'passed');
  });

  it('★DB 部分唯一索引挡并发双插★：绕过 findActive 直接插同 active (persona,cap) → DB 拒绝', () => {
    svc.registerGap({ orgId: 'org-1', personaId: 'p-alice', capability: 'research', evidence: 'e1', priority: 'medium' });
    assert.throws(() => store.insert({
      id: 'dup-x', orgId: 'org-1', personaId: 'p-alice', capability: 'research',
      isUnknown: false, evidence: 'e2', priority: 'medium', triggeredByTaskId: null,
      status: 'pending', createdAt: clock, updatedAt: clock,
    }), /UNIQUE|constraint/i, 'DB 部分唯一索引挡并发双插');
    assert.equal(store.listByOrg('org-1').length, 1, '账本仍只一条 active');
  });

  it('★catch-and-refetch 真打 catch 分支★：findActive 先空、insert 撞唯一、再 refetch 命中 → deduped（Codex L2 复审）', () => {
    /* 受控 store 桩：模拟并发竞争——首次 findActive 返 undefined（看似可插），insert 撞唯一冲突，
     * 之后 findActive 返已被对手插入的 active → catch-and-refetch 收敛为 deduped。 */
    const winner = {
      id: 'won-1', tenantId: 'tenant-a', orgId: 'org-1', personaId: 'p-alice', capability: 'research',
      isUnknown: false, evidence: 'winner', priority: 'medium' as const, triggeredByTaskId: null,
      status: 'pending' as const, createdAt: 1000, updatedAt: 1000,
    };
    let findCalls = 0;
    const stub = {
      findActive: () => { findCalls++; return findCalls === 1 ? undefined : winner; },
      insert: () => { throw new Error('UNIQUE constraint failed: learning_requests'); },
      listPassedCapabilities: () => [],
    } as unknown as LearningRequestStore;
    const svc2 = new LearningRequestService(stub, () => 1000, () => 'lr-x', 'tenant-a');
    const out = svc2.registerGap({ orgId: 'org-1', personaId: 'p-alice', capability: 'research', evidence: 'mine', priority: 'medium' });
    assert.equal(out.kind, 'deduped', '撞唯一冲突 → refetch 命中 → deduped');
    assert.equal(out.request.id, 'won-1', '复用对手的 active 请求');
    assert.equal(findCalls, 2, 'findActive 调用两次（前置 + catch refetch）');
  });

  it('★非唯一冲突真错误照抛★：insert 抛非 UNIQUE 错误 → 不吞，原样抛（Codex L2 复审错误分类）', () => {
    const stub = {
      findActive: () => undefined,
      insert: () => { throw new Error('database is locked'); },  /* 非唯一冲突 */
      listPassedCapabilities: () => [],
    } as unknown as LearningRequestStore;
    const svc2 = new LearningRequestService(stub, () => 1000, () => 'lr-x', 'tenant-a');
    assert.throws(
      () => svc2.registerGap({ orgId: 'org-1', personaId: 'p-alice', capability: 'research', evidence: 'e', priority: 'medium' }),
      /database is locked/,
      '非唯一冲突照抛，不被 catch-and-refetch 吞',
    );
  });

  it('★persona-global 跨 org 复用★：persona 在 org-1 学会 research → org-2 任务不再缺（能力属 persona 非 org）', () => {
    const r = svc.registerGap({ orgId: 'org-1', personaId: 'p-alice', capability: 'research', evidence: 'e', priority: 'medium' });
    store.transitionStatus(r.request.id, 'pending', 'passed', clock);
    /* 同 persona 在另一个 org 的任务也要 research → 已学（persona-global），不再登记。 */
    const out = svc.detectAndRegister({ orgId: 'org-2', personaId: 'p-alice', requiredCapabilities: ['research'] });
    assert.equal(out.length, 0, 'persona 跨 org 复用已学能力，不重学');
  });

  it('★active 幂等也 persona-global★：org-1 登记 research active → org-2 同 persona 同能力 deduped', () => {
    svc.detectAndRegister({ orgId: 'org-1', personaId: 'p-alice', requiredCapabilities: ['research'] });
    const out = svc.detectAndRegister({ orgId: 'org-2', personaId: 'p-alice', requiredCapabilities: ['research'] });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, 'deduped', '跨 org 同 persona 同能力 active 去重');
  });

  it('★passed 后同能力可重新登记★：学会过但再次缺（如能力失效场景）→ active 不存在 → 新登记', () => {
    const r = svc.registerGap({ orgId: 'org-1', personaId: 'p-alice', capability: 'triage', evidence: 'e', priority: 'medium' });
    store.transitionStatus(r.request.id, 'pending', 'passed', clock);
    /* passed 不占 active 槽——若 listLearnedCapabilities 仍含 triage 则不会再缺；此处直接测 registerGap 幂等门
     * 只看 active（passed 不挡新登记）。 */
    const again = svc.registerGap({ orgId: 'org-1', personaId: 'p-alice', capability: 'triage', evidence: 'e2', priority: 'medium' });
    assert.equal(again.kind, 'registered', 'passed 不占 active 槽，可重新登记');
  });
});
