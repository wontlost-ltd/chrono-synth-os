/**
 * 单元测试：ConfidenceCalibrator（P1-C 校准）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calibrateConfidence } from '../../conversation/confidence-calibrator.js';

describe('ConfidenceCalibrator', () => {
  it('base 0.5 + 无知识 → score 接近 0.5, level=medium', () => {
    const c = calibrateConfidence({
      memoriesUsed: [],
      guardAction: null,
      shouldEscalate: false,
      llmFallback: false,
      quotaExceeded: false,
      completionTokens: 100,
    });
    assert.equal(c.score, 0.5);
    assert.equal(c.level, 'medium');
    assert.ok(c.factors.some((f) => f.name === 'base'));
  });

  it('多源知识高相关度 → score 提升至 high', () => {
    const c = calibrateConfidence({
      memoriesUsed: [
        { id: '1', title: 'A', content: 'a', relevance: 0.9 },
        { id: '2', title: 'B', content: 'b', relevance: 0.85 },
        { id: '3', title: 'C', content: 'c', relevance: 0.8 },
      ],
      guardAction: null,
      shouldEscalate: false,
      llmFallback: false,
      quotaExceeded: false,
      completionTokens: 200,
    });
    assert.ok(c.score >= 0.75, `score should be high, got ${c.score}`);
    assert.equal(c.level, 'high');
    assert.ok(c.factors.some((f) => f.name === 'knowledge_coverage'));
    assert.ok(c.factors.some((f) => f.name === 'knowledge_count'));
  });

  it('llm_fallback → score 大幅下降, level=low', () => {
    const c = calibrateConfidence({
      memoriesUsed: [],
      guardAction: 'llm_fallback',
      shouldEscalate: false,
      llmFallback: true,
      quotaExceeded: false,
      completionTokens: 0,
    });
    assert.ok(c.score < 0.3);
    assert.equal(c.level, 'low');
    assert.ok(c.factors.some((f) => f.name === 'llm_fallback'));
  });

  it('quota_exceeded → score 大幅下降', () => {
    const c = calibrateConfidence({
      memoriesUsed: [],
      guardAction: 'quota_exceeded',
      shouldEscalate: true,
      llmFallback: false,
      quotaExceeded: true,
      completionTokens: 0,
    });
    assert.ok(c.score < 0.3);
    assert.ok(c.factors.some((f) => f.name === 'quota_exceeded'));
  });

  it('post_redact → score 下降并扩大 interval', () => {
    const c = calibrateConfidence({
      memoriesUsed: [{ id: '1', title: 'A', content: 'a', relevance: 0.5 }],
      guardAction: 'post_redact',
      shouldEscalate: false,
      llmFallback: false,
      quotaExceeded: false,
      completionTokens: 50,
    });
    assert.ok(c.score < 0.5);
    /* interval 应较宽（默认 0.1，post_redact 扩到 0.2） */
    assert.ok(c.interval.upper - c.interval.lower >= 0.3);
  });

  it('pre_block → score 钉死在低位', () => {
    const c = calibrateConfidence({
      memoriesUsed: [],
      guardAction: 'pre_block',
      shouldEscalate: false,
      llmFallback: false,
      quotaExceeded: false,
      completionTokens: 0,
    });
    assert.equal(c.score, 0.2);
    assert.equal(c.level, 'low');
  });

  it('score 始终在 [0, 1]', () => {
    const c = calibrateConfidence({
      memoriesUsed: [],
      guardAction: 'llm_fallback',
      shouldEscalate: false,
      llmFallback: true,
      quotaExceeded: true,  /* 多重负面 */
      completionTokens: 0,
    });
    assert.ok(c.score >= 0);
    assert.ok(c.score <= 1);
    assert.ok(c.interval.lower >= 0);
    assert.ok(c.interval.upper <= 1);
  });
});
