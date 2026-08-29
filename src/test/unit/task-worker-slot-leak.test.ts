/**
 * TaskWorker 并发槽位泄漏回归测试（审计 #400）。
 *
 * 缺陷：超时只 `controller.abort()`，随后仍 `await handler(...)`。对**不查
 * signal 的 handler**（生产 `life_simulation` 的形参就叫 `_signal`，其
 * executeTask 是纯同步 CPU 循环）这个 await 永不 settle ⇒ tick() 的
 * `.finally(running--)` 永不执行 ⇒ 槽位永久泄漏 ⇒ 整个 worker 停摆，
 * 而 `isHealthy()` 只看定时器、仍返回 true（对监控完全不可见）。
 *
 * 这两条正是本文件的两个判据：**槽位要还**、**停摆要可见**。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { TaskQueue } from '../../queue/task-queue.js';
import { TaskWorker } from '../../queue/task-worker.js';
import type { IDatabase } from '../../storage/database.js';
import type { Logger } from '../../utils/logger.js';
import type { EventBus } from '../../events/event-bus.js';

/** 静默 logger：避免超时告警污染测试输出。 */
const silentLogger = {
  info() {}, warn() {}, error() {}, debug() {},
} as unknown as Logger;

/** 最小 EventBus：worker 只用 emit。 */
const noopBus = { emit() {}, on() {}, off() {} } as unknown as EventBus;

function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (pred()) { resolve(true); return; }
      if (Date.now() > deadline) { resolve(false); return; }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('TaskWorker 槽位泄漏（审计 #400）', () => {
  let db: IDatabase;
  let queue: TaskQueue;
  let worker: TaskWorker;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    queue = new TaskQueue(db);
  });

  it('不查 signal 的 handler 超时后必须释放槽位，健康任务不得饿死', async () => {
    /* maxConcurrent=2：两个挂起 handler 即可占满全部槽位。
     * 轮询 20ms 让测试快速收敛。 */
    worker = new TaskWorker(queue, noopBus, silentLogger, 20, 2, 1);

    let goodDone = 0;
    /* 关键：handler **完全不查 signal**（复刻 life_simulation 的形状）。 */
    worker.register('hung', async () => {
      await new Promise(() => { /* 永不 settle */ });
    }, 80);
    worker.register('good', async () => { goodDone++; }, 5_000);

    queue.enqueue('t1', 'hung', {});
    queue.enqueue('t1', 'hung', {});
    worker.start();

    /* 先让两个挂起任务占满槽位。 */
    await waitUntil(() => worker.inflight === 2);
    assert.equal(worker.inflight, 2, '两个挂起任务应占满槽位');

    /* 再投健康任务：修复前它们会永远饿死。 */
    for (let i = 0; i < 3; i++) queue.enqueue('t1', 'good', {});

    const released = await waitUntil(() => worker.inflight === 0);
    assert.ok(released, `超时后槽位必须归还，实际 inflight=${worker.inflight}`);

    const ok = await waitUntil(() => goodDone === 3);
    assert.ok(ok, `健康任务不得饿死，实际完成 ${goodDone}/3`);

    await worker.stop(1000);
  });

  it('槽位被占满且长时间无进展时 isHealthy() 必须报不健康', async () => {
    /* 轮询 5ms ⇒ 30 个饱和轮询约 150ms 即可越过停摆阈值。 */
    worker = new TaskWorker(queue, noopBus, silentLogger, 5, 1, 1);

    /* 超时设得极大：模拟「handler 卡住但还没到超时」的真实停摆窗口 ——
     * 这正是修复前 isHealthy() 睁眼说瞎话的那段时间。 */
    worker.register('stuck', async () => {
      await new Promise(() => { /* 永不 settle */ });
    }, 60_000);

    queue.enqueue('t1', 'stuck', {});
    worker.start();

    await waitUntil(() => worker.inflight === 1);
    assert.equal(worker.inflight, 1, '槽位应被占满');

    /* 起初仍算健康（尚未达到停摆阈值）——避免把「正常忙碌」误报成故障。 */
    assert.equal(worker.isHealthy(), true, '刚饱和时不应立刻判不健康');

    const detected = await waitUntil(() => worker.isHealthy() === false, 3000);
    assert.ok(detected, '持续饱和无进展必须被 isHealthy() 判为不健康');

    await worker.stop(500);
  });

  it('对照：正常负载下 isHealthy() 必须保持 true（不得误报）', async () => {
    worker = new TaskWorker(queue, noopBus, silentLogger, 5, 1, 1);

    let done = 0;
    worker.register('fast', async () => { done++; }, 5_000);
    for (let i = 0; i < 12; i++) queue.enqueue('t1', 'fast', {});
    worker.start();

    const ok = await waitUntil(() => done === 12);
    assert.ok(ok, `任务应全部完成，实际 ${done}/12`);
    assert.equal(worker.isHealthy(), true, '正常处理完任务后必须仍报健康');

    await worker.stop(500);
  });
});
