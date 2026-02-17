/**
 * 系统时钟抽象
 * 生产环境使用真实时间，测试中可注入固定时钟
 */

export interface Clock {
  now(): number;
}

/** 真实时钟 */
export const realClock: Clock = {
  now: () => Date.now(),
};

/** 可控测试时钟 */
export class TestClock implements Clock {
  private _current: number;

  constructor(start = 0) {
    this._current = start;
  }

  now(): number {
    return this._current;
  }

  advance(ms: number): void {
    this._current += ms;
  }

  set(ms: number): void {
    this._current = ms;
  }
}
