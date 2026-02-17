import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitOpenError } from '../../server/plugins/circuit-breaker.js';

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
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });

    try {
      await cb.execute(() => { throw new Error('fail'); });
    } catch { /* open */ }

    assert.equal(cb.getState(), 'open');

    /* 等待超过 resetTimeoutMs */
    await new Promise(r => setTimeout(r, 20));

    assert.equal(cb.getState(), 'half_open');
  });

  it('half_open 状态下成功调用恢复为 closed', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });

    try {
      await cb.execute(() => { throw new Error('fail'); });
    } catch { /* open */ }

    await new Promise(r => setTimeout(r, 20));
    assert.equal(cb.getState(), 'half_open');

    await cb.execute(() => 'recovered');
    assert.equal(cb.getState(), 'closed');
  });

  it('half_open 状态下失败回到 open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });

    try {
      await cb.execute(() => { throw new Error('fail'); });
    } catch { /* open */ }

    await new Promise(r => setTimeout(r, 20));
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
