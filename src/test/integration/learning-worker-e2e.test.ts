/**
 * 确定性进修闭环端到端（闭合批评者头号致命缺口：pending 学习请求「永远醒不来」）。
 *
 * 验证：登记一个 pending 学习请求 → os.driveLearning() 一轮 → 学会（status=passed）+ emit
 * capability-learned（下游 TaskWakeHandler 据此唤醒挂起任务）。全程零-LLM、确定性、经蒸馏门落核。
 *
 * 这是「死代码变活」的证明：此前 LearningOrchestratorL6 生产零装配、pending 请求无人驱动；现在
 * LearningWorker + DeterministicLearningService 已在 os.start() 装配，driveLearning 能真正推进闭环。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { LearningRequestService } from '../../workforce/learning-request-service.js';

describe('确定性进修闭环 E2E（pending → 学会 → 唤醒）', () => {
  let os: ChronoSynthOS;
  let clock: TestClock;
  let store: LearningRequestStore;
  let service: LearningRequestService;
  let learned: Array<{ personaId: string; capability: string; examScore: number }>;

  let seq = 0;
  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    store = new LearningRequestStore(os.getDatabase(), 't1');
    service = new LearningRequestService(store, () => clock.now(), () => `req-${seq++}`, 't1');
    learned = [];
    os.bus.on('capability-learned', (e) => learned.push({ personaId: e.personaId, capability: e.capability, examScore: e.examScore }));
  });
  afterEach(() => os.close());

  function registerGap(personaId: string, capability: string): string {
    const r = service.registerGap({ orgId: 'org1', personaId, capability, evidence: `task 需要 ${capability}`, priority: 'high' });
    assert.equal(r.kind, 'registered');
    assert.equal(r.request.status, 'pending');
    return r.request.id;
  }

  it('★核心★：pending 学习请求 → driveLearning 一轮 → passed + capability-learned', () => {
    const id = registerGap('p-analyst', 'data_analysis');
    /* 驱动前：pending，无人学。 */
    assert.equal(store.getById(id)!.status, 'pending');

    const stats = os.driveLearning();

    /* 驱动后：学会（passed）+ 事件已 emit（下游唤醒接得上）。 */
    assert.equal(stats.considered, 1);
    assert.equal(stats.learned, 1);
    assert.equal(stats.failed, 0);
    assert.equal(store.getById(id)!.status, 'passed', '学习请求已推进到 passed');
    assert.equal(learned.length, 1, 'capability-learned 已 emit');
    assert.equal(learned[0].personaId, 'p-analyst');
    assert.equal(learned[0].capability, 'data_analysis');
    assert.ok(learned[0].examScore >= 0.95, '影子验收 ≥95');
  });

  it('★防假 passed（Codex 审查守卫）★：passed 时主内核叙事**真的被更新**（非只账本 passed）', () => {
    /* 关键回归守卫：land() 若把 pending 当成功会造成「账本 passed 但主内核没吸收」的假学会。
     * 断言学会后 p-analyst 的主内核叙事真的含所学能力关键词——证明候选真 compiled 落核，非假 passed。 */
    const core = os.getCore('p-analyst2');
    const narrativeBefore = core.narrative.get();
    registerGap('p-analyst2', 'research');
    const stats = os.driveLearning();
    assert.equal(stats.learned, 1, '学会');
    const narrativeAfter = core.narrative.get();
    assert.notEqual(narrativeAfter, narrativeBefore, '主内核叙事被更新（真落核，非假 passed）');
    assert.ok(narrativeAfter.includes('research'), `叙事应含所学能力，实际：${narrativeAfter}`);
    /* 且 capability-learned 只在真落核后 emit。 */
    assert.equal(learned.length, 1, '真落核才 emit');
  });

  it('多条 pending → 一轮全部学会（逐条确定性教学）', () => {
    registerGap('p-a', 'research');
    registerGap('p-b', 'content_piece');
    registerGap('p-c', 'support_ticket');
    const stats = os.driveLearning();
    assert.equal(stats.considered, 3);
    assert.equal(stats.learned, 3);
    assert.equal(learned.length, 3);
  });

  it('已 passed 的请求不重复学（幂等——驱动两轮，第二轮无 pending）', () => {
    registerGap('p-x', 'research');
    const first = os.driveLearning();
    assert.equal(first.learned, 1);
    const second = os.driveLearning();
    assert.equal(second.considered, 0, '第二轮无 pending（已 passed）');
    assert.equal(second.learned, 0);
    assert.equal(learned.length, 1, '不重复 emit');
  });

  it('确定性：同 persona 同能力，学会的 examScore 可复现', () => {
    registerGap('p-1', 'research');
    os.driveLearning();
    const score1 = learned[0].examScore;
    /* 另一 persona 学同能力 → 同确定性生成 → 同 score。 */
    registerGap('p-2', 'research');
    os.driveLearning();
    const score2 = learned[1].examScore;
    assert.equal(score1, score2, '确定性生成 → 同能力同 examScore');
  });

  it('driveLearning 无 pending 时安全返回空统计（不报错）', () => {
    const stats = os.driveLearning();
    assert.deepEqual(stats, { considered: 0, learned: 0, failed: 0, skipped: 0 });
  });
});
