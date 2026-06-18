/**
 * 通知投递门控（ADR-0054 红线 9）：默认关 + 安静时段（含跨午夜）的纯函数判定。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateNotificationGate,
  isWithinQuietHours,
  DEFAULT_NOTIFICATION_PREFERENCE,
} from '../src/domain/persona/notification-gate.js';

describe('DEFAULT_NOTIFICATION_PREFERENCE（红线 9：默认关）', () => {
  it('推送默认关闭', () => {
    assert.equal(DEFAULT_NOTIFICATION_PREFERENCE.nudgePushEnabled, false);
    assert.equal(DEFAULT_NOTIFICATION_PREFERENCE.quietStartMinute, null);
    assert.equal(DEFAULT_NOTIFICATION_PREFERENCE.quietEndMinute, null);
  });
});

describe('isWithinQuietHours', () => {
  it('同日区间 [start,end)：内→true，边界 start 含、end 不含', () => {
    assert.equal(isWithinQuietHours(600, 540, 660), true);  /* 10:00 在 9:00..11:00 内 */
    assert.equal(isWithinQuietHours(540, 540, 660), true);  /* 边界 start 含 */
    assert.equal(isWithinQuietHours(660, 540, 660), false); /* 边界 end 不含 */
    assert.equal(isWithinQuietHours(700, 540, 660), false); /* 区间外 */
  });

  it('跨午夜区间 [22:00, 07:00)：夜间→true，白天→false', () => {
    const start = 22 * 60, end = 7 * 60; /* 1320, 420 */
    assert.equal(isWithinQuietHours(23 * 60, start, end), true);  /* 23:00 静默 */
    assert.equal(isWithinQuietHours(3 * 60, start, end), true);   /* 03:00 静默 */
    assert.equal(isWithinQuietHours(end, start, end), false);     /* 07:00 边界不含 */
    assert.equal(isWithinQuietHours(12 * 60, start, end), false); /* 12:00 不静默 */
  });

  it('start===end → 空区间（不静默，避免全天静默歧义）', () => {
    assert.equal(isWithinQuietHours(600, 600, 600), false);
  });
});

describe('evaluateNotificationGate（红线 9）', () => {
  it('推送关 → disabled（默认/显式关都不投递）', () => {
    const d = evaluateNotificationGate({ nudgePushEnabled: false, quietStartMinute: null, quietEndMinute: null }, 600);
    assert.equal(d.deliver, false);
    assert.equal(d.reason, 'disabled');
  });

  it('推送开 + 无安静时段 → ok', () => {
    const d = evaluateNotificationGate({ nudgePushEnabled: true, quietStartMinute: null, quietEndMinute: null }, 600);
    assert.equal(d.deliver, true);
    assert.equal(d.reason, 'ok');
  });

  it('推送开 + 处于安静时段 → quiet_hours（夜间不打扰）', () => {
    const d = evaluateNotificationGate({ nudgePushEnabled: true, quietStartMinute: 22 * 60, quietEndMinute: 7 * 60 }, 2 * 60);
    assert.equal(d.deliver, false);
    assert.equal(d.reason, 'quiet_hours');
  });

  it('推送开 + 安静时段外 → ok', () => {
    const d = evaluateNotificationGate({ nudgePushEnabled: true, quietStartMinute: 22 * 60, quietEndMinute: 7 * 60 }, 14 * 60);
    assert.equal(d.deliver, true);
    assert.equal(d.reason, 'ok');
  });

  it('抑制优先级：关 先于 安静时段', () => {
    const d = evaluateNotificationGate({ nudgePushEnabled: false, quietStartMinute: 22 * 60, quietEndMinute: 7 * 60 }, 2 * 60);
    assert.equal(d.reason, 'disabled');
  });
});
