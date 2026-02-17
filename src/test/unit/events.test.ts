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
});
