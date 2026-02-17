import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateId, generatePrefixedId, TestClock, SilentLogger } from '../../utils/index.js';

describe('id-generator', () => {
  it('生成唯一 UUID', () => {
    const a = generateId();
    const b = generateId();
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f-]{36}$/);
  });

  it('生成带前缀的 ID', () => {
    const id = generatePrefixedId('test');
    assert.ok(id.startsWith('test_'));
  });
});

describe('TestClock', () => {
  it('返回初始时间', () => {
    const clock = new TestClock(1000);
    assert.equal(clock.now(), 1000);
  });

  it('advance 推进时间', () => {
    const clock = new TestClock(0);
    clock.advance(500);
    assert.equal(clock.now(), 500);
    clock.advance(300);
    assert.equal(clock.now(), 800);
  });

  it('set 设置绝对时间', () => {
    const clock = new TestClock(0);
    clock.set(9999);
    assert.equal(clock.now(), 9999);
  });
});

describe('SilentLogger', () => {
  it('记录日志条目', () => {
    const logger = new SilentLogger();
    logger.info('test', 'hello');
    logger.warn('test', 'warn msg');
    assert.equal(logger.entries.length, 2);
    assert.equal(logger.entries[0].level, 'info');
    assert.equal(logger.entries[0].message, 'hello');
    assert.equal(logger.entries[1].level, 'warn');
  });
});
