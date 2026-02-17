import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { MemoryPatternExtractor } from '../../core/memory-pattern-extractor.js';
import type { CoreValue, MemoryNode } from '../../types/core-self.js';

function makeValue(id: string, label: string, weight = 0.5): CoreValue {
  return { id, label, weight, timeDiscount: 0.5, emotionAmplifier: 1.0, updatedAt: 1000 };
}

function makeMemory(id: string, content: string, valence: number, salience: number, kind: 'semantic' | 'episodic' = 'semantic'): MemoryNode {
  return {
    id, kind, content, valence, salience,
    createdAt: 1000, lastAccessedAt: 1000,
    accessCount: 0, decayLambda: 0.0001, lastDecayedAt: 0, consolidatedFrom: null,
  };
}

describe('MemoryPatternExtractor', () => {
  const clock = new TestClock(1000);
  const logger = new SilentLogger();

  it('无 semantic 记忆返回空模式', () => {
    const extractor = new MemoryPatternExtractor(clock, logger);
    const memories = new Map([['m1', makeMemory('m1', '诚实是美德', 0.8, 0.9, 'episodic')]]);
    const values = new Map([['v1', makeValue('v1', '诚实')]]);
    const patterns = extractor.extractPatterns(memories, values);
    assert.equal(patterns.length, 0);
  });

  it('足够 semantic 记忆 + 强正面 valence 产生正 delta', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { minMemoryCount: 3 });
    const memories = new Map<string, MemoryNode>();
    for (let i = 0; i < 5; i++) {
      /* 使用空格分隔确保 "诚实" 是独立 token */
      memories.set(`m${i}`, makeMemory(`m${i}`, `诚实 经历 ${i}`, 0.8, 0.9));
    }
    const values = new Map([['v1', makeValue('v1', '诚实')]]);
    const patterns = extractor.extractPatterns(memories, values);
    assert.ok(patterns.length > 0, '应提取到模式');
    assert.ok(patterns[0].suggestedWeightDelta > 0, `delta=${patterns[0].suggestedWeightDelta}`);
    assert.equal(patterns[0].relatedValueId, 'v1');
    assert.equal(patterns[0].relatedValueLabel, '诚实');
  });

  it('足够 semantic 记忆 + 强负面 valence 产生负 delta', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { minMemoryCount: 3 });
    const memories = new Map<string, MemoryNode>();
    for (let i = 0; i < 5; i++) {
      memories.set(`m${i}`, makeMemory(`m${i}`, `诚实 痛苦 ${i}`, -0.8, 0.9));
    }
    const values = new Map([['v1', makeValue('v1', '诚实')]]);
    const patterns = extractor.extractPatterns(memories, values);
    assert.ok(patterns.length > 0);
    assert.ok(patterns[0].suggestedWeightDelta < 0, `delta=${patterns[0].suggestedWeightDelta}`);
  });

  it('memoryCount 不足时不产生模式', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { minMemoryCount: 10 });
    const memories = new Map<string, MemoryNode>();
    for (let i = 0; i < 5; i++) {
      memories.set(`m${i}`, makeMemory(`m${i}`, `诚实 经历 ${i}`, 0.8, 0.9));
    }
    const values = new Map([['v1', makeValue('v1', '诚实')]]);
    const patterns = extractor.extractPatterns(memories, values);
    assert.equal(patterns.length, 0);
  });

  it('valence 太弱时不产生模式', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { minMemoryCount: 3, valenceThreshold: 0.5 });
    const memories = new Map<string, MemoryNode>();
    for (let i = 0; i < 5; i++) {
      memories.set(`m${i}`, makeMemory(`m${i}`, `诚实 日常 ${i}`, 0.2, 0.9));
    }
    const values = new Map([['v1', makeValue('v1', '诚实')]]);
    const patterns = extractor.extractPatterns(memories, values);
    assert.equal(patterns.length, 0);
  });

  it('delta 不超过 maxDriftDelta', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, {
      minMemoryCount: 3, maxDriftDelta: 0.05,
    });
    const memories = new Map<string, MemoryNode>();
    for (let i = 0; i < 10; i++) {
      memories.set(`m${i}`, makeMemory(`m${i}`, `诚实 启发 ${i}`, 1.0, 1.0));
    }
    const values = new Map([['v1', makeValue('v1', '诚实')]]);
    const patterns = extractor.extractPatterns(memories, values);
    assert.ok(patterns.length > 0);
    assert.ok(Math.abs(patterns[0].suggestedWeightDelta) <= 0.05 + 1e-9);
  });

  it('patternsToProposals 生成正确提案', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { minMemoryCount: 3 });
    const memories = new Map<string, MemoryNode>();
    for (let i = 0; i < 5; i++) {
      memories.set(`m${i}`, makeMemory(`m${i}`, `诚实 故事 ${i}`, 0.8, 0.9));
    }
    const values = new Map([['v1', makeValue('v1', '诚实', 0.5)]]);
    const patterns = extractor.extractPatterns(memories, values);
    const proposals = extractor.patternsToProposals(patterns, values);

    assert.ok(proposals.length > 0);
    assert.equal(proposals[0].valueId, 'v1');
    assert.equal(proposals[0].currentWeight, 0.5);
    assert.ok(proposals[0].suggestedWeight > 0.5);
    assert.ok(proposals[0].delta > 0);
    assert.ok(proposals[0].reason.includes('semantic'));
  });

  it('patternsToProposals 跳过已处于边界的值', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { minMemoryCount: 3 });
    const memories = new Map<string, MemoryNode>();
    for (let i = 0; i < 5; i++) {
      memories.set(`m${i}`, makeMemory(`m${i}`, `诚实 最高 ${i}`, 0.8, 0.9));
    }
    const values = new Map([['v1', makeValue('v1', '诚实', 1.0)]]);
    const patterns = extractor.extractPatterns(memories, values);
    const proposals = extractor.patternsToProposals(patterns, values);
    /* weight 已经 1.0，正 delta 无法再增加 */
    assert.equal(proposals.length, 0);
  });

  it('多个价值独立提取模式', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { minMemoryCount: 3 });
    const memories = new Map<string, MemoryNode>();
    for (let i = 0; i < 5; i++) {
      memories.set(`m_h${i}`, makeMemory(`m_h${i}`, `诚实 经历 ${i}`, 0.7, 0.8));
      memories.set(`m_c${i}`, makeMemory(`m_c${i}`, `勇气 故事 ${i}`, -0.6, 0.7));
    }
    const values = new Map([
      ['v1', makeValue('v1', '诚实', 0.5)],
      ['v2', makeValue('v2', '勇气', 0.5)],
    ]);
    const patterns = extractor.extractPatterns(memories, values);
    assert.equal(patterns.length, 2);
    const honesty = patterns.find(p => p.relatedValueId === 'v1');
    const courage = patterns.find(p => p.relatedValueId === 'v2');
    assert.ok(honesty);
    assert.ok(courage);
    assert.ok(honesty!.suggestedWeightDelta > 0);
    assert.ok(courage!.suggestedWeightDelta < 0);
  });

  it('无 logger 时正常工作', () => {
    const extractor = new MemoryPatternExtractor(clock);
    const memories = new Map<string, MemoryNode>();
    for (let i = 0; i < 5; i++) {
      memories.set(`m${i}`, makeMemory(`m${i}`, `诚实 记忆 ${i}`, 0.8, 0.9));
    }
    const values = new Map([['v1', makeValue('v1', '诚实')]]);
    const patterns = extractor.extractPatterns(memories, values);
    assert.ok(patterns.length > 0);
  });

  it('pattern id 包含 value id 和时间戳', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { minMemoryCount: 3 });
    const memories = new Map<string, MemoryNode>();
    for (let i = 0; i < 5; i++) {
      memories.set(`m${i}`, makeMemory(`m${i}`, `诚实 思考 ${i}`, 0.8, 0.9));
    }
    const values = new Map([['v1', makeValue('v1', '诚实')]]);
    const patterns = extractor.extractPatterns(memories, values);
    assert.ok(patterns[0].id.includes('v1'));
    assert.ok(patterns[0].id.includes('1000'));
  });

  it('extractEmotionalEvents 检测强情绪 episodic 记忆', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { emotionalEventThreshold: 0.5 });
    /* 高情绪 episodic 记忆 */
    const memories = new Map<string, MemoryNode>([
      ['m1', makeMemory('m1', '诚实 巨大冲击', 0.9, 0.9, 'episodic')],
    ]);
    const values = new Map([['v1', makeValue('v1', '诚实', 0.5)]]);
    const proposals = extractor.extractEmotionalEvents(memories, values);
    assert.ok(proposals.length > 0);
    assert.equal(proposals[0].valueId, 'v1');
    assert.ok(proposals[0].delta > 0);
    assert.ok(proposals[0].reason.includes('强情绪事件'));
  });

  it('extractEmotionalEvents 忽略低情绪记忆', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { emotionalEventThreshold: 0.7 });
    const memories = new Map<string, MemoryNode>([
      ['m1', makeMemory('m1', '诚实 日常', 0.3, 0.5, 'episodic')],
    ]);
    const values = new Map([['v1', makeValue('v1', '诚实', 0.5)]]);
    const proposals = extractor.extractEmotionalEvents(memories, values);
    assert.equal(proposals.length, 0);
  });

  it('extractEmotionalEvents 忽略 semantic 记忆', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { emotionalEventThreshold: 0.5 });
    const memories = new Map<string, MemoryNode>([
      ['m1', makeMemory('m1', '诚实 大事件', 0.9, 0.9, 'semantic')],
    ]);
    const values = new Map([['v1', makeValue('v1', '诚实', 0.5)]]);
    const proposals = extractor.extractEmotionalEvents(memories, values);
    assert.equal(proposals.length, 0);
  });

  it('extractEmotionalEvents 负面情绪产生负 delta', () => {
    const extractor = new MemoryPatternExtractor(clock, logger, { emotionalEventThreshold: 0.5 });
    const memories = new Map<string, MemoryNode>([
      ['m1', makeMemory('m1', '诚实 痛苦', -0.9, 0.9, 'episodic')],
    ]);
    const values = new Map([['v1', makeValue('v1', '诚实', 0.5)]]);
    const proposals = extractor.extractEmotionalEvents(memories, values);
    assert.ok(proposals.length > 0);
    assert.ok(proposals[0].delta < 0);
  });
});
