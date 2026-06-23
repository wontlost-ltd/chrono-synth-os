import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TypedEventEmitter } from '../../events/typed-event-emitter.js';

interface TestEvents {
  'ping': { value: number };
  'pong': { message: string };
}

describe('TypedEventEmitter', () => {
  it('emit 和 on 正常工作', () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    let received: number | undefined;
    emitter.on('ping', (payload) => { received = payload.value; });
    emitter.emit('ping', { value: 42 });
    assert.equal(received, 42);
  });

  it('once 只触发一次', () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    let count = 0;
    emitter.once('ping', () => { count++; });
    emitter.emit('ping', { value: 1 });
    emitter.emit('ping', { value: 2 });
    assert.equal(count, 1);
  });

  it('off 移除监听器', () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    let count = 0;
    const listener = () => { count++; };
    emitter.on('ping', listener);
    emitter.emit('ping', { value: 1 });
    emitter.off('ping', listener);
    emitter.emit('ping', { value: 2 });
    assert.equal(count, 1);
  });

  it('listenerCount 返回正确数量', () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    assert.equal(emitter.listenerCount('ping'), 0);
    emitter.on('ping', () => {});
    emitter.on('ping', () => {});
    assert.equal(emitter.listenerCount('ping'), 2);
  });

  it('removeAllListeners 清除监听器', () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    emitter.on('ping', () => {});
    emitter.on('pong', () => {});
    emitter.removeAllListeners('ping');
    assert.equal(emitter.listenerCount('ping'), 0);
    assert.equal(emitter.listenerCount('pong'), 1);
  });

  it('监听器异常被隔离：不冒泡出 emit，不影响其它监听器', () => {
    const errors: Array<{ event: string; err: unknown }> = [];
    const emitter = new TypedEventEmitter<TestEvents>((event, err) => errors.push({ event, err }));
    let secondRan = false;
    emitter.on('ping', () => { throw new Error('boom'); });
    emitter.on('ping', () => { secondRan = true; });

    /* emit 不得抛出（异常被隔离） */
    assert.doesNotThrow(() => emitter.emit('ping', { value: 1 }));
    /* 第一个监听器抛错不影响第二个 */
    assert.equal(secondRan, true, '后续监听器仍应执行');
    /* 异常被转给 onError 回调 */
    assert.equal(errors.length, 1);
    assert.equal(errors[0].event, 'ping');
    assert.ok(errors[0].err instanceof Error && errors[0].err.message === 'boom');
  });

  it('once 监听器异常同样被隔离', () => {
    const errors: unknown[] = [];
    const emitter = new TypedEventEmitter<TestEvents>((_event, err) => errors.push(err));
    emitter.once('ping', () => { throw new Error('once-boom'); });
    assert.doesNotThrow(() => emitter.emit('ping', { value: 1 }));
    assert.equal(errors.length, 1);
    /* once 触发后自动解绑 */
    assert.equal(emitter.listenerCount('ping'), 0);
  });

  it('同一 listener 重复 on x3 → off x3 完全移除（无泄漏）', () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    let count = 0;
    const listener = () => { count++; };
    emitter.on('ping', listener);
    emitter.on('ping', listener);
    emitter.on('ping', listener);
    assert.equal(emitter.listenerCount('ping'), 3, '重复 on 应各自记账');
    emitter.emit('ping', { value: 1 });
    assert.equal(count, 3, '三次注册触发三次');

    emitter.off('ping', listener);
    emitter.off('ping', listener);
    emitter.off('ping', listener);
    assert.equal(emitter.listenerCount('ping'), 0, '三次 off 应全部移除，无残留');
    count = 0;
    emitter.emit('ping', { value: 2 });
    assert.equal(count, 0, '全部移除后不再触发');
  });

  it('同一 listener 跨事件注册互不干扰，异常归属正确事件', () => {
    const errors: Array<{ event: string }> = [];
    const emitter = new TypedEventEmitter<TestEvents>((event) => errors.push({ event }));
    const listener = () => { throw new Error('x'); };
    emitter.on('ping', listener);
    emitter.on('pong', listener);

    emitter.emit('pong', { message: 'hi' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].event, 'pong', '异常须归属实际触发的事件，不串到 ping');

    /* off 一个事件不影响另一个 */
    emitter.off('ping', listener);
    assert.equal(emitter.listenerCount('ping'), 0);
    assert.equal(emitter.listenerCount('pong'), 1, 'off ping 不应移除 pong 上的注册');
  });

  it('removeAllListeners 后重新 on 行为正常（账本已清）', () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    let count = 0;
    const listener = () => { count++; };
    emitter.on('ping', listener);
    emitter.removeAllListeners('ping');
    assert.equal(emitter.listenerCount('ping'), 0);
    /* 重新注册同一 listener 应正常工作（不被陈旧账本影响） */
    emitter.on('ping', listener);
    emitter.emit('ping', { value: 1 });
    assert.equal(count, 1);
    emitter.off('ping', listener);
    assert.equal(emitter.listenerCount('ping'), 0);
  });
});
