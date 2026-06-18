/**
 * 单元测试：SseEventCounter（companion-web nudge-created SSE 流式行解析）。
 * 覆盖：单事件 / 多事件 / 跨 chunk 切分 / CRLF / 注释与 id 行忽略 / flush 收尾。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseEventCounter } from '../src/useNudgeStream.ts';

test('单个完整事件（data + 空行）→ 1', () => {
  const c = new SseEventCounter();
  assert.equal(c.push('data: {"nudgeId":"a"}\n\n'), 1);
});

test('多个事件一次喂入 → 计全部', () => {
  const c = new SseEventCounter();
  assert.equal(c.push('data: x\n\ndata: y\n\ndata: z\n\n'), 3);
});

test('跨 chunk 切分：data 与空行分两次到达', () => {
  const c = new SseEventCounter();
  assert.equal(c.push('data: x'), 0, '只有 data 行未遇空行 → 事件未完成');
  assert.equal(c.push('\n\n'), 1, '空行到达 → 事件完成');
});

test('CRLF 换行同样解析', () => {
  const c = new SseEventCounter();
  assert.equal(c.push('data: x\r\n\r\n'), 1);
});

test('注释行(:)与 id 行被忽略，不算事件', () => {
  const c = new SseEventCounter();
  assert.equal(c.push(': heartbeat\n\n'), 0, '纯注释+空行不算事件');
  assert.equal(c.push('id: 5\ndata: x\n\n'), 1, 'id 行忽略但 data 行算事件');
});

test('flush 收尾未以空行结束的最后事件', () => {
  const c = new SseEventCounter();
  assert.equal(c.push('data: x'), 0);
  assert.equal(c.flush(), 1, 'flush 吐出残余事件');
  assert.equal(c.flush(), 0, '再 flush 无残余');
});

test('无 data 的空块 → 0', () => {
  const c = new SseEventCounter();
  assert.equal(c.push('\n\n\n'), 0);
  assert.equal(c.flush(), 0);
});
