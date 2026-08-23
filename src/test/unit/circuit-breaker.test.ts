import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitOpenError } from '../../server/plugins/circuit-breaker.js';
import { TestClock } from '../../utils/clock.js';

/* ⚠️ 涉及 open→half_open 跃迁的用例必须**注入时钟**（issue #378）。
 * 此前用「resetTimeoutMs: 10 + setTimeout(20)」跨墙钟窗口，实测隔离重跑 5 次红 1 次。
 * 注入后窗口判定与真实耗时解耦，跃迁由显式推进的时钟决定，与调度抖动无关。 */

describe('CircuitBreaker', () => {
  it('初始状态为 closed', () => {
    const cb = new CircuitBreaker();
    assert.equal(cb.getState(), 'closed');
  });

  it('成功调用保持 closed 状态', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    await cb.execute(() => 'ok');
    await cb.execute(() => 'ok');
    assert.equal(cb.getState(), 'closed');
  });

  it('连续失败达到阈值后进入 open 状态', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });

    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(() => { throw new Error('fail'); });
      } catch { /* 预期 */ }
    }

    assert.equal(cb.getState(), 'open');
  });

  it('open 状态下拒绝请求抛出 CircuitOpenError', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });

    try {
      await cb.execute(() => { throw new Error('fail'); });
    } catch { /* 进入 open */ }

    await assert.rejects(
      () => cb.execute(() => 'should not run'),
      (err: unknown) => err instanceof CircuitOpenError,
    );
  });

  it('resetTimeoutMs 后从 open 进入 half_open', async () => {
    const clock = new TestClock(1000);
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 }, clock);

    try {
      await cb.execute(() => { throw new Error('fail'); });
    } catch { /* open */ }

    assert.equal(cb.getState(), 'open');

    /* 显式推进超过 resetTimeoutMs（不再靠墙钟等待） */
    clock.advance(20);

    assert.equal(cb.getState(), 'half_open');
  });

  it('⚠️ 对照：推进不足 resetTimeoutMs 时必须仍为 open（防「钉死时钟把行为一起钉没」）', async () => {
    /* 只断言「推进后变 half_open」是不够的：把判据改成恒过期，那条断言同样会过。
     * 必须同时钉死**未到期不得跃迁** —— 这才是 resetTimeoutMs 存在的意义。 */
    const clock = new TestClock(1000);
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 }, clock);

    try {
      await cb.execute(() => { throw new Error('fail'); });
    } catch { /* open */ }
    assert.equal(cb.getState(), 'open');

    clock.advance(9); // < resetTimeoutMs
    assert.equal(cb.getState(), 'open', '未到 resetTimeoutMs 不得进入 half_open');

    clock.advance(1); // 恰好到 10ms —— 判据是 >=，边界必须跃迁
    assert.equal(cb.getState(), 'half_open', '恰好到达 resetTimeoutMs 应跃迁（判据为 >=）');
  });

  it('half_open 状态下成功调用恢复为 closed', async () => {
    const clock = new TestClock(1000);
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 }, clock);

    try {
      await cb.execute(() => { throw new Error('fail'); });
    } catch { /* open */ }

    clock.advance(20);
    assert.equal(cb.getState(), 'half_open');

    await cb.execute(() => 'recovered');
    assert.equal(cb.getState(), 'closed');
  });

  it('half_open 状态下失败回到 open', async () => {
    const clock = new TestClock(1000);
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 }, clock);

    try {
      await cb.execute(() => { throw new Error('fail'); });
    } catch { /* open */ }

    clock.advance(20);
    assert.equal(cb.getState(), 'half_open');

    try {
      await cb.execute(() => { throw new Error('fail again'); });
    } catch { /* 回到 open */ }

    assert.equal(cb.getState(), 'open');
  });

  it('reset 恢复到初始状态', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });

    try {
      await cb.execute(() => { throw new Error('fail'); });
    } catch { /* open */ }

    assert.equal(cb.getState(), 'open');
    cb.reset();
    assert.equal(cb.getState(), 'closed');
  });

  it('execute 返回函数结果', async () => {
    const cb = new CircuitBreaker();
    const result = await cb.execute(() => 42);
    assert.equal(result, 42);
  });

  it('execute 支持异步函数', async () => {
    const cb = new CircuitBreaker();
    const result = await cb.execute(async () => {
      await new Promise(r => setTimeout(r, 5));
      return 'async-result';
    });
    assert.equal(result, 'async-result');
  });
});
