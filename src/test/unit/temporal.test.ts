import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { timeGap, daysSinceFirstMet, timeOfDayUtc } from '../../conversation/temporal.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/* ADR-0056 时间感知——纯确定性，相同 (lastSeen, firstMet, now) → 相同结果。 */
describe('timeGap（久别档）', () => {
  it('lastSeen 为 null → first（第一次见面）', () => {
    assert.equal(timeGap(null, 1_000_000), 'first');
  });

  it('非有限值 → first（容错）', () => {
    assert.equal(timeGap(Number.NaN, 1_000_000), 'first');
    assert.equal(timeGap(Number.POSITIVE_INFINITY, 1_000_000), 'first');
  });

  it('> 3 天 → longGap（好久不见）', () => {
    const now = 100 * DAY;
    assert.equal(timeGap(now - 4 * DAY, now), 'longGap');
    assert.equal(timeGap(now - 30 * DAY, now), 'longGap');
  });

  it('> 12 小时且 ≤ 3 天 → dayGap（隔段时间又见）', () => {
    const now = 100 * DAY;
    assert.equal(timeGap(now - 13 * HOUR, now), 'dayGap');
    assert.equal(timeGap(now - 2 * DAY, now), 'dayGap');
  });

  it('≤ 12 小时 → sameSession（同段对话，不重复打招呼）', () => {
    const now = 100 * DAY;
    assert.equal(timeGap(now - 1000, now), 'sameSession');
    assert.equal(timeGap(now - 11 * HOUR, now), 'sameSession');
    assert.equal(timeGap(now, now), 'sameSession');
  });

  it('边界精确：恰好 3 天 → 仍 dayGap（用 > 不用 ≥）', () => {
    const now = 100 * DAY;
    assert.equal(timeGap(now - 3 * DAY, now), 'dayGap', '恰好 3 天不算 longGap');
    assert.equal(timeGap(now - (3 * DAY + 1), now), 'longGap', '刚过 3 天算 longGap');
  });

  it('边界精确：恰好 12 小时 → 仍 sameSession', () => {
    const now = 100 * DAY;
    assert.equal(timeGap(now - 12 * HOUR, now), 'sameSession', '恰好 12 小时不算 dayGap');
    assert.equal(timeGap(now - (12 * HOUR + 1), now), 'dayGap', '刚过 12 小时算 dayGap');
  });

  it('时钟倒退（lastSeen 在 now 之后）→ elapsed 钳为 0 → sameSession', () => {
    const now = 100 * DAY;
    assert.equal(timeGap(now + 5 * DAY, now), 'sameSession', '负间隔不当 longGap');
  });

  it('now 非有限（容错）→ sameSession，不冒充久别重逢', () => {
    assert.equal(timeGap(1000, Number.NaN), 'sameSession');
    assert.equal(timeGap(1000, Number.POSITIVE_INFINITY), 'sameSession');
  });

  it('确定性：相同输入相同输出', () => {
    const now = 100 * DAY;
    assert.equal(timeGap(now - 4 * DAY, now), timeGap(now - 4 * DAY, now));
  });
});

describe('daysSinceFirstMet（认识多少天）', () => {
  it('null → 0', () => {
    assert.equal(daysSinceFirstMet(null, 100 * DAY), 0);
  });

  it('向下取整：认识 4.9 天 → 4', () => {
    const now = 100 * DAY;
    assert.equal(daysSinceFirstMet(now - (4 * DAY + 20 * HOUR), now), 4);
  });

  it('同一天内 → 0', () => {
    const now = 100 * DAY;
    assert.equal(daysSinceFirstMet(now - 3 * HOUR, now), 0);
  });

  it('未来 first_met（时钟倒退）→ 0（不返回负数）', () => {
    const now = 100 * DAY;
    assert.equal(daysSinceFirstMet(now + 5 * DAY, now), 0);
  });

  it('非有限值 → 0', () => {
    assert.equal(daysSinceFirstMet(Number.NaN, 100 * DAY), 0);
  });
});

describe('timeOfDayUtc（按 UTC 小时分时段）', () => {
  /** 构造一个 UTC 小时为 h 的时刻。 */
  function atUtcHour(h: number): number {
    return Date.UTC(2026, 5, 21, h, 30, 0);
  }
  it('0-5 点 → lateNight', () => {
    assert.equal(timeOfDayUtc(atUtcHour(0)), 'lateNight');
    assert.equal(timeOfDayUtc(atUtcHour(4)), 'lateNight');
  });
  it('5-11 点 → morning', () => {
    assert.equal(timeOfDayUtc(atUtcHour(5)), 'morning');
    assert.equal(timeOfDayUtc(atUtcHour(10)), 'morning');
  });
  it('11-17 点 → afternoon', () => {
    assert.equal(timeOfDayUtc(atUtcHour(11)), 'afternoon');
    assert.equal(timeOfDayUtc(atUtcHour(16)), 'afternoon');
  });
  it('17-22 点 → evening', () => {
    assert.equal(timeOfDayUtc(atUtcHour(17)), 'evening');
    assert.equal(timeOfDayUtc(atUtcHour(21)), 'evening');
  });
  it('22-24 点 → lateNight', () => {
    assert.equal(timeOfDayUtc(atUtcHour(22)), 'lateNight');
    assert.equal(timeOfDayUtc(atUtcHour(23)), 'lateNight');
  });
  it('非有限值 → day（容错）', () => {
    assert.equal(timeOfDayUtc(Number.NaN), 'day');
  });
});
