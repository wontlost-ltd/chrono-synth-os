/**
 * 共享纯函数 computeDriftFromSnapshots（ADR-0046 路线 A）：服务端 analyzer 与 desktop 本地共用的
 * drift 计算核心。这里在包级别锁住其语义（解析/delta/alertLevel/综合分/缺失价值跳过/空态）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDriftFromSnapshots,
  parseSnapshotValues,
  computeAlertLevel,
  type DriftThresholdsLike,
} from '../src/companion/drift-compute.js';

const TH: DriftThresholdsLike = { warning: 0.15, critical: 0.3 };

function snap(values: Array<{ id: string; label: string; weight: number }>): string {
  return JSON.stringify({ values });
}

describe('parseSnapshotValues', () => {
  it('兼容 values 与 L1 两种键', () => {
    assert.equal(parseSnapshotValues(snap([{ id: 'a', label: 'A', weight: 0.5 }])).get('a')?.weight, 0.5);
    assert.equal(
      parseSnapshotValues(JSON.stringify({ L1: [{ id: 'b', label: 'B', weight: 0.3 }] })).get('b')?.weight,
      0.3,
    );
  });
  it('非法 JSON / 非数组 → 空 Map，不抛', () => {
    assert.equal(parseSnapshotValues('{bad').size, 0);
    assert.equal(parseSnapshotValues(JSON.stringify({ values: 'x' })).size, 0);
  });
  it('缺 weight → 默认 0；缺 id → 跳过', () => {
    const m = parseSnapshotValues(JSON.stringify({ values: [{ id: 'a', label: 'A' }, { label: 'noid' }] }));
    assert.equal(m.get('a')?.weight, 0);
    assert.equal(m.size, 1);
  });

  it('真实快照形态：coreSelf.values 是序列化 Map（deepStringify 产物，Codex PR-4 Critical-3）', () => {
    const real = JSON.stringify({
      id: 'snap_1',
      coreSelf: {
        values: { __type: 'Map', entries: [['v1', { id: 'v1', label: '诚实', weight: 0.8 }]] },
        narrative: '',
      },
      personas: [],
    });
    const m = parseSnapshotValues(real);
    assert.equal(m.get('v1')?.weight, 0.8);
    assert.equal(m.get('v1')?.label, '诚实');
  });

  it('coreSelf.values 优先于顶层 values（真实快照不误读旧键）', () => {
    const data = JSON.stringify({
      coreSelf: { values: { __type: 'Map', entries: [['real', { id: 'real', label: 'R', weight: 0.9 }]] } },
      values: [{ id: 'legacy', label: 'L', weight: 0.1 }],
    });
    const m = parseSnapshotValues(data);
    assert.ok(m.has('real'));
    assert.ok(!m.has('legacy'), 'coreSelf.values 存在时不读顶层 values');
  });
});

describe('computeAlertLevel', () => {
  it('阈值分级：>=critical→critical，>=warning→warning，否则 ok', () => {
    assert.equal(computeAlertLevel(0.3, TH), 'critical');
    assert.equal(computeAlertLevel(0.2, TH), 'warning');
    assert.equal(computeAlertLevel(0.1, TH), 'ok');
    assert.equal(computeAlertLevel(0.15, TH), 'warning'); // 边界含等于
  });
});

describe('computeDriftFromSnapshots', () => {
  it('算 delta + alertLevel + 综合分；overall=mean(|delta|)', () => {
    const baseline = snap([
      { id: 'a', label: '冒险', weight: 0.2 },
      { id: 'b', label: '安稳', weight: 0.8 },
    ]);
    const current = snap([
      { id: 'a', label: '冒险', weight: 0.5 }, // +0.3 → critical
      { id: 'b', label: '安稳', weight: 0.7 }, // -0.1 → ok
    ]);
    const out = computeDriftFromSnapshots(baseline, current, TH);
    const byId = Object.fromEntries(out.valueDrifts.map((d) => [d.valueId, d] as const));
    assert.equal(byId.a.delta, 0.3);
    assert.equal(byId.a.alertLevel, 'critical');
    assert.ok(Math.abs(byId.b.delta - -0.1) < 1e-9);
    assert.equal(byId.b.alertLevel, 'ok');
    /* overall = (0.3 + 0.1)/2 = 0.2 */
    assert.ok(Math.abs(out.overallDriftScore - 0.2) < 1e-9);
    /* 整体 alertLevel = critical（有一条 critical）。 */
    assert.equal(out.alertLevel, 'critical');
  });

  it('current 缺失的 baseline 价值被跳过', () => {
    const out = computeDriftFromSnapshots(
      snap([{ id: 'a', label: 'A', weight: 0.5 }, { id: 'gone', label: 'G', weight: 0.4 }]),
      snap([{ id: 'a', label: 'A', weight: 0.5 }]),
      TH,
    );
    assert.equal(out.valueDrifts.length, 1);
    assert.equal(out.valueDrifts[0]?.valueId, 'a');
  });

  it('无可对比价值 → 空 drift + overall 0 + ok', () => {
    const out = computeDriftFromSnapshots(snap([]), snap([]), TH);
    assert.deepEqual(out.valueDrifts, []);
    assert.equal(out.overallDriftScore, 0);
    assert.equal(out.alertLevel, 'ok');
  });

  it('整体 alertLevel：仅 warning（无 critical）→ warning', () => {
    const out = computeDriftFromSnapshots(
      snap([{ id: 'a', label: 'A', weight: 0.0 }]),
      snap([{ id: 'a', label: 'A', weight: 0.2 }]), // +0.2 → warning
      TH,
    );
    assert.equal(out.alertLevel, 'warning');
  });
});
