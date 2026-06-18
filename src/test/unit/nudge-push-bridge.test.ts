import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { SilentLogger } from '../../utils/logger.js';
import { MobileDeviceService } from '../../identity/mobile-device-service.js';
import { NotificationPreferenceStore } from '../../storage/notification-preference-store.js';
import { NudgePushBridge } from '../../server/services/nudge-push-bridge.js';
import type { IDatabase } from '../../storage/database.js';
import type { PushService, PushPayload, PushResult } from '../../types/push.js';

/* 记录所有 send 调用的 mock pushService。 */
function makeMockPush(): { service: PushService; sent: Array<{ deviceId: string; payload: PushPayload }> } {
  const sent: Array<{ deviceId: string; payload: PushPayload }> = [];
  const service: PushService = {
    channel: 'mock',
    async send(_tenantId, deviceId, payload): Promise<PushResult> {
      sent.push({ deviceId, payload });
      return { deviceId, success: true };
    },
    async sendBatch() { return []; },
  };
  return { service, sent };
}

function seedUser(db: IDatabase, tenantId: string, userId: string): void {
  /* email 含 tenantId 保证全局唯一（users.email 有 UNIQUE 约束；同 userId 跨租户测试需不同 email）。 */
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, 'h', 'member', ?, 1000, 1000)`,
  ).run(userId, `${tenantId}-${userId}@t.com`, tenantId);
}

/** 等待 bridge 的 fire-and-forget async deliver 完成（microtask flush）。 */
async function flush(): Promise<void> { await new Promise((r) => setTimeout(r, 0)); }

describe('NudgePushBridge（ADR-0054 ③ nudge→系统推送）', () => {
  let db: IDatabase;
  let bus: EventBus;
  let push: ReturnType<typeof makeMockPush>;
  let bridge: NudgePushBridge;
  const NOW = 14 * 60 * 60 * 1000; /* UTC 14:00（安静时段外） */

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    bus = new EventBus();
    push = makeMockPush();
    bridge = new NudgePushBridge({ bus, db, pushService: push.service, logger: new SilentLogger(), now: () => NOW });
    bridge.start();
  });

  function seedUserWithDevice(tenantId: string, userId: string, pushToken: string | null): string {
    seedUser(db, tenantId, userId);
    const dev = new MobileDeviceService(db).register(tenantId, userId, {
      deviceUid: `uid-${userId}`, platform: 'ios', pushToken: pushToken ?? undefined,
    });
    return dev.id;
  }

  function enablePush(tenantId: string, userId: string, quiet?: { start: number; end: number }): void {
    new NotificationPreferenceStore(db, () => NOW, tenantId).set(userId, {
      nudgePushEnabled: true,
      quietStartMinute: quiet?.start ?? null,
      quietEndMinute: quiet?.end ?? null,
    });
  }

  it('同意开 + 有设备 token → 推送（不带 nudge 正文，只 tap-to-open）', async () => {
    const devId = seedUserWithDevice('tenant-a', 'u1', 'tok-1');
    enablePush('tenant-a', 'u1');
    bus.emit('companion:nudge-created', { nudgeId: 'pmsg-1', kind: 'growth', tenantId: 'tenant-a' });
    await flush();

    assert.equal(push.sent.length, 1, '应推一条');
    assert.equal(push.sent[0].deviceId, devId);
    /* 隐私：payload 不含 nudge 正文，只 tap-to-open data。 */
    assert.equal(push.sent[0].payload.data?.nudgeId, 'pmsg-1');
    assert.equal(push.sent[0].payload.data?.type, 'nudge');
    assert.ok(!JSON.stringify(push.sent[0].payload).includes('我好像又成长了'), '不带 nudge 正文');
  });

  it('红线9 默认关：未设置同意 → 不推送', async () => {
    seedUserWithDevice('tenant-a', 'u1', 'tok-1');
    /* 不调 enablePush → DEFAULT 关 */
    bus.emit('companion:nudge-created', { nudgeId: 'pmsg-1', kind: 'growth', tenantId: 'tenant-a' });
    await flush();
    assert.equal(push.sent.length, 0, '默认关不推送');
  });

  it('红线9 安静时段：同意开但处于安静时段 → 不推送', async () => {
    seedUserWithDevice('tenant-a', 'u1', 'tok-1');
    /* 安静时段覆盖当前 UTC 14:00（13:00..15:00）。 */
    enablePush('tenant-a', 'u1', { start: 13 * 60, end: 15 * 60 });
    bus.emit('companion:nudge-created', { nudgeId: 'pmsg-1', kind: 'growth', tenantId: 'tenant-a' });
    await flush();
    assert.equal(push.sent.length, 0, '安静时段不推送');
  });

  it('无 push token 的设备被跳过', async () => {
    seedUserWithDevice('tenant-a', 'u1', null); /* 无 token */
    enablePush('tenant-a', 'u1');
    bus.emit('companion:nudge-created', { nudgeId: 'pmsg-1', kind: 'growth', tenantId: 'tenant-a' });
    await flush();
    assert.equal(push.sent.length, 0, '无 token 设备跳过');
  });

  it('红线7：缺 tenantId/nudgeId → drop（不推）', async () => {
    seedUserWithDevice('tenant-a', 'u1', 'tok-1');
    enablePush('tenant-a', 'u1');
    bus.emit('companion:nudge-created', { nudgeId: 'pmsg-1', kind: 'growth' } as never); /* 无 tenantId */
    await flush();
    assert.equal(push.sent.length, 0);
  });

  it('租户隔离：A 的 nudge 不推给 B 的设备', async () => {
    seedUserWithDevice('tenant-a', 'ua', 'tok-a'); enablePush('tenant-a', 'ua');
    seedUserWithDevice('tenant-b', 'ub', 'tok-b'); enablePush('tenant-b', 'ub');
    bus.emit('companion:nudge-created', { nudgeId: 'pmsg-1', kind: 'growth', tenantId: 'tenant-a' });
    await flush();
    assert.equal(push.sent.length, 1, '只推 tenant-a');
    assert.equal(push.sent[0].deviceId, new MobileDeviceService(db).listByTenantUser('tenant-a', 'ua')[0].id);
  });

  it('租户隔离（Codex 退回 High）：同 user_id 跨租户的设备 → A 的 nudge 只推 A 租户的设备', async () => {
    /* 关键场景：tenant-a 的 user id='shared' 有设备；tenant-b 存在一台 user_id='shared' 的设备
     * （脏数据 / user_id 非全局唯一）。宿主 DB 上 listByUser('shared') 会取到两租户的设备——
     * 桥必须用 listByTenantUser 只取 tenant-a 的。 */
    const devA = seedUserWithDevice('tenant-a', 'shared', 'tok-a'); enablePush('tenant-a', 'shared');
    /* 直接插一台 tenant-b、user_id='shared' 的设备（不建 tenant-b 用户——模拟脏行/跨租户）。 */
    new MobileDeviceService(db).register('tenant-b', 'shared', {
      deviceUid: 'uid-b', platform: 'ios', pushToken: 'tok-b',
    });
    assert.equal(new MobileDeviceService(db).listByUser('shared').length, 2, '前置：listByUser(无tenant) 取到 2 台');
    assert.equal(new MobileDeviceService(db).listByTenantUser('tenant-a', 'shared').length, 1, '前置：listByTenantUser 只取 1 台');

    bus.emit('companion:nudge-created', { nudgeId: 'pmsg-1', kind: 'growth', tenantId: 'tenant-a' });
    await flush();
    assert.equal(push.sent.length, 1, '只推 tenant-a 的设备（不串 tenant-b）');
    assert.equal(push.sent[0].deviceId, devA);
  });

  it('失败隔离：pushService.send 抛错 → emit 不外抛', async () => {
    const throwing: PushService = {
      channel: 'mock',
      send: async () => { throw new Error('boom'); },
      sendBatch: async () => [],
    };
    const b2 = new NudgePushBridge({ bus, db, pushService: throwing, logger: new SilentLogger(), now: () => NOW });
    b2.start();
    seedUserWithDevice('tenant-a', 'u1', 'tok-1'); enablePush('tenant-a', 'u1');
    /* emit 同步返回不抛（push 是 async fire-and-forget）。 */
    assert.doesNotThrow(() => {
      bus.emit('companion:nudge-created', { nudgeId: 'pmsg-1', kind: 'growth', tenantId: 'tenant-a' });
    });
    await flush();
  });

  it('stop() 后不再响应', async () => {
    seedUserWithDevice('tenant-a', 'u1', 'tok-1'); enablePush('tenant-a', 'u1');
    bridge.stop();
    bus.emit('companion:nudge-created', { nudgeId: 'pmsg-1', kind: 'growth', tenantId: 'tenant-a' });
    await flush();
    assert.equal(push.sent.length, 0);
  });
});
