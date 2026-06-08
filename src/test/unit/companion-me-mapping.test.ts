/**
 * 单元测试：companion C 端映射纯函数（ADR-0046 Phase 2.1）。
 *
 * 路由是薄胶水，真正的逻辑在这些纯映射里——尤其是「企业版 drift → C 端探索方向」
 * 的语义转换（roadmap Phase 2 退出条件 5.2）。这里覆盖映射、排序、夹取、空态。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCompanionValue,
  toCompanionMemory,
} from '../../server/routes/companion/me.js';
import { driftReportToGrowth } from '@chrono/contracts';
import type { DriftLike } from '@chrono/contracts';
import type { CoreValue } from '@chrono/kernel';
import type { MemoryNode } from '@chrono/kernel';
import type { DriftReport } from '../../safety/persona-drift-analyzer.js';

/* 编译期防回归锁：真实的 DriftReport 必须结构化满足 contracts 的 DriftLike 入参。
 * driftReportToGrowth 抽到 @chrono/contracts 后用结构化 DriftLike 解耦，这条断言确保
 * 未来若 PersonaDriftAnalyzer 改了 alertLevel 取值或 valueDrifts 字段，类型检查直接报错，
 * 而非运行时静默漂移（Codex PR-B 审查 Suggestion）。仅类型层面，无运行时开销。 */
const _driftReportSatisfiesDriftLike: DriftLike = {} as DriftReport;
void _driftReportSatisfiesDriftLike;

function coreValue(over: Partial<CoreValue> = {}): CoreValue {
  return { id: 'v1', label: '好奇心', weight: 0.7, timeDiscount: 0.5, emotionAmplifier: 1, updatedAt: 1000, ...over };
}

function memoryNode(over: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'm1', kind: 'episodic', content: '第一次对话', valence: 0.4, salience: 0.6,
    createdAt: 1000, lastAccessedAt: 1000, accessCount: 0, decayLambda: 0.01,
    lastDecayedAt: 1000, consolidatedFrom: null, ...over,
  } as MemoryNode;
}

describe('toCompanionValue', () => {
  it('只保留 id/label/weight，丢弃调参细节', () => {
    const out = toCompanionValue(coreValue({ timeDiscount: 0.9, emotionAmplifier: 2 }));
    assert.deepEqual(out, { id: 'v1', label: '好奇心', weight: 0.7 });
  });
});

describe('toCompanionMemory', () => {
  it('只保留陪伴所需字段（无 decay/access 内部状态）', () => {
    const out = toCompanionMemory(memoryNode({ accessCount: 99, decayLambda: 0.5 }));
    assert.deepEqual(out, {
      id: 'm1', kind: 'episodic', content: '第一次对话', valence: 0.4, salience: 0.6, createdAt: 1000,
    });
  });
});

describe('driftReportToGrowth（企业 drift → C 端探索语义）', () => {
  it('无报告（从未分析）→「还在认识你」空态', () => {
    const out = driftReportToGrowth(null, false);
    assert.equal(out.hasBaseline, false);
    assert.equal(out.analyzedAt, null);
    assert.equal(out.overallIntensity, 'steady');
    assert.deepEqual(out.directions, []);
    assert.equal(out.schemaVersion, 'companion-growth.v1');
  });

  it('有报告但无可对比基线（单快照，hasComparisonBaseline=false）→ 空态，但保留 analyzedAt', () => {
    /* 复现 PersonaDriftAnalyzer 单快照分支：baselineSnapshotId 非 null 但其实没有历史基线 */
    const singleSnapshotReport: DriftReport = {
      reportId: 'r', tenantId: 't', baselineSnapshotId: 'snap-current', analyzedAt: 7,
      valueDrifts: [], overallDriftScore: 0, alertLevel: 'ok',
    };
    const out = driftReportToGrowth(singleSnapshotReport, false);
    assert.equal(out.hasBaseline, false, '单快照不算基线');
    assert.equal(out.analyzedAt, 7);
    assert.deepEqual(out.directions, []);
  });

  it('alertLevel 映射成探索强度：ok→steady, warning→exploring, critical→leaping', () => {
    const mk = (level: DriftReport['alertLevel']): DriftReport => ({
      reportId: 'r', tenantId: 't', baselineSnapshotId: 'snap', analyzedAt: 5,
      valueDrifts: [], overallDriftScore: 0, alertLevel: level,
    });
    assert.equal(driftReportToGrowth(mk('ok'), true).overallIntensity, 'steady');
    assert.equal(driftReportToGrowth(mk('warning'), true).overallIntensity, 'exploring');
    assert.equal(driftReportToGrowth(mk('critical'), true).overallIntensity, 'leaping');
  });

  it('delta 符号→方向：正=toward，负=away，零=steady；magnitude=|delta| 夹到 0..1', () => {
    const report: DriftReport = {
      reportId: 'r', tenantId: 't', baselineSnapshotId: 'snap', analyzedAt: 5,
      overallDriftScore: 0.5, alertLevel: 'warning',
      valueDrifts: [
        { valueId: 'a', label: '冒险', baseline: 0.2, current: 0.5, delta: 0.3, alertLevel: 'warning' },
        { valueId: 'b', label: '安稳', baseline: 0.8, current: 0.5, delta: -0.3, alertLevel: 'warning' },
        { valueId: 'c', label: '中立', baseline: 0.5, current: 0.5, delta: 0, alertLevel: 'ok' },
        { valueId: 'd', label: '越界', baseline: 0.0, current: 1.0, delta: 1.5, alertLevel: 'critical' },
      ],
    };
    const out = driftReportToGrowth(report, true);
    assert.equal(out.hasBaseline, true);
    assert.equal(out.analyzedAt, 5);
    /* 按 magnitude 降序：d(1.0 夹取) > a(0.3)=b(0.3) > c(0) */
    assert.equal(out.directions[0].valueId, 'd');
    assert.equal(out.directions[0].magnitude, 1, 'magnitude 夹到 1');
    assert.equal(out.directions[0].direction, 'toward');
    assert.equal(out.directions[0].intensity, 'leaping');
    const byId = Object.fromEntries(out.directions.map((x) => [x.valueId, x] as const));
    assert.equal(byId.a.direction, 'toward');
    assert.equal(byId.b.direction, 'away');
    assert.equal(byId.c.direction, 'steady');
    assert.equal(byId.c.magnitude, 0);
  });
});
