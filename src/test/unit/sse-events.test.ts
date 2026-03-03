import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AvatarSessionPlatform,
  AvatarSessionTransport,
  AvatarSessionState,
  AvatarSessionInit,
  EventEnvelope,
  AvatarSnapshot,
  HandoffToken,
} from '../../types/avatar-session.js';
import {
  OFFLINE_COMMAND_WHITELIST,
  type OfflineCommandType,
  type OfflineCommandEnvelope,
} from '../../types/offline-queue.js';

describe('Avatar Session 类型契约', () => {
  it('AvatarSessionPlatform 覆盖所有平台', () => {
    const platforms: AvatarSessionPlatform[] = ['web', 'mobile', 'cli', 'iot'];
    assert.equal(platforms.length, 4);
  });

  it('AvatarSessionTransport 覆盖所有传输', () => {
    const transports: AvatarSessionTransport[] = ['ws', 'sse', 'poll'];
    assert.equal(transports.length, 3);
  });

  it('AvatarSessionState 覆盖完整生命周期', () => {
    const states: AvatarSessionState[] = [
      'idle', 'connecting', 'connected', 'subscribed',
      'receiving', 'offline', 'reconnecting', 'closed',
    ];
    assert.equal(states.length, 8);
  });

  it('AvatarSessionInit 结构完整', () => {
    const init: AvatarSessionInit = {
      avatarId: 'av_1',
      tenantId: 'tenant_1',
      platform: 'mobile',
      transport: 'auto',
      clientVersion: '1.0.0',
      replay: { sinceSeq: 42 },
      reconnect: {
        enabled: true,
        maxRetries: 5,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      },
    };
    assert.equal(init.avatarId, 'av_1');
    assert.equal(init.transport, 'auto');
    assert.equal(init.replay?.sinceSeq, 42);
    assert.equal(init.reconnect?.maxRetries, 5);
  });

  it('EventEnvelope 统一 WS/SSE/Poll 格式', () => {
    const envelope: EventEnvelope = {
      seq: 100,
      event: 'core:value-updated',
      data: { key: 'val' },
      tenantId: 'tenant_1',
      timestamp: Date.now(),
    };
    assert.equal(envelope.seq, 100);
    assert.equal(typeof envelope.timestamp, 'number');
  });

  it('AvatarSnapshot 包含完整快照字段', () => {
    const snapshot: AvatarSnapshot = {
      avatarId: 'av_1',
      seq: 50,
      projection: {
        L0: {},
        L1: { curiosity: 0.8 },
        L2: { riskAppetite: 0.5 },
        L3: { beliefs: {} },
        L4: { narrative: '测试', memoryCount: 10 },
      },
      autorun: { enabled: true, intervalMinutes: 60, lastRunAt: Date.now() },
      drift: { pendingReview: false, lastScore: 0.1, lastCheckAt: Date.now() },
      installedDevices: ['dev_1', 'dev_2'],
    };
    assert.equal(snapshot.avatarId, 'av_1');
    assert.equal(snapshot.projection.L4.memoryCount, 10);
    assert.equal(snapshot.autorun.enabled, true);
    assert.equal(snapshot.drift.lastScore, 0.1);
    assert.equal(snapshot.installedDevices.length, 2);
  });

  it('HandoffToken 结构验证', () => {
    const token: HandoffToken = {
      token: 'uuid-here',
      avatarId: 'av_1',
      fromDeviceId: 'dev_1',
      lastSeq: 99,
      expiresAt: Date.now() + 300_000,
    };
    assert.equal(token.avatarId, 'av_1');
    assert.ok(token.expiresAt > Date.now());
  });
});

describe('离线指令白名单', () => {
  it('白名单包含 4 种安全指令', () => {
    assert.equal(OFFLINE_COMMAND_WHITELIST.size, 4);
  });

  it('所有声明的类型均在白名单中', () => {
    const types: OfflineCommandType[] = [
      'drift_review', 'install_avatar', 'trigger_autorun', 'update_push_token',
    ];
    for (const t of types) {
      assert.ok(OFFLINE_COMMAND_WHITELIST.has(t), `${t} 不在白名单中`);
    }
  });

  it('OfflineCommandEnvelope 结构完整', () => {
    const cmd: OfflineCommandEnvelope = {
      id: 'cmd_1',
      type: 'drift_review',
      createdAt: Date.now(),
      payload: { decision: 'accept' },
      retries: 0,
    };
    assert.equal(cmd.type, 'drift_review');
    assert.equal(cmd.retries, 0);
  });
});
