import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { ProactiveMessageStore } from '../../storage/proactive-message-store.js';
import { ProactiveEngine } from '../../proactivity/proactive-engine.js';
import { EventBus } from '../../events/event-bus.js';
import { SilentLogger } from '../../utils/logger.js';
import { VALID_EVENTS } from '../../server/plugins/websocket.js';
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

  it('P4 个性化：memory-consolidated 取触发记忆 content 进文案（配 boundaryChecker）', () => {
    const engine = new ProactiveEngine({
      bus, store: new ProactiveMessageStore(db, () => clock, 'tenant-a'),
      now: () => clock, logger: new SilentLogger(), tenantId: 'tenant-a',
      context: {
        getNarrative: () => '我是一个爱探索的人',
        getMemoryContent: (id) => (id === 'mem-X' ? '那次徒步到山顶看云海' : undefined),
      },
      boundaryChecker: { violates: () => false },
    });
    engine.start();
    bus.emit('core:memory-consolidated', {
      result: { originalId: 'm0', consolidatedId: 'mem-X', newKind: 'semantic' }, tenantId: 'tenant-a',
    });
    const msgs = store.list('default');
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].body, /那次徒步到山顶看云海/, '个性化文案应引用触发记忆内容');
  });

  it('P4 红线 4 不变量：有 context 但无 boundaryChecker → 不个性化（不绕过边界）', () => {
    const engine = new ProactiveEngine({
      bus, store: new ProactiveMessageStore(db, () => clock, 'tenant-a'),
      now: () => clock, logger: new SilentLogger(), tenantId: 'tenant-a',
      context: {
        getNarrative: () => 'x',
        getMemoryContent: () => '一段没过自检的内容',
      },
      /* 故意不传 boundaryChecker */
    });
    engine.start();
    bus.emit('core:memory-consolidated', {
      result: { originalId: 'm0', consolidatedId: 'mem-X', newKind: 'semantic' }, tenantId: 'tenant-a',
    });
    const msgs = store.list('default');
    assert.equal(msgs.length, 1);
    assert.ok(!msgs[0].body.includes('「'), '无自检能力 → 退基线模板，绝不个性化（红线 4 不变量）');
    assert.ok(!msgs[0].body.includes('一段没过自检的内容'), '无 checker 不引用任何记忆/叙事内容');
  });

  it('P4 红线 4：个性化文案命中 never_discuss → 回退基线模板', () => {
    const engine = new ProactiveEngine({
      bus, store: new ProactiveMessageStore(db, () => clock, 'tenant-a'),
      now: () => clock, logger: new SilentLogger(), tenantId: 'tenant-a',
      context: {
        getNarrative: () => 'x',
        getMemoryContent: () => '我的银行卡号是 1234', /* 含敏感主题 */
      },
      boundaryChecker: { violates: (text) => text.includes('银行卡号') },
    });
    engine.start();
    bus.emit('core:memory-consolidated', {
      result: { originalId: 'm0', consolidatedId: 'mem-Y', newKind: 'semantic' }, tenantId: 'tenant-a',
    });
    const msgs = store.list('default');
    assert.equal(msgs.length, 1);
    assert.ok(!msgs[0].body.includes('银行卡号'), '命中 never_discuss 应回退安全基线模板');
    assert.ok(!msgs[0].body.includes('「'), '回退的是基线模板（无引号片段）');
  });

  it('P4 无 context → 仍用基线模板入队（向后兼容 P3）', () => {
    makeEngine(); /* 无 context/boundaryChecker */
    bus.emit('core:memory-consolidated', {
      result: { originalId: 'm0', consolidatedId: 'mem-Z', newKind: 'semantic' }, tenantId: 'tenant-a',
    });
    const msgs = store.list('default');
    assert.equal(msgs.length, 1);
    assert.ok(!msgs[0].body.includes('「'), '无 context 用基线模板');
  });

  it('P6：真入队 → 发 companion:nudge-created（in-app push 刷新信号，不带 body）', () => {
    makeEngine();
    const received: Array<{ nudgeId: string; kind: string; tenantId?: string }> = [];
    bus.on('companion:nudge-created', (p) => received.push(p));
    bus.emit('system:evolution-completed', {
      mergedVersionIds: ['v1'], diffReport: {} as never, tenantId: 'tenant-a',
    });
    assert.equal(received.length, 1, '真入队应发一条 nudge-created');
    assert.equal(received[0].tenantId, 'tenant-a', '带 tenantId（供 SSE 租户过滤）');
    assert.equal(received[0].kind, 'growth');
    assert.ok(received[0].nudgeId.startsWith('pmsg'), '带 nudgeId（客户端据此拉取）');
    /* 事件不含 body——正文经认证 GET /nudges 取。 */
    assert.ok(!('body' in received[0]), 'nudge-created 不带 body');
  });

  it('P6：幂等忽略（同信号重放）→ 不重复发 nudge-created', () => {
    makeEngine();
    const received: unknown[] = [];
    bus.on('companion:nudge-created', (p) => received.push(p));
    const fire = (): void => {
      bus.emit('system:evolution-completed', {
        mergedVersionIds: ['v1'], diffReport: {} as never, tenantId: 'tenant-a',
      });
    };
    fire();
    fire(); /* 同信号 → 幂等忽略 → 不应再发事件 */
    assert.equal(received.length, 1, '幂等忽略不重复发 nudge-created');
  });

  it('P6：companion:nudge-created 在 SSE/WS 转发白名单 VALID_EVENTS 中', () => {
    /* 不在白名单 → SSE/WS 不会转发该事件，in-app push 失效。 */
    assert.ok(VALID_EVENTS.has('companion:nudge-created'), 'nudge-created 必须在 SSE/WS 转发白名单');
  });
});
