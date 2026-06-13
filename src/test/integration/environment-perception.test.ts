/**
 * 确定性环境感知旁路（ADR-0052 Edge-P1）：低维传感器信号 → 环境状态 → 事实记忆，零 LLM/零硬件。
 *
 * 证明 Edge/机器人端侧自治的核心论点：人格能在端侧**无云、无 LLM、确定性**地感知环境并沉淀记忆。
 *   - 阈值分级正确（光/声/运动）；
 *   - 去抖滞回：阈值边界的抖动不翻转状态，显著变化立即切换；
 *   - 同输入 → 同输出（golden 确定性，为未来 WASM/MCU 回放打基础）；
 *   - 状态变化 → append 事实记忆（第一人称），无变化 → 不记；
 *   - 绝不自动改身份核（value/narrative 权重不变）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import {
  EnvironmentSignalExtractor, EnvironmentObserver,
  type EnvironmentSample,
} from '../../perception/environment/index.js';

/** 造一窗某通道的样本（等间隔时间戳）。 */
function window(channel: EnvironmentSample['channel'], values: number[], t0 = 1000, step = 1000): EnvironmentSample[] {
  return values.map((value, i) => ({ channel, value, at: t0 + i * step }));
}

describe('确定性环境信号提取（ADR-0052）', () => {
  it('光强阈值分级：dark/dim/normal/bright', () => {
    const ex = new EnvironmentSignalExtractor();
    assert.equal(ex.extract(window('light', [2, 3, 4])).light?.level, 'dark');
    ex.reset();
    assert.equal(ex.extract(window('light', [20, 30, 25])).light?.level, 'dim');
    ex.reset();
    assert.equal(ex.extract(window('light', [100, 150, 120])).light?.level, 'normal');
    ex.reset();
    assert.equal(ex.extract(window('light', [500, 600, 550])).light?.level, 'bright');
  });

  it('声压阈值分级：silent/quiet/moderate/noisy', () => {
    const ex = new EnvironmentSignalExtractor();
    assert.equal(ex.extract(window('sound', [0.01, 0.02])).sound?.level, 'silent');
    ex.reset();
    assert.equal(ex.extract(window('sound', [0.1, 0.15])).sound?.level, 'quiet');
    ex.reset();
    assert.equal(ex.extract(window('sound', [0.3, 0.4])).sound?.level, 'moderate');
    ex.reset();
    assert.equal(ex.extract(window('sound', [0.7, 0.8])).sound?.level, 'noisy');
  });

  it('聚合数值正确：average/peak/trough/sampleCount', () => {
    const ex = new EnvironmentSignalExtractor();
    const cs = ex.extract(window('light', [10, 20, 30])).light!;
    assert.equal(cs.average, 20);
    assert.equal(cs.peak, 30);
    assert.equal(cs.trough, 10);
    assert.equal(cs.sampleCount, 3);
  });

  it('去抖滞回：阈值边界的抖动不翻转状态', () => {
    const ex = new EnvironmentSignalExtractor();
    /* light dim/normal 阈值=50，滞回带=±5。先稳定在 normal。 */
    assert.equal(ex.extract(window('light', [100, 120, 110])).light?.level, 'normal');
    /* 均值 48（落在 [45,55] 滞回带内）→ 候选 dim 但与 normal 相邻 → 保持 normal（不抖）。 */
    assert.equal(ex.extract(window('light', [48, 48, 48])).light?.level, 'normal');
    /* 均值 30（远低于阈值，出滞回带）→ 切到 dim。 */
    assert.equal(ex.extract(window('light', [30, 30, 30])).light?.level, 'dim');
  });

  it('显著跨档变化立即切换（不被滞回抑制）', () => {
    const ex = new EnvironmentSignalExtractor();
    assert.equal(ex.extract(window('light', [500, 500])).light?.level, 'bright');
    /* bright→dark 跨多档 → 立即切，不滞回。 */
    assert.equal(ex.extract(window('light', [2, 2])).light?.level, 'dark');
  });

  it('确定性：同输入 → 同输出（单窗 golden）', () => {
    const samples = [
      ...window('light', [100, 48, 30, 200], 1000),
      ...window('sound', [0.01, 0.3, 0.05], 1000),
    ];
    const run = () => {
      const ex = new EnvironmentSignalExtractor();
      return JSON.stringify(ex.extract(samples));
    };
    assert.equal(run(), run(), '同输入必须同输出');
  });

  it('确定性：逐窗序列 replay（含滞回跨窗状态）从同初始态产出相同 level 序列', () => {
    /* 多窗序列，跨阈值含滞回：normal → 滞回带保持 → dim → bright。 */
    const sequence = [
      window('light', [100, 120], 1000),   // normal
      window('light', [48, 48], 3000),     // 滞回带 → 保持 normal
      window('light', [30, 30], 5000),     // 出带 → dim
      window('light', [500, 500], 7000),   // 跨档 → bright
    ];
    const replay = () => {
      const ex = new EnvironmentSignalExtractor();
      return sequence.map((w) => ex.extract(w).light!.level);
    };
    const a = replay();
    const b = replay();
    assert.deepEqual(a, b, '同初始态 + 同窗序列 → 同 level 序列');
    assert.deepEqual(a, ['normal', 'normal', 'dim', 'bright'], '滞回跨窗行为符合预期');
  });

  it('置信度：样本足且波动小 → 高；波动大 → 低', () => {
    const ex = new EnvironmentSignalExtractor();
    const stable = ex.extract(window('light', [100, 101, 100, 102, 100, 101, 100, 101])).light!;
    ex.reset();
    const volatile = ex.extract(window('light', [10, 500, 10, 500])).light!;
    assert.ok(stable.confidence > volatile.confidence, '稳定窗口置信度应更高');
  });

  it('畸形读数（NaN/Inf）被丢弃，不污染聚合', () => {
    const ex = new EnvironmentSignalExtractor();
    const cs = ex.extract([
      { channel: 'light', value: 100, at: 1000 },
      { channel: 'light', value: NaN, at: 2000 },
      { channel: 'light', value: Infinity, at: 3000 },
      { channel: 'light', value: 120, at: 4000 },
    ]).light!;
    assert.equal(cs.sampleCount, 2, '畸形读数被丢弃');
    assert.equal(cs.average, 110);
  });

  it('畸形时间戳（NaN/Inf at）不污染 windowStart/End', () => {
    const ex = new EnvironmentSignalExtractor();
    const state = ex.extract([
      { channel: 'light', value: 100, at: 1000 },
      { channel: 'light', value: 110, at: NaN },
      { channel: 'light', value: 120, at: 5000 },
    ]);
    assert.equal(state.windowStart, 1000, 'windowStart 只取 finite at');
    assert.equal(state.windowEnd, 5000, 'windowEnd 只取 finite at');
    assert.ok(Number.isFinite(state.windowStart) && Number.isFinite(state.windowEnd));
  });

  it('空窗 / 单样本窗边界安全', () => {
    const ex = new EnvironmentSignalExtractor();
    const empty = ex.extract([]);
    assert.equal(empty.light, undefined);
    assert.equal(empty.windowStart, 0);
    const single = ex.extract(window('motion', [0.5]));
    assert.equal(single.motion?.level, 'active');
    assert.equal(single.motion?.sampleCount, 1);
  });
});

describe('环境观察沉淀为事实记忆（ADR-0052）', () => {
  let os: ChronoSynthOS;
  beforeEach(() => { os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() }); os.start(); });
  afterEach(() => os.close());

  it('状态变化 → append 第一人称事实记忆；无变化 → 不记', () => {
    const ex = new EnvironmentSignalExtractor();
    const obs = new EnvironmentObserver(os.core.memories, new SilentLogger());
    const before = os.core.memories.getMemoryCount();

    /* 首次观察 normal → 记一条基线。 */
    const r1 = obs.observe(ex.extract(window('light', [100, 120])));
    assert.equal(r1.memoryIds.length, 1, '首次观察记基线');
    const node = os.core.memories.getMemory(r1.memoryIds[0]);
    assert.ok(node && node.content.includes('我注意到'), '应是人格第一人称');

    /* 再观察仍 normal → 不记。 */
    const r2 = obs.observe(ex.extract(window('light', [110, 130])));
    assert.equal(r2.memoryIds.length, 0, '无变化不记');

    /* 变到 dark → 记一条变化。 */
    const r3 = obs.observe(ex.extract(window('light', [2, 3])));
    assert.equal(r3.memoryIds.length, 1, '状态变化记一条');
    assert.ok(os.core.memories.getMemory(r3.memoryIds[0])!.content.includes('变成'), '应记变化');

    assert.equal(os.core.memories.getMemoryCount(), before + 2, '共记 2 条（基线 + 1 次变化）');
  });

  it('环境感知绝不自动改身份核（value 权重不变）', () => {
    const v = os.core.addValue('专注', 0.5);
    const ex = new EnvironmentSignalExtractor();
    const obs = new EnvironmentObserver(os.core.memories, new SilentLogger());
    /* 一连串环境变化。 */
    obs.observe(ex.extract(window('light', [500])));
    obs.observe(ex.extract(window('light', [2])));
    obs.observe(ex.extract(window('sound', [0.8])));
    assert.equal(os.core.values.getAll().get(v.id)!.weight, 0.5, '环境感知绝不改 value 权重');
  });
});
