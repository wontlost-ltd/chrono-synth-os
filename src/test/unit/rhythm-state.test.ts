/**
 * 单元测试：感知节律派生（rhythm-state.ts）——纯确定性 environment → 节律提示。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRhythmState } from '../../perception/environment/rhythm-state.js';
import type { EnvironmentState, ChannelState, SoundLevel, MotionLevel } from '../../perception/environment/environment-signal.js';

function sound(level: SoundLevel, confidence = 1): ChannelState<SoundLevel> {
  return { channel: 'sound', level, average: 0, peak: 0, trough: 0, confidence, sampleCount: 10 };
}
function motion(level: MotionLevel, confidence = 1): ChannelState<MotionLevel> {
  return { channel: 'motion', level, average: 0, peak: 0, trough: 0, confidence, sampleCount: 10 };
}
function env(partial: Partial<EnvironmentState>): EnvironmentState {
  return { windowStart: 0, windowEnd: 1000, ...partial };
}

describe('deriveRhythmState', () => {
  it('吵闹+活跃 → 高能量 lively', () => {
    const r = deriveRhythmState(env({ sound: sound('noisy'), motion: motion('active') }));
    assert.equal(r.energy, 1);
    assert.equal(r.tempo, 'lively');
    assert.equal(r.confidence, 1);
  });

  it('安静+静止 → 低能量 calm', () => {
    const r = deriveRhythmState(env({ sound: sound('silent'), motion: motion('still') }));
    assert.equal(r.energy, 0);
    assert.equal(r.tempo, 'calm');
  });

  it('中等声 → steady', () => {
    const r = deriveRhythmState(env({ sound: sound('moderate') }));
    assert.equal(r.tempo, 'steady');
    assert.equal(r.dominantChannel, 'sound');
  });

  it('置信度加权：高置信噪声主导，低置信静止拉不下来', () => {
    /* sound=noisy(energy 1, conf 1) + motion=still(energy 0, conf 0.1)
     * 加权 energy = (1*1 + 0*0.1)/(1.1) ≈ 0.909 → lively。 */
    const r = deriveRhythmState(env({ sound: sound('noisy', 1), motion: motion('still', 0.1) }));
    assert.ok(r.energy > 0.85);
    assert.equal(r.tempo, 'lively');
    assert.equal(r.dominantChannel, 'sound');
  });

  it('两通道都缺 → 中性 steady、confidence 0（不用 0 能量装平静）', () => {
    const r = deriveRhythmState(env({ light: { channel: 'light', level: 'dim', average: 0, peak: 0, trough: 0, confidence: 1, sampleCount: 5 } }));
    assert.equal(r.tempo, 'steady');
    assert.equal(r.confidence, 0);
    assert.equal(r.dominantChannel, null);
    assert.equal(r.energy, 0.5, '中性能量，不是 0');
  });

  it('总置信为 0（声/动都在但置信 0）→ 中性', () => {
    const r = deriveRhythmState(env({ sound: sound('noisy', 0), motion: motion('active', 0) }));
    assert.equal(r.tempo, 'steady');
    assert.equal(r.confidence, 0);
  });

  it('低置信不改 tempo（tempo 跟随 energy）但如实报 confidence，由 consumer 权衡', () => {
    /* sound=noisy 但置信仅 0.2：energy 仍高、tempo 仍 lively（energy 是可靠信号），confidence=0.2
     * 如实报出——consumer 自行决定要不要采信。不把低置信误盖成 steady（否则真正安静环境永到不了 calm）。 */
    const r = deriveRhythmState(env({ sound: sound('noisy', 0.2) }));
    assert.ok(r.energy > 0.9, 'energy 按声级算');
    assert.equal(r.tempo, 'lively', 'tempo 跟随 energy，不被低置信改写');
    assert.ok(Math.abs(r.confidence - 0.2) < 1e-9, 'confidence 如实报 0.2');
  });

  it('energy 与 tempo 始终在合法范围', () => {
    const r = deriveRhythmState(env({ sound: sound('quiet'), motion: motion('slight') }));
    assert.ok(r.energy >= 0 && r.energy <= 1);
    assert.ok(['calm', 'steady', 'lively'].includes(r.tempo));
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  });
});
