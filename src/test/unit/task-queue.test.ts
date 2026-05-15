import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { TaskQueue } from '../../queue/task-queue.js';
import type { IDatabase } from '../../storage/database.js';

describe('TaskQueue', () => {
  let db: IDatabase;
  let queue: TaskQueue;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    queue = new TaskQueue(db);
  });

  it('入队并查询任务', () => {
    const id = queue.enqueue('tenant-a', 'decision:simulate', { caseId: 'dec_1' });
    assert.ok(id.startsWith('task_'));

    const task = queue.getTask(id);
    assert.ok(task);
    assert.equal(task.tenantId, 'tenant-a');
    assert.equal(task.type, 'decision:simulate');
    assert.equal(task.status, 'pending');
    assert.deepEqual(JSON.parse(task.payload), { caseId: 'dec_1' });
  });

  it('出队返回最早的待执行任务', () => {
    const id1 = queue.enqueue('t', 'type-a', { n: 1 });
    const id2 = queue.enqueue('t', 'type-b', { n: 2 });

    const task = queue.dequeue();
    assert.ok(task);
    assert.equal(task.id, id1);
    assert.equal(task.status, 'running');

    /* 再出队得到第二个 */
    const task2 = queue.dequeue();
    assert.ok(task2);
    assert.equal(task2.id, id2);
  });

  it('无待执行任务时返回 undefined', () => {
    assert.equal(queue.dequeue(), undefined);
  });

  it('complete 标记任务完成', () => {
    const id = queue.enqueue('t', 'test', {});
    queue.dequeue();
    queue.complete(id, { result: 42 });

    const task = queue.getTask(id);
    assert.equal(task?.status, 'completed');
    assert.equal(JSON.parse(task!.result!).result, 42);
  });

  it('fail 标记任务失败', () => {
    const id = queue.enqueue('t', 'test', {});
    queue.dequeue();
    queue.fail(id, '模拟失败');

    const task = queue.getTask(id);
    assert.equal(task?.status, 'failed');
    assert.equal(task?.error, '模拟失败');
  });

  it('reschedule 重新调度任务', () => {
    const id = queue.enqueue('t', 'test', {});
    queue.dequeue();

    const future = Date.now() + 60_000;
    queue.reschedule(id, 1, future, '暂时失败');

    const task = queue.getTask(id);
    assert.equal(task?.status, 'pending');
    assert.equal(task?.retryCount, 1);
    assert.equal(task?.availableAt, future);

    /* 当前时间 dequeue 拿不到（因为 availableAt 在未来） */
    assert.equal(queue.dequeue(), undefined);
  });

  it('getTask 不存在返回 undefined', () => {
    assert.equal(queue.getTask('nonexistent'), undefined);
  });
});
