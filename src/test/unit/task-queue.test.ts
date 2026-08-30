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

  /* #124 防御纵深：getTaskForTenant 在 SQL 层做 id+tenant 双约束，跨租户 id 查不到。 */
  it('getTaskForTenant：本租户能查到、跨租户查不到（SQL 层隔离）', () => {
    const id = queue.enqueue('tenant-a', 'decision:simulate', { caseId: 'dec_1' });

    /* 本租户：查得到。 */
    const own = queue.getTaskForTenant(id, 'tenant-a');
    assert.ok(own, '本租户应能查到自己的任务');
    assert.equal(own.tenantId, 'tenant-a');

    /* 跨租户：拿对 id 但传别租户 → SQL 层就过滤掉，返回 undefined（不依赖应用层复核）。 */
    const cross = queue.getTaskForTenant(id, 'tenant-b');
    assert.equal(cross, undefined, '跨租户 id 在 SQL 层即查不到');

    /* 对照：无 tenant 谓词的 getTask 仍能按 id 拿到（worker/内部用）。 */
    assert.ok(queue.getTask(id), 'getTask（worker 用）仍按 id 可查');
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

  /* ── issue #395：stale 判定必须由数据库当唯一时钟 ──
   *
   * 缺陷：`claimed_at` 由认领副本的 `Date.now()` 写入，而 reaper 用**另一个**
   * 副本的 `Date.now()` 算截止点比较。两台机器的钟差直接平移 stale 判定——
   * 钟差 > 阈值时，别的副本**正在执行**的任务被误判卡死、`retry_count + 1`
   * 重新入队（或耗尽重试后误标 failed）。
   *
   * 与 outbox 那两张表不同，这里没有下游幂等兜底，误回收就是真的重跑业务任务。
   *
   * ⚠️ 判据必须是**结构性**的：断言「时间戳与 Date.now() 相差不超过 N 毫秒」
   * 在单机上恒真（同机两钟本就只差几十毫秒），对跨机钟差零证明力。
   * 正确判据是「SQL 里没有把时刻当参数传进去」——见下面第一条。 */
  it('审计 #395：claimed_at 由数据库盖戳（SQL 不接受应用侧时刻参数）', () => {
    const id = queue.enqueue('tenant-clock', 'decision:simulate', {});

    /* 拦下真实执行的 SQL 与参数。 */
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const origPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      const origRun = stmt.run.bind(stmt);
      stmt.run = ((...params: unknown[]) => { seen.push({ sql, params }); return origRun(...params as never[]); }) as typeof stmt.run;
      return stmt;
    }) as typeof db.prepare;

    const claimed = queue.dequeue();
    (db as unknown as { prepare: typeof db.prepare }).prepare = origPrepare;

    assert.ok(claimed, '前置：应能认领');
    assert.equal(claimed.id, id);

    const claimSql = seen.find((e) => /UPDATE tasks SET status = 'running'/.test(e.sql));
    assert.ok(claimSql, '必须执行了认领语句（否则下面断言是空转）');

    /* 结构性判据：认领语句只带 workerId 与 taskId 两个参数，
     * 时刻全部来自 SQL 内的 DB 时钟表达式。
     * 变异实测：把 claimed_at 改回 `?` + p.now → 参数变 4 个，本行转红。 */
    assert.equal(claimSql.params.length, 2,
      `认领语句不得把时刻当参数传（实际参数：${JSON.stringify(claimSql.params)}）`);
    assert.ok(/claimed_at = \(/.test(claimSql.sql), 'claimed_at 必须是 SQL 表达式而非占位符');

    /* 回读的行必须带上数据库盖的戳，而不是 undefined/0。 */
    assert.ok(typeof claimed.claimedAt === 'number' && claimed.claimedAt > 0,
      'dequeue 应回读数据库实际盖的 claimed_at');
  });

  it('审计 #395：reap 语句只收时长、不收截止时刻', () => {
    queue.enqueue('tenant-clock', 'decision:simulate', {});
    queue.dequeue();

    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const origPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      const origRun = stmt.run.bind(stmt);
      stmt.run = ((...params: unknown[]) => { seen.push({ sql, params }); return origRun(...params as never[]); }) as typeof stmt.run;
      return stmt;
    }) as typeof db.prepare;

    queue.reapStaleTasks(300_000);
    (db as unknown as { prepare: typeof db.prepare }).prepare = origPrepare;

    const reapStmts = seen.filter((e) => /retry_count/.test(e.sql) && /status = 'running'/.test(e.sql));
    assert.equal(reapStmts.length >= 1, true, '必须执行了回收语句');

    for (const st of reapStmts) {
      /* 传进去的每个数字参数都必须是**时长**（这里是 300000），
       * 绝不能出现 epoch 量级的时刻（≈1.7e12）。
       * 变异实测：改回传 cutoff → 参数里出现 1.7e12，本行转红。 */
      for (const v of st.params) {
        if (typeof v !== 'number') continue;
        assert.ok(v < 1e11,
          `回收语句不得把 epoch 时刻当参数传（发现 ${v}，看起来是绝对时刻而非时长）`);
      }
      assert.ok(/claimed_at < \(/.test(st.sql), '截止点必须由 SQL 内的 DB 时钟算出');
    }
  });

  /* 行为对照：判据换成 DB 时钟后，回收语义本身不能坏。 */
  it('审计 #395 对照：卡死任务被回收，刚认领的不受影响', () => {
    const stuck = queue.enqueue('tenant-clock', 'decision:simulate', {});
    queue.dequeue();
    /* 把认领时刻挪到 10 分钟前，模拟 worker 崩溃后卡住。 */
    db.prepare<void>('UPDATE tasks SET claimed_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now() - 10 * 60 * 1000, Date.now() - 10 * 60 * 1000, stuck);

    const fresh = queue.enqueue('tenant-clock', 'decision:simulate', {});
    const freshClaimed = queue.dequeue();
    assert.equal(freshClaimed?.id, fresh, '前置：第二条应被认领');

    const reaped = queue.reapStaleTasks(5 * 60 * 1000);

    assert.equal(reaped, 1, '只该回收卡死的那一条');
    assert.equal(queue.getTask(stuck)?.status, 'pending', '卡死的应回到 pending');
    assert.equal(queue.getTask(stuck)?.retryCount, 1, 'retry_count 应 +1');
    assert.equal(queue.getTask(fresh)?.status, 'running', '刚认领的不得被顺带回收');
  });
});
