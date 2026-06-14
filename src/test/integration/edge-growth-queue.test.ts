/**
 * 离线成长队列 + teacher job（ADR-0052 Edge-P4）：teacher 只在联网/成长阶段跑，绝不进 runtime；
 * 失败隔离（一个 job 失败不阻断其他 job / 不阻断 runtime 离线自治）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GrowthJobQueue, TeacherJobRunner, type GrowthJob, type TeacherFn,
} from '../../edge/index.js';
import type { Logger } from '../../utils/logger.js';

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

  it('running → failed → retry 回 pending', () => {
    const q = new GrowthJobQueue();
    const j = q.enqueue('perception', { mediaSha: 'abc' }, 1000);
    q.markRunning(j.id);
    q.markFailed(j.id, 'teacher down');
    const failed = q.all().find((x) => x.id === j.id)!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'teacher down');
    assert.equal(q.retry(j.id), true);
    assert.equal(q.pending().length, 1);
  });

  it('状态机：非法转移被拒（done 不能再 markRunning；pending 不能直接 markFailed）', () => {
    const q = new GrowthJobQueue();
    const j = q.enqueue('reflection', {}, 1000);
    /* pending 直接 markFailed/markDone 非法（须先 running）。 */
    assert.equal(q.markFailed(j.id, 'x'), false);
    assert.equal(q.markDone(j.id), false);
    q.markRunning(j.id);
    q.markDone(j.id);
    /* done 不能再 markRunning。 */
    assert.equal(q.markRunning(j.id), false);
    assert.equal(q.all().find((x) => x.id === j.id)!.status, 'done');
  });

  it('attempts 单计：一次 running→failed 只 +1（不双计）', () => {
    const q = new GrowthJobQueue();
    const j = q.enqueue('reflection', {}, 1000);
    q.markRunning(j.id);
    q.markFailed(j.id, 'x');
    assert.equal(q.all().find((x) => x.id === j.id)!.attempts, 1, '一次尝试 attempts=1');
    /* retry 再跑一次 → attempts=2。 */
    q.retry(j.id);
    q.markRunning(j.id);
    assert.equal(q.all().find((x) => x.id === j.id)!.attempts, 2);
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

  it('fromSerialized：seq 必须大于已有 job 最大序号（防新 id 重复）', () => {
    /* job gjob_5 但 seq=3 ≤ 5 → 拒绝（否则新入队 gjob_3 会与未来冲突）。 */
    const bad = JSON.stringify({ seq: 3, jobs: [{ id: 'gjob_5', kind: 'reflection', status: 'done', payload: {}, enqueuedAt: 1, attempts: 1 }] });
    assert.throws(() => GrowthJobQueue.fromSerialized(bad), /必须大于已有/);
  });

  it('fromSerialized：job id 重复被拒', () => {
    const dup = JSON.stringify({ seq: 2, jobs: [
      { id: 'gjob_0', kind: 'reflection', status: 'done', payload: {}, enqueuedAt: 1, attempts: 1 },
      { id: 'gjob_0', kind: 'reflection', status: 'pending', payload: {}, enqueuedAt: 2, attempts: 0 },
    ] });
    assert.throws(() => GrowthJobQueue.fromSerialized(dup), /id 重复/);
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

  it('logger 抛错不破坏失败隔离（runPending 仍不抛）', async () => {
    const q = new GrowthJobQueue();
    q.enqueue('reflection', {}, 1000);
    /* logger.info/warn 都抛错。 */
    const throwingLogger: Logger = {
      info: () => { throw new Error('logger boom'); },
      warn: () => { throw new Error('logger boom'); },
      error: () => { throw new Error('logger boom'); },
      debug: () => { throw new Error('logger boom'); },
    };
    const runner = new TeacherJobRunner(q, async () => ({ candidatesIngested: 1 }), throwingLogger);
    const summary = await runner.runPending();   /* 不抛 */
    assert.equal(summary.succeeded, 1, 'logger 抛错被隔离，job 仍正常完成');
  });

  it('teacher 返回畸形 outcome（NaN）→ 当失败处理，不污染 summary', async () => {
    const q = new GrowthJobQueue();
    q.enqueue('reflection', {}, 1000);
    const runner = new TeacherJobRunner(q, async () => ({ candidatesIngested: NaN }));
    const summary = await runner.runPending();
    assert.equal(summary.failed, 1, '畸形 outcome 当失败');
    assert.equal(summary.succeeded, 0);
    assert.equal(Number.isFinite(summary.totalCandidates), true, 'totalCandidates 不被 NaN 污染');
    assert.equal(summary.totalCandidates, 0);
  });

  it('并发门（收口）：job 已被抢走（非 pending）→ runner 跳过不重复跑 teacher', async () => {
    const q = new GrowthJobQueue();
    const j = q.enqueue('reflection', {}, 1000);
    /* 模拟另一 runner 已把它推进到 running（markRunning 返回 true 后第二次 false）。 */
    q.markRunning(j.id);
    let calls = 0;
    const runner = new TeacherJobRunner(q, async () => { calls++; return { candidatesIngested: 1 }; });
    const summary = await runner.runPending();
    /* job 已 running 不在 pending 快照 → attempted=0；即便在快照里，markRunning 返回 false 也跳过。 */
    assert.equal(summary.attempted, 0, '已被抢走的 job 不在 pending');
    assert.equal(calls, 0, 'teacher 未被重复调用');
  });

  it('failureReason 在重跑时清除（markRunning 清旧 reason）', () => {
    const q = new GrowthJobQueue();
    const j = q.enqueue('reflection', {}, 1000);
    q.markRunning(j.id);
    q.markFailed(j.id, 'first fail');
    q.retry(j.id);
    q.markRunning(j.id);   /* 重跑 → 清旧 reason */
    assert.equal(q.all().find((x) => x.id === j.id)!.failureReason, undefined, '重跑清旧失败原因');
  });

  it('schemaVersion（收口）：序列化带版本，未知版本拒绝，缺省视为 v1', () => {
    const q = new GrowthJobQueue();
    q.enqueue('reflection', {}, 1000);
    assert.ok(JSON.parse(q.serialize()).schemaVersion === 1, '序列化带 schemaVersion');
    /* 未知版本拒绝。 */
    assert.throws(() => GrowthJobQueue.fromSerialized(JSON.stringify({ schemaVersion: 99, seq: 1, jobs: [] })), /不支持的 schemaVersion/);
    /* 缺省视为 v1（向后兼容早期落盘）。 */
    const legacy = GrowthJobQueue.fromSerialized(JSON.stringify({ seq: 0, jobs: [] }));
    assert.equal(legacy.all().length, 0);
  });
});
