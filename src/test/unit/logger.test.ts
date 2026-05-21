/**
 * ConsoleLogger 单元测试 — JSON / text 输出与 OTel trace 上下文注入
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P1-C
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConsoleLogger } from '../../utils/logger.js';

/**
 * 替换 console.*，捕获 log 行用于断言；返回 restore 函数。
 * 不使用 mock 库以保持测试零外部依赖。
 */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const sink = (..._args: unknown[]): void => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const joined = (_args as any[]).map(a => (typeof a === 'string' ? a : '')).join(' ').trim();
    lines.push(joined);
  };
  console.debug = sink as never;
  console.info = sink as never;
  console.warn = sink as never;
  console.error = sink as never;
  return {
    lines,
    restore() {
      console.debug = original.debug;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

describe('ConsoleLogger — JSON 格式输出', () => {
  it('JSON 模式输出严格的单行 JSON', () => {
    const cap = captureConsole();
    try {
      const log = new ConsoleLogger('debug', 'json');
      log.info('layer-x', 'hello world', { tenant: 'a' });
      assert.equal(cap.lines.length, 1);
      const parsed = JSON.parse(cap.lines[0]) as Record<string, unknown>;
      assert.equal(parsed.level, 'info');
      assert.equal(parsed.layer, 'layer-x');
      assert.equal(parsed.message, 'hello world');
      assert.deepEqual(parsed.data, { tenant: 'a' });
      assert.equal(typeof parsed.timestamp, 'number');
    } finally {
      cap.restore();
    }
  });

  it('JSON 模式中无 OTel active span 时省略 trace_id', () => {
    const cap = captureConsole();
    try {
      const log = new ConsoleLogger('debug', 'json');
      log.warn('layer-y', 'something off');
      const parsed = JSON.parse(cap.lines[0]) as Record<string, unknown>;
      assert.equal('trace_id' in parsed, false);
      assert.equal('span_id' in parsed, false);
    } finally {
      cap.restore();
    }
  });

  it('低于 minLevel 的事件被丢弃', () => {
    const cap = captureConsole();
    try {
      const log = new ConsoleLogger('warn', 'json');
      log.debug('layer-z', 'noisy');
      log.info('layer-z', 'still noisy');
      log.warn('layer-z', 'this one survives');
      assert.equal(cap.lines.length, 1);
      const parsed = JSON.parse(cap.lines[0]) as Record<string, unknown>;
      assert.equal(parsed.level, 'warn');
    } finally {
      cap.restore();
    }
  });
});

describe('ConsoleLogger — text 格式输出', () => {
  it('text 模式不发出 JSON', () => {
    const cap = captureConsole();
    try {
      const log = new ConsoleLogger('debug', 'text');
      log.info('layer', 'plain message');
      assert.equal(cap.lines.length, 1);
      assert.equal(cap.lines[0].startsWith('{'), false);
      assert.ok(cap.lines[0].includes('plain message'));
    } finally {
      cap.restore();
    }
  });
});
