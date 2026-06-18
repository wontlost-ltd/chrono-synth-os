import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { ProactiveMessageStore } from '../../storage/proactive-message-store.js';
import { ProactiveEngine } from '../../proactivity/proactive-engine.js';
import { EventBus } from '../../events/event-bus.js';
import { SilentLogger } from '../../utils/logger.js';
import type { IDatabase } from '../../storage/database.js';

/**
 * 主动性引擎（ADR-0054 Phase 3）：订阅信号 → 门控 → 入队。重点验证红线：
 *   - 红线 7：缺/不一致 tenantId 的信号被 drop；
 *   - 红线 5/10：订阅回调异常被隔离，不外抛炸穿 emit；
 *   - 幂等：同静默窗口内同类信号只一条。
 */
describe('ProactiveEngine（ADR-0054 Phase 3 触发逻辑）', () => {
  let db: IDatabase;
  let bus: EventBus;
  let store: ProactiveMessageStore;
  let clock: number;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    bus = new EventBus();
    clock = 1_000_000_000;
    store = new ProactiveMessageStore(db, () => clock, 'tenant-a');
  });

  function makeEngine(): ProactiveEngine {
    const engine = new ProactiveEngine({
      bus,
      store: new ProactiveMessageStore(db, () => clock, 'tenant-a'),
      now: () => clock,
      logger: new SilentLogger(),
      tenantId: 'tenant-a',
    });
    engine.start();
    return engine;
  }

  it('显著信号（本租户）→ 主动消息入队', () => {
    makeEngine();
    bus.emit('system:evolution-completed', {
      mergedVersionIds: ['v1'], diffReport: {} as never, tenantId: 'tenant-a',
    });
    const msgs = store.list('default');
    assert.equal(msgs.length, 1, '应入队一条主动消息');
    assert.equal(msgs[0].kind, 'growth');
    assert.equal(msgs[0].signal_type, 'system:evolution-completed');
  });

  it('红线 7：缺 tenantId 的信号被 drop（不入队）', () => {
    makeEngine();
    bus.emit('core:memory-consolidated', {
      result: { originalId: 'm1', consolidatedId: 'm2', newKind: 'semantic' },
      /* 无 tenantId */
    } as never);
    assert.equal(store.list('default').length, 0, '无 tenantId 信号不应产生主动消息');
  });

  it('红线 7：其它租户的信号被 drop（隔离在信号入口）', () => {
    makeEngine();
    bus.emit('core:narrative-changed', {
      narrative: 'x', previousNarrative: 'y', tenantId: 'tenant-OTHER',
    });
    assert.equal(store.list('default').length, 0, '非本租户信号不应产生主动消息');
  });

  it('幂等（红线 8）：同一信号（同 sourceId）重复触发只入队一条', () => {
    makeEngine();
    const fire = (): void => {
      bus.emit('core:memory-consolidated', {
        result: { originalId: 'm1', consolidatedId: 'm2', newKind: 'semantic' }, tenantId: 'tenant-a',
      });
    };
    fire();
    fire(); /* 同 consolidatedId → 同 sourceId → 被唯一索引吞 */
    fire();
    assert.equal(store.list('default').length, 1, '同一信号最多一条');
  });

  it('幂等（红线 8）：同一信号跨静默窗口重放仍只一条（sourceId=信号身份非时间窗口）', () => {
    makeEngine();
    const fireEvo = (): void => {
      bus.emit('system:evolution-completed', {
        mergedVersionIds: ['v1', 'v2'], diffReport: {} as never, tenantId: 'tenant-a',
      });
    };
    fireEvo();
    assert.equal(store.list('default').length, 1);
    /* 推进时间越过静默期（+5h），重放**同一** evolution 信号（同 mergedVersionIds）→ 不应再产生一条。 */
    clock += 5 * 60 * 60 * 1000;
    fireEvo();
    assert.equal(store.list('default').length, 1, '同信号跨窗口重放被幂等键吞（红线 8）');
  });

  it('无稳定信号身份（空 mergedVersionIds）→ drop，不入队', () => {
    makeEngine();
    bus.emit('system:evolution-completed', {
      mergedVersionIds: [], diffReport: {} as never, tenantId: 'tenant-a',
    });
    assert.equal(store.list('default').length, 0, '拿不到稳定 sourceId 的信号宁可不发');
  });

  it('生产可达关闭（红线 3）：enabled=false → 不入队', () => {
    const engine = new ProactiveEngine({
      bus, store: new ProactiveMessageStore(db, () => clock, 'tenant-a'),
      now: () => clock, logger: new SilentLogger(), tenantId: 'tenant-a',
      config: { ...{ enabled: false, quietPeriodMs: 0, maxPerWindow: 99, windowMs: 1000 } },
    });
    engine.start();
    bus.emit('system:evolution-completed', {
      mergedVersionIds: ['v1'], diffReport: {} as never, tenantId: 'tenant-a',
    });
    assert.equal(store.list('default').length, 0, 'enabled=false 应完全关闭主动消息');
  });

  it('静默期：刚发过主动消息 → 下一条被门控抑制', () => {
    makeEngine();
    bus.emit('system:evolution-completed', {
      mergedVersionIds: ['v1'], diffReport: {} as never, tenantId: 'tenant-a',
    });
    assert.equal(store.list('default').length, 1);
    /* 推进时间但仍在静默期内（< 4h），换一类信号（避开幂等）→ 应被 quiet_period 抑制。 */
    clock += 60 * 60 * 1000; /* +1h < 4h 静默期 */
    bus.emit('core:narrative-changed', { narrative: 'x', previousNarrative: 'y', tenantId: 'tenant-a' });
    assert.equal(store.list('default').length, 1, '静默期内第二条应被抑制');
  });

  it('红线 5/10：订阅回调异常被隔离，emit 不外抛', () => {
    /* store.enqueue 抛错（模拟落库失败）→ 引擎应吞掉，bus.emit 不外抛。 */
    const throwingStore = {
      windowStats: () => ({ windowCount: 0, lastCreatedAt: null }),
      enqueue: () => { throw new Error('boom'); },
    } as unknown as ProactiveMessageStore;
    const engine = new ProactiveEngine({
      bus, store: throwingStore, now: () => clock, logger: new SilentLogger(), tenantId: 'tenant-a',
    });
    engine.start();
    /* emit 不应抛——若引擎未自包裹 try/catch，这里会炸。 */
    assert.doesNotThrow(() => {
      bus.emit('system:evolution-completed', {
        mergedVersionIds: ['v1'], diffReport: {} as never, tenantId: 'tenant-a',
      });
    });
  });

  it('stop() 后不再响应信号', () => {
    const engine = makeEngine();
    engine.stop();
    bus.emit('system:evolution-completed', {
      mergedVersionIds: ['v1'], diffReport: {} as never, tenantId: 'tenant-a',
    });
    assert.equal(store.list('default').length, 0, 'stop 后信号不再入队');
  });
});
