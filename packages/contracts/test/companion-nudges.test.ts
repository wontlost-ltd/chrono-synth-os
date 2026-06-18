/**
 * ChronoCompanion 主动消息列表契约（ADR-0054）：锁住 CompanionNudgeListV1 的形状，
 * 让 web/mobile 前端与后端 DTO 单一来源（防漂移）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompanionNudgeV1Schema,
  CompanionNudgeListV1Schema,
} from '../src/companion/nudges.js';

describe('CompanionNudge 契约（ADR-0054）', () => {
  const validNudge = {
    id: 'pmsg-1', kind: 'growth', body: '我好像又成长了一点。',
    status: 'unread', createdAt: 1_700_000_000_000, readAt: null,
  };

  it('合法单条 nudge 通过', () => {
    assert.doesNotThrow(() => CompanionNudgeV1Schema.parse(validNudge));
  });

  it('readAt 可为 number（已读时间）或 null（未读）', () => {
    assert.doesNotThrow(() => CompanionNudgeV1Schema.parse({ ...validNudge, readAt: 1_700_000_001_000 }));
    assert.doesNotThrow(() => CompanionNudgeV1Schema.parse({ ...validNudge, readAt: null }));
  });

  it('strict：多余字段被拒（防后端误带 signal_type 等溯源内部）', () => {
    assert.throws(() => CompanionNudgeV1Schema.parse({ ...validNudge, signal_type: 'leak' }));
  });

  it('缺必填字段被拒', () => {
    const { body, ...noBody } = validNudge;
    void body;
    assert.throws(() => CompanionNudgeV1Schema.parse(noBody));
  });

  it('列表：schemaVersion 字面量 + items 数组', () => {
    const list = { schemaVersion: 'companion-nudge-list.v1', items: [validNudge, { ...validNudge, id: 'pmsg-2', status: 'read', readAt: 1_700_000_002_000 }] };
    assert.doesNotThrow(() => CompanionNudgeListV1Schema.parse(list));
  });

  it('列表：错误 schemaVersion 被拒', () => {
    assert.throws(() => CompanionNudgeListV1Schema.parse({ schemaVersion: 'wrong.v1', items: [] }));
  });

  it('列表：空 items 合法（无主动消息）', () => {
    assert.doesNotThrow(() => CompanionNudgeListV1Schema.parse({ schemaVersion: 'companion-nudge-list.v1', items: [] }));
  });
});
