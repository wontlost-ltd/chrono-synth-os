/**
 * 共享纯函数 driftReportToGrowth（ADR-0046）：persona drift → C 端「你最近探索的方向」。
 * 服务端与 desktop 本地共用同一份映射，这里在包级别锁住其语义（排序/夹取/方向/强度/空态）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  driftReportToGrowth,
  alertLevelToIntensity,
  valueDriftToDirection,
  type DriftLike,
} from '../src/companion/drift-to-growth.js';

describe('alertLevelToIntensity', () => {
  it('ok→steady, warning→exploring, critical→leaping', () => {
    assert.equal(alertLevelToIntensity('ok'), 'steady');
    assert.equal(alertLevelToIntensity('warning'), 'exploring');
    assert.equal(alertLevelToIntensity('critical'), 'leaping');
  });
});

describe('valueDriftToDirection', () => {
  it('delta 符号→方向，magnitude=|delta| 夹到 0..1', () => {
    assert.deepEqual(valueDriftToDirection({ valueId: 'a', label: '冒险', delta: 0.3, alertLevel: 'warning' }),
      { valueId: 'a', label: '冒险', direction: 'toward', magnitude: 0.3, intensity: 'exploring' });
    assert.deepEqual(valueDriftToDirection({ valueId: 'b', label: '安稳', delta: -0.3, alertLevel: 'warning' }),
      { valueId: 'b', label: '安稳', direction: 'away', magnitude: 0.3, intensity: 'exploring' });
    assert.equal(valueDriftToDirection({ valueId: 'd', label: '越界', delta: 1.5, alertLevel: 'critical' }).magnitude, 1);
    assert.equal(valueDriftToDirection({ valueId: 'c', label: '中立', delta: 0, alertLevel: 'ok' }).direction, 'steady');
  });
});

describe('driftReportToGrowth', () => {
  it('report=null → 空态（hasBaseline=false, analyzedAt=null）', () => {
    const out = driftReportToGrowth(null, false);
    assert.equal(out.hasBaseline, false);
    assert.equal(out.analyzedAt, null);
    assert.equal(out.overallIntensity, 'steady');
    assert.deepEqual(out.directions, []);
    assert.equal(out.schemaVersion, 'companion-growth.v1');
  });

  it('有报告但 hasComparisonBaseline=false（单快照）→ 空态但保留 analyzedAt', () => {
    const report: DriftLike = { analyzedAt: 7, valueDrifts: [], alertLevel: 'ok' };
    const out = driftReportToGrowth(report, false);
    assert.equal(out.hasBaseline, false);
    assert.equal(out.analyzedAt, 7);
    assert.deepEqual(out.directions, []);
  });

  it('有可对比基线 → directions 按 magnitude 降序 + overallIntensity 来自 alertLevel', () => {
    const report: DriftLike = {
      analyzedAt: 5,
      alertLevel: 'warning',
      valueDrifts: [
        { valueId: 'a', label: '冒险', delta: 0.3, alertLevel: 'warning' },
        { valueId: 'b', label: '安稳', delta: -0.3, alertLevel: 'warning' },
        { valueId: 'c', label: '中立', delta: 0, alertLevel: 'ok' },
        { valueId: 'd', label: '越界', delta: 1.5, alertLevel: 'critical' },
      ],
    };
    const out = driftReportToGrowth(report, true);
    assert.equal(out.hasBaseline, true);
    assert.equal(out.analyzedAt, 5);
    assert.equal(out.overallIntensity, 'exploring');
    assert.equal(out.directions[0]?.valueId, 'd', 'magnitude 最大(夹到1)排首');
    assert.equal(out.directions[0]?.magnitude, 1);
    const byId = Object.fromEntries(out.directions.map((x) => [x.valueId, x] as const));
    assert.equal(byId.a?.direction, 'toward');
    assert.equal(byId.b?.direction, 'away');
    assert.equal(byId.c?.direction, 'steady');
  });
});
