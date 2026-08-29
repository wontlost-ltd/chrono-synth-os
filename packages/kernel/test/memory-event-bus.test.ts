import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEventBus } from '../src/events/memory-event-bus.js';
import type { DomainEvent } from '../src/index.js';

function makeEvent(type: string): DomainEvent {
  return { type, tenantId: 'test', occurredAt: 1, payload: {} };
}

describe('MemoryEventBus', () => {
  it('dispatches to subscribed listener', async () => {
    const bus = new MemoryEventBus();
    let received: DomainEvent | undefined;
    bus.subscribe('task.accepted', (e) => { received = e; });

    const event = makeEvent('task.accepted');
    await bus.publish([event]);

    assert.deepEqual(received, event);
  });

  it('does not dispatch to listener for different type', async () => {
    const bus = new MemoryEventBus();
    let received = false;
    bus.subscribe('task.accepted', () => { received = true; });
    await bus.publish([makeEvent('task.completed')]);
    assert.equal(received, false);
  });

  it('unsubscribe stops receiving events', async () => {
    const bus = new MemoryEventBus();
    const received: number[] = [];
    const unsub = bus.subscribe('task.accepted', () => received.push(1));

    await bus.publish([makeEvent('task.accepted')]);
    unsub();
    await bus.publish([makeEvent('task.accepted')]);

    assert.equal(received.length, 1);
  });

  it('multiple listeners for same type all fire', async () => {
    const bus = new MemoryEventBus();
    const received: string[] = [];
    bus.subscribe('task.accepted', () => received.push('a'));
    bus.subscribe('task.accepted', () => received.push('b'));

    await bus.publish([makeEvent('task.accepted')]);

    assert.equal(received.length, 2);
  });

  it('publishes multiple events in order', async () => {
    const bus = new MemoryEventBus();
    const order: string[] = [];
    bus.subscribe('task.accepted', () => order.push('accepted'));
    bus.subscribe('task.completed', () => order.push('completed'));

    await bus.publish([makeEvent('task.accepted'), makeEvent('task.completed')]);

    assert.deepEqual(order, ['accepted', 'completed']);
  });

  it('listenerCount reflects current subscribers', () => {
    const bus = new MemoryEventBus();
    assert.equal(bus.listenerCount('task.accepted'), 0);
    const unsub = bus.subscribe('task.accepted', () => {});
    assert.equal(bus.listenerCount('task.accepted'), 1);
    unsub();
    assert.equal(bus.listenerCount('task.accepted'), 0);
  });

  it('clear() removes all listeners', async () => {
    const bus = new MemoryEventBus();
    let fired = false;
    bus.subscribe('task.accepted', () => { fired = true; });
    bus.clear();
    await bus.publish([makeEvent('task.accepted')]);
    assert.equal(fired, false);
  });

  /* ⚠️ 审计 #409：publish 此前无 try/catch —— 首个抛错的 listener 直接冒泡出
   * publish，后续 listener 与**后续所有事件**均不投递。
   *
   * 而消费方 `node-unit-of-work.ts:108` 的 `await publish(...)` 在 **COMMIT 之后**：
   * 数据已落库，write() 却抛错 ⇒ 路由 5xx ⇒ 调用方**重试已提交的事务**。
   * 实测：投影器 X 抛错 → 同批 wallet.credited 投影器从不执行、审计订阅方也不执行。
   *
   * ⚠️ 上面 7 条既有用例**加不加隔离都全绿**（审计变异实测）—— 错误传播行为
   * 此前完全无覆盖。下面四条正是补这个洞。 */
  it('审计 #409：一个订阅方抛错不得影响同事件的其它订阅方', async () => {
    const bus = new MemoryEventBus();
    const ran: string[] = [];
    bus.subscribe('task.accepted', () => { ran.push('first'); throw new Error('boom'); });
    bus.subscribe('task.accepted', () => { ran.push('second'); });

    await bus.publish([makeEvent('task.accepted')]);

    assert.deepEqual(ran, ['first', 'second'], '抛错方之后的订阅方仍须执行');
  });

  it('审计 #409：一个订阅方抛错不得吞掉后续事件', async () => {
    const bus = new MemoryEventBus();
    const seen: string[] = [];
    bus.subscribe('task.accepted', () => { throw new Error('boom'); });
    bus.subscribe('wallet.credited', (e) => { seen.push(e.type); });

    await bus.publish([makeEvent('task.accepted'), makeEvent('wallet.credited')]);

    assert.deepEqual(seen, ['wallet.credited'], '前一个事件抛错不得让后续事件丢失');
  });

  it('审计 #409：publish 不得向上抛（COMMIT 之后抛错会让调用方重试已提交事务）', async () => {
    const bus = new MemoryEventBus();
    bus.subscribe('task.accepted', () => { throw new Error('boom'); });

    await assert.doesNotReject(
      () => bus.publish([makeEvent('task.accepted')]),
      'publish 发生在 COMMIT 之后，抛错只会误导调用方「写失败」',
    );
  });

  it('审计 #409：隔离不等于静默——异常须交给 onListenerError 回调', async () => {
    const errors: Array<{ type: string; message: string }> = [];
    const bus = new MemoryEventBus((event, err) => {
      errors.push({ type: event.type, message: err instanceof Error ? err.message : String(err) });
    });
    bus.subscribe('task.accepted', () => { throw new Error('boom'); });

    await bus.publish([makeEvent('task.accepted')]);

    assert.equal(errors.length, 1, '异常必须被上报，否则就是静默失败');
    assert.equal(errors[0]!.type, 'task.accepted', '须带出是哪个事件出的错');
    assert.equal(errors[0]!.message, 'boom');
  });

  it('审计 #409：listener 内部 unsubscribe 不得破坏本轮投递', async () => {
    const bus = new MemoryEventBus();
    const ran: string[] = [];
    const unsubSecond = bus.subscribe('task.accepted', () => { ran.push('second'); });
    bus.subscribe('task.accepted', () => { ran.push('third'); });
    /* 第一个订阅方在投递过程中退订第二个 —— 迭代原 Set 会行为未定义。 */
    bus.subscribe('task.accepted', () => { ran.push('first'); unsubSecond(); });

    await assert.doesNotReject(() => bus.publish([makeEvent('task.accepted')]));
    assert.ok(ran.includes('third'), `本轮其余订阅方仍须执行，实际 ${JSON.stringify(ran)}`);
  });
});
