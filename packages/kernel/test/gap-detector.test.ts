/**
 * GapDetector + 能力分类法单元测试（ADR-0057 L1）。
 *
 * 锁住确定性缺口检测的核心不变量：required − learned = 缺口；零-LLM 纯集合差；规范化归一；
 * 多能力任务多缺口；全覆盖无缺口；同输入同输出可复现。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCapabilityGaps,
  normalizeCapability,
  normalizeCapabilities,
  isKnownCapability,
  KNOWN_CAPABILITIES,
} from '../src/domain/capability/index.js';

describe('能力分类法 normalizeCapability（确定性规范化）', () => {
  it('小写 + trim + 空白折叠下划线', () => {
    assert.equal(normalizeCapability('  Research '), 'research');
    assert.equal(normalizeCapability('Data Extraction'), 'data_extraction');
    assert.equal(normalizeCapability('LITERATURE   REVIEW'), 'literature_review');
  });

  it('非字符串/空 → 空串', () => {
    assert.equal(normalizeCapability(''), '');
    assert.equal(normalizeCapability('   '), '');
    assert.equal(normalizeCapability(undefined as unknown as string), '');
  });

  it('normalizeCapabilities：去重 + 去空 + 字典序（可复现）', () => {
    assert.deepEqual(
      normalizeCapabilities(['Review', 'review', ' compliance ', '', '  ', 'Analysis']),
      ['analysis', 'compliance', 'review'],
    );
  });

  it('isKnownCapability：词表内（规范化后）= true，词表外 = false', () => {
    assert.equal(isKnownCapability('Research'), true);
    assert.equal(isKnownCapability(' COMPLIANCE '), true);
    assert.equal(isKnownCapability('quantum_alchemy'), false);
    /* 词表是参考，不限制取值——未知能力仍能成为缺口（见 detector 测试）。 */
    assert.ok(KNOWN_CAPABILITIES.includes('research'));
  });
});

describe('GapDetector detectCapabilityGaps（ADR-0057 L1 缺口检测）', () => {
  it('★全缺★：任务要求 [research, writing]，persona 无任何学过 → 两个缺口', () => {
    const r = detectCapabilityGaps({
      requiredCapabilities: ['research', 'writing'],
      personaLearnedCapabilities: [],
    });
    assert.equal(r.hasGap, true);
    assert.deepEqual(r.gaps.map((g) => g.capability), ['research', 'writing']);
  });

  it('★部分缺（ADR 招牌例）★：要求 [review, compliance]，已学 review → 只缺 compliance', () => {
    const r = detectCapabilityGaps({
      requiredCapabilities: ['review', 'compliance'],
      personaLearnedCapabilities: ['review'],
    });
    assert.equal(r.gaps.length, 1);
    assert.equal(r.gaps[0]!.capability, 'compliance');
  });

  it('★全覆盖无缺★：要求 [review]，已学 [review, compliance] → 无缺口（可零-LLM 直接干）', () => {
    const r = detectCapabilityGaps({
      requiredCapabilities: ['review'],
      personaLearnedCapabilities: ['review', 'compliance'],
    });
    assert.equal(r.hasGap, false);
    assert.equal(r.gaps.length, 0);
  });

  it('★规范化归一★：书写差异不致假缺口（Review/review/ review 视为同一能力）', () => {
    const r = detectCapabilityGaps({
      requiredCapabilities: ['Review', ' COMPLIANCE '],
      personaLearnedCapabilities: ['review', 'compliance'],
    });
    assert.equal(r.hasGap, false, '规范化后已覆盖，无假缺口');
  });

  it('★未知能力也能成为缺口★：词表外能力仍按差集判缺（不锁死扩展）', () => {
    const r = detectCapabilityGaps({
      requiredCapabilities: ['quantum_alchemy'],
      personaLearnedCapabilities: ['research'],
    });
    assert.deepEqual(r.gaps.map((g) => g.capability), ['quantum_alchemy']);
  });

  it('★缺口字典序稳定（可复现）★：乱序输入 → 同序缺口', () => {
    const a = detectCapabilityGaps({ requiredCapabilities: ['writing', 'analysis', 'research'], personaLearnedCapabilities: [] });
    const b = detectCapabilityGaps({ requiredCapabilities: ['research', 'writing', 'analysis'], personaLearnedCapabilities: [] });
    assert.deepEqual(a.gaps.map((g) => g.capability), ['analysis', 'research', 'writing']);
    assert.deepEqual(a.gaps.map((g) => g.capability), b.gaps.map((g) => g.capability), '同集合不同序 → 同缺口序');
  });

  it('★优先级直传 + 证据可审计★：taskPriority/taskId 写进缺口记录', () => {
    const r = detectCapabilityGaps({
      requiredCapabilities: ['compliance'],
      personaLearnedCapabilities: [],
      taskPriority: 'high',
      taskId: 'task-42',
    });
    assert.equal(r.gaps[0]!.priority, 'high');
    assert.match(r.gaps[0]!.evidence, /task-42/);
    assert.match(r.gaps[0]!.evidence, /compliance/);
  });

  it('★缺省优先级 medium★', () => {
    const r = detectCapabilityGaps({ requiredCapabilities: ['triage'], personaLearnedCapabilities: [] });
    assert.equal(r.gaps[0]!.priority, 'medium');
  });

  it('★空要求 → 无缺口★：任务不声明所需能力 → 不阻塞', () => {
    const r = detectCapabilityGaps({ requiredCapabilities: [], personaLearnedCapabilities: [] });
    assert.equal(r.hasGap, false);
  });

  it('★重复要求去重★：[review, review] → 单缺口', () => {
    const r = detectCapabilityGaps({ requiredCapabilities: ['review', 'review'], personaLearnedCapabilities: [] });
    assert.equal(r.gaps.length, 1);
  });

  it('★空白折叠 vs 已规范化 snake_case 兼容★：" Data   Extraction " 已学 data_extraction → 无缺口（Codex 建议）', () => {
    const r = detectCapabilityGaps({
      requiredCapabilities: [' Data   Extraction '],
      personaLearnedCapabilities: ['data_extraction'],
    });
    assert.equal(r.hasGap, false, '空白折叠下划线后与已学 snake_case 归一，无假缺口');
  });
});
