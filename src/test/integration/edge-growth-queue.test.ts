/**
 * 离线成长队列 + teacher job（ADR-0052 Edge-P4）：teacher 只在联网/成长阶段跑，绝不进 runtime；
 * 失败隔离（一个 job 失败不阻断其他 job / 不阻断 runtime 离线自治）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GrowthJobQueue, TeacherJobRunner, type GrowthJob, type TeacherFn,
} from '../../edge/index.js';

describe('离线成长队列（ADR-0052 Edge-P4）', () => {
  it('入队 → pending → markRunning/Done 生命周期', () => {
    const q = new GrowthJobQueue();
    const j = q.enqueue('reflection', { memoryIds: ['m1', 'm2'] }, 1000);
    assert.equal(j.status, 'pending');
    assert.equal(q.pending().length, 1);
    assert.equal(q.markRunning(j.id), true);
    assert.equal(q.pending().length, 0);
    assert.equal(q.markDone(j.id), true);
    assert.equal(q.all().find((x) => x.id === j.id)!.status, 'done');
  });

  it('失败 → retry 回 pending', () => {
    const q = new GrowthJobQueue();
    const j = q.enqueue('perception', { mediaSha: 'abc' }, 1000);
    q.markFailed(j.id, 'teacher down');
    const failed = q.all().find((x) => x.id === j.id)!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'teacher down');
    assert.equal(q.retry(j.id), true);
    assert.equal(q.pending().length, 1);
  });

  it('序列化往返：恢复后 jobs + seq 保留', () => {
    const q = new GrowthJobQueue();
    q.enqueue('reflection', { x: 1 }, 1000);
    q.enqueue('knowledge', { url: 'u' }, 2000);
    const restored = GrowthJobQueue.fromSerialized(q.serialize());
    assert.equal(restored.all().length, 2);
    /* seq 续接：新入队 id 不与旧重复。 */
    const j3 = restored.enqueue('perception', {}, 3000);
    assert.equal(j3.id, 'gjob_2');
  });

  it('fromSerialized 畸形输入抛错', () => {
    assert.throws(() => GrowthJobQueue.fromSerialized('{"seq":"x"}'), /畸形/);
    assert.throws(
      () => GrowthJobQueue.fromSerialized(JSON.stringify({ seq: 1, jobs: [{ id: 'x', kind: 'bogus', status: 'pending', payload: {}, enqueuedAt: 1, attempts: 0 }] })),
      /kind 非法/,
    );
  });

  it('深拷贝：enqueue 入参/读出不外泄 live reference', () => {
    const q = new GrowthJobQueue();
    const src = { nested: { v: 1 } };
    const ret = q.enqueue('reflection', src, 1000);
    src.nested.v = 777;
    (ret.payload.nested as { v: number }).v = 888;
    (q.all()[0].payload.nested as { v: number }).v = 999;
    assert.equal((q.all()[0].payload.nested as { v: number }).v, 1, '内部状态隔离外部篡改');
  });
});

describe('Teacher job 运行器（ADR-0052 Edge-P4）', () => {
  it('runPending：消费 pending，teacher 产候选，标 done', async () => {
    const q = new GrowthJobQueue();
    q.enqueue('reflection', { m: 1 }, 1000);
    q.enqueue('reflection', { m: 2 }, 2000);
    const teacher: TeacherFn = async () => ({ candidatesIngested: 2 });
    const runner = new TeacherJobRunner(q, teacher);

    const summary = await runner.runPending();
    assert.equal(summary.attempted, 2);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 0);
    assert.equal(summary.totalCandidates, 4);
    assert.equal(q.pending().length, 0);
  });

  it('失败隔离：一个 job 的 teacher 失败 → 标 failed，不阻断其他 job、不抛', async () => {
    const q = new GrowthJobQueue();
    const bad = q.enqueue('perception', { fail: true }, 1000);
    const good = q.enqueue('reflection', { fail: false }, 2000);
    /* teacher 对 fail=true 抛错。 */
    const teacher: TeacherFn = async (job: GrowthJob) => {
      if (job.payload['fail'] === true) throw new Error('teacher boom');
      return { candidatesIngested: 1 };
    };
    const runner = new TeacherJobRunner(q, teacher);

    /* runPending 不抛（失败隔离）。 */
    const summary = await runner.runPending();
    assert.equal(summary.attempted, 2);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    assert.equal(q.all().find((x) => x.id === bad.id)!.status, 'failed', '失败 job 标 failed');
    assert.equal(q.all().find((x) => x.id === good.id)!.status, 'done', '其他 job 不受影响');
  });

  it('teacher 全失败：runner 仍不抛（runtime 离线自治不被阻断）', async () => {
    const q = new GrowthJobQueue();
    q.enqueue('reflection', {}, 1000);
    const teacher: TeacherFn = async () => { throw new Error('all down'); };
    const runner = new TeacherJobRunner(q, teacher);
    const summary = await runner.runPending();   /* 不抛 */
    assert.equal(summary.failed, 1);
    assert.equal(summary.succeeded, 0);
  });

  it('确定性：同队列 + 同 teacher → 同汇总', async () => {
    const mk = () => {
      const q = new GrowthJobQueue();
      q.enqueue('reflection', { m: 1 }, 1000);
      return new TeacherJobRunner(q, async () => ({ candidatesIngested: 3 }));
    };
    assert.deepEqual(await mk().runPending(), await mk().runPending());
  });
});
