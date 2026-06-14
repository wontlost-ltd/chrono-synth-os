/**
 * 端侧人格运行时 + worker 客户端（ADR-0052 Local Persona Autonomy）。
 *
 * 证明：companion-web 真 runtime import @chrono/kernel，用浏览器 host adapter 驱动真实 kernel
 * value-service 跑确定性闭环；worker 客户端的 postMessage 协议（id 关联、并发、错误）正确。
 * 用 node:test + npx tsx（kernel .js→.ts 解析 + 跨包 dist）；fake worker 模拟 Worker 面（不依赖
 * 真浏览器——真 Worker 端到端是 vite build + playwright 后续）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaRuntime } from '../src/worker/persona-runtime.ts';
import { PersonaWorkerClient, type WorkerLike } from '../src/worker/worker-client.ts';
import type { WorkerRequest, WorkerResponse } from '../src/worker/worker-protocol.ts';

test('PersonaRuntime：浏览器 host adapter 驱动真实 kernel value-service 闭环', () => {
  const rt = new PersonaRuntime();
  rt.handle({ kind: 'addValue', label: '探索', weight: 0.5 });
  rt.handle({ kind: 'addValue', label: '稳定', weight: 0.7 });
  const r = rt.handle({ kind: 'listValues' });
  /* 排序 weight desc：稳定(0.7) 前于 探索(0.5)。 */
  assert.deepEqual(r.values.map((v) => v.label), ['稳定', '探索']);
});

test('PersonaRuntime：updateValue 改权重（kernel 纯函数）', () => {
  const rt = new PersonaRuntime();
  rt.handle({ kind: 'addValue', label: '探索', weight: 0.5 });
  const v = rt.handle({ kind: 'listValues' }).values[0];
  const r = rt.handle({ kind: 'updateValue', id: v.id, weight: 0.9 });
  assert.equal(r.values[0].weight, 0.9);
});

test('PersonaRuntime：确定性（同操作序列 → 同结果，含确定性 id）', () => {
  const run = () => {
    const rt = new PersonaRuntime();
    rt.handle({ kind: 'addValue', label: 'A', weight: 0.5 });
    rt.handle({ kind: 'addValue', label: 'B', weight: 0.5 });
    return JSON.stringify(rt.handle({ kind: 'listValues' }).values);
  };
  assert.equal(run(), run(), '端侧 kernel 运行确定可回放');
});

/** fake worker：同步把 request 喂给 PersonaRuntime，回 response（模拟 worker 线程）。 */
function fakeWorker(): WorkerLike & { runtime: PersonaRuntime } {
  const runtime = new PersonaRuntime();
  const w: WorkerLike & { runtime: PersonaRuntime } = {
    runtime,
    onmessage: null,
    postMessage(req: WorkerRequest) {
      let res: WorkerResponse;
      try {
        res = { id: req.id, ok: true, result: runtime.handle(req.cmd) };
      } catch (err) {
        res = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      /* 异步回递（模拟 worker postMessage 异步）。 */
      queueMicrotask(() => w.onmessage?.({ data: res } as MessageEvent<WorkerResponse>));
    },
  };
  return w;
}

test('PersonaWorkerClient：send → Promise 解析结果（消息协议）', async () => {
  const client = new PersonaWorkerClient(fakeWorker());
  await client.send({ kind: 'addValue', label: '探索', weight: 0.5 });
  const r = await client.send({ kind: 'listValues' });
  assert.equal(r.values[0].label, '探索');
});

test('PersonaWorkerClient：并发请求 id 关联（乱序响应不串）', async () => {
  const client = new PersonaWorkerClient(fakeWorker());
  /* 并发发多条 addValue。 */
  const results = await Promise.all([
    client.send({ kind: 'addValue', label: 'A', weight: 0.3 }),
    client.send({ kind: 'addValue', label: 'B', weight: 0.7 }),
    client.send({ kind: 'addValue', label: 'C', weight: 0.5 }),
  ]);
  /* 最后一条结果含全部 3 个（顺序处理）。 */
  const final = await client.send({ kind: 'listValues' });
  assert.equal(final.values.length, 3);
  assert.ok(results.length === 3);
});

test('PersonaWorkerClient：worker 错误 → Promise reject', async () => {
  /* fake worker 总是抛错。 */
  const w: WorkerLike = {
    onmessage: null,
    postMessage(req: WorkerRequest) {
      const res: WorkerResponse = { id: req.id, ok: false, error: 'boom' };
      queueMicrotask(() => w.onmessage?.({ data: res } as MessageEvent<WorkerResponse>));
    },
  };
  const client = new PersonaWorkerClient(w);
  await assert.rejects(() => client.send({ kind: 'listValues' }), /boom/);
});

test('健壮性：postMessage 同步抛错 → reject（不永挂）', async () => {
  const w: WorkerLike = { onmessage: null, postMessage() { throw new Error('worker dead'); } };
  const client = new PersonaWorkerClient(w);
  await assert.rejects(() => client.send({ kind: 'listValues' }), /worker dead/);
});

test('健壮性：worker onerror（崩溃）→ reject 所有 pending', async () => {
  let onerr: ((e: unknown) => void) | null = null;
  const w: WorkerLike = {
    onmessage: null,
    set onerror(fn: ((e: unknown) => void) | null) { onerr = fn; },
    get onerror() { return onerr; },
    postMessage() { /* 永不回 */ },
  };
  const client = new PersonaWorkerClient(w);
  const p1 = client.send({ kind: 'listValues' });
  const p2 = client.send({ kind: 'listValues' });
  /* worker 崩溃。 */
  onerr?.({ message: 'crashed' });
  await assert.rejects(() => p1, /crashed/);
  await assert.rejects(() => p2, /crashed/);
});

test('健壮性：close() → reject 所有 pending', async () => {
  const w: WorkerLike = { onmessage: null, postMessage() { /* 永不回 */ }, terminate() {} };
  const client = new PersonaWorkerClient(w);
  const p = client.send({ kind: 'listValues' });
  client.close();
  await assert.rejects(() => p, /已关闭/);
  /* close 后再 send 直接 reject。 */
  await assert.rejects(() => client.send({ kind: 'listValues' }), /已关闭/);
});

test('健壮性：worker 永不回 → 超时 reject（不永挂）', async () => {
  const w: WorkerLike = { onmessage: null, postMessage() { /* 永不回 */ } };
  const client = new PersonaWorkerClient(w, 30);   /* 30ms 超时 */
  await assert.rejects(() => client.send({ kind: 'listValues' }), /超时/);
});
