import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateMood, extractEmotionSignal, moodLabel, DEFAULT_MOOD,
} from '../../conversation/mood.js';

/* ADR-0056 情绪/心情——确定性漂移、可复现、零-LLM。 */
describe('updateMood', () => {
  it('正向事件 → valence 上扬（有界）', () => {
    const m = updateMood(DEFAULT_MOOD, { valenceSignal: 1 }, 0);
    assert.ok(m.valence > DEFAULT_MOOD.valence && m.valence <= 0.16, `valence ${m.valence} 小步上扬`);
  });

  it('负向事件 → valence 下沉（有界）', () => {
    const m = updateMood(DEFAULT_MOOD, { valenceSignal: -1 }, 0);
    assert.ok(m.valence < DEFAULT_MOOD.valence && m.valence >= -0.16);
  });

  it('连续正向 → 累积到开心，但单轮有界（不会一句话狂喜）', () => {
    let m = DEFAULT_MOOD;
    for (let i = 0; i < 8; i++) m = updateMood(m, { valenceSignal: 1 }, 0);
    assert.ok(m.valence >= 0.35, `累积后 ${m.valence} 应到 positive 区`);
  });

  it('时间回归：长时间无事件 → 向基线回归', () => {
    /* 先到高 valence，再回归。 */
    let m = DEFAULT_MOOD;
    for (let i = 0; i < 8; i++) m = updateMood(m, { valenceSignal: 1 }, 0);
    const high = m.valence;
    /* 12h 后（2 个半衰期）valence 大幅回落。 */
    m = updateMood(m, { valenceSignal: 0 }, 12 * 60 * 60 * 1000);
    assert.ok(m.valence < high * 0.5, `回归后 ${m.valence} < ${high} 的一半`);
  });

  it('始终在范围内（valence∈[-1,1], arousal∈[0,1]）', () => {
    let m = DEFAULT_MOOD;
    for (const s of [1, 1, 1, -1, -1, 1, -1, 1, 1, 1]) {
      m = updateMood(m, { valenceSignal: s }, 0);
      assert.ok(m.valence >= -1 && m.valence <= 1 && m.arousal >= 0 && m.arousal <= 1);
    }
  });

  it('确定性：相同 (current, event, elapsed) → 相同结果', () => {
    const a = updateMood({ valence: 0.2, arousal: 0.4 }, { valenceSignal: 0.5 }, 3600_000);
    const b = updateMood({ valence: 0.2, arousal: 0.4 }, { valenceSignal: 0.5 }, 3600_000);
    assert.deepEqual(a, b);
  });

  it('防御 NaN/负 elapsed → 不崩、结果有限', () => {
    const m = updateMood(DEFAULT_MOOD, { valenceSignal: NaN }, -100);
    assert.ok(Number.isFinite(m.valence) && Number.isFinite(m.arousal));
  });
});

describe('extractEmotionSignal', () => {
  it('中文正/负/中性', () => {
    assert.equal(extractEmotionSignal('我今天好开心', 'zh-CN'), 1);
    assert.equal(extractEmotionSignal('我很难过很累', 'zh-CN'), -1);
    assert.equal(extractEmotionSignal('今天几号', 'zh-CN'), 0);
  });
  it('英文正/负/中性', () => {
    assert.equal(extractEmotionSignal('I am so happy, thanks', 'en'), 1);
    assert.equal(extractEmotionSignal('I feel sad and tired', 'en'), -1);
    assert.equal(extractEmotionSignal('what time is it', 'en'), 0);
  });
  it('混合正负 → 归一', () => {
    const s = extractEmotionSignal('开心又有点难过', 'zh-CN');
    assert.ok(s >= -1 && s <= 1);
  });

  it('否定感知（Codex 复审）：「不开心/不喜欢」→ 负，「不讨厌」→ 正', () => {
    assert.ok(extractEmotionSignal('我不开心', 'zh-CN') < 0, '不开心→负');
    assert.ok(extractEmotionSignal('我不喜欢这个', 'zh-CN') < 0, '不喜欢→负');
    assert.ok(extractEmotionSignal('我不讨厌你', 'zh-CN') > 0, '不讨厌→正');
    assert.ok(extractEmotionSignal('this is not good', 'en') < 0, 'not good→负');
    assert.ok(extractEmotionSignal('I do not hate you', 'en') > 0, 'do not hate→正');
  });

  it('英文词边界（Codex 复审）：dislike≠like，goodwill/gladstone 不误命中', () => {
    assert.ok(extractEmotionSignal('I dislike it', 'en') < 0, 'dislike 整词→负（非 like 子串）');
    assert.equal(extractEmotionSignal('goodwill ambassador', 'en'), 0, 'goodwill 不含独立 good');
    assert.equal(extractEmotionSignal('gladstone street', 'en'), 0, 'gladstone 不含独立 glad');
  });
});

describe('moodLabel', () => {
  it('四象限 + 中性', () => {
    assert.equal(moodLabel({ valence: 0.5, arousal: 0.3 }), 'positive');
    assert.equal(moodLabel({ valence: 0.5, arousal: 0.8 }), 'excited');
    assert.equal(moodLabel({ valence: -0.5, arousal: 0.5 }), 'negative');
    assert.equal(moodLabel({ valence: 0, arousal: 0.1 }), 'calm');
    assert.equal(moodLabel(DEFAULT_MOOD), 'neutral');
  });
  it('零回归：默认中性心情 → neutral（→ moodPrefix 空 → 回应无前缀）', () => {
    assert.equal(moodLabel(DEFAULT_MOOD), 'neutral');
    assert.equal(moodLabel({ valence: 0.1, arousal: 0.4 }), 'neutral', '小幅波动仍中性');
  });
});
