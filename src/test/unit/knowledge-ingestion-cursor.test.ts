/**
 * 知识摄入的游标推进语义（审计 Warning B4-12）。
 *
 * 该 service 此前**零测试覆盖**——这正是缺陷长期存活的原因。
 *
 * 关键链路：记忆先写入 → 再推进游标。游标推进失败时记忆已经落库，若把该失败
 * 混进通用 warn 吞掉，调用方会看到「摄入成功」，而下一轮会重新拉同一批内容
 * 重复灌进记忆图（fingerprint 去重只是**单次运行内**的内存 Set，跨运行不设防）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeIngestionService } from '../../knowledge/knowledge-ingestion-service.js';
import type { KnowledgeSourceRegistry } from '../../knowledge/knowledge-source-registry.js';
import type { KnowledgeSourceStore } from '../../storage/knowledge-source-store.js';
import type { CognitiveMemoryGraph } from '../../core/memory-graph.js';
import type { EventBus } from '../../events/event-bus.js';
import type { Logger } from '../../utils/logger.js';

const TENANT = 'tenant_a';

interface Harness {
  service: KnowledgeIngestionService;
  addedMemories: string[];
  updateStateCalls: number;
  /** 捕获写入的 stateJson —— 断言游标**推进到了哪里**，而不只是「推进过」。 */
  writtenStates: string[];
  errorLogs: string[];
  /** 捕获 knowledge:ingested 事件——不捕获就无法发现「事件被吞」这类回退。 */
  emitted: Array<{ sourceId: string }>;
}

/** 造一个只含所需能力的最小 service；updateStateFails 控制游标推进是否抛错。 */
function makeHarness(opts: {
  updateStateFails?: boolean;
  items?: Array<{ content: string; fingerprint?: string; publishedAt?: number }>;
  /** 单轮上限；小于 items 长度即触发截断路径（审计 #423）。 */
  maxItemsPerRun?: number;
  /** source 的初始 stateJson。 */
  stateJson?: string | null;
} = {}): Harness {
  const addedMemories: string[] = [];
  const errorLogs: string[] = [];
  const writtenStates: string[] = [];
  let updateStateCalls = 0;
  let memSeq = 0;

  const items = opts.items ?? [{ content: '条目一' }, { content: '条目二' }];

  const registry = {
    has: () => true,
    get: () => ({
      fetch: async () => ({ items, nextState: { cursor: 'next' }, truncated: false }),
    }),
  } as unknown as KnowledgeSourceRegistry;

  const store = {
    listEnabledByIds: () => [
      { id: 'src_1', type: 'rss', configJson: '{}', stateJson: opts.stateJson ?? '{"cursor":"old"}' },
    ],
    updateState: (_id: string, _tenant: string, stateJson: string): void => {
      updateStateCalls += 1;
      writtenStates.push(stateJson);
      if (opts.updateStateFails) throw new Error('游标写入失败（模拟）');
    },
  } as unknown as KnowledgeSourceStore;

  const memoryGraph = {
    addMemory: (): { id: string } => {
      const id = `mem_${++memSeq}`;
      addedMemories.push(id);
      return { id };
    },
  } as unknown as CognitiveMemoryGraph;

  const emitted: Array<{ sourceId: string }> = [];
  const bus = {
    emit: (_kind: string, payload: { sourceId: string }) => { emitted.push(payload); },
  } as unknown as EventBus;
  const logger = {
    info: () => {}, warn: () => {}, debug: () => {},
    error: (_scope: string, msg: string) => { errorLogs.push(msg); },
  } as unknown as Logger;

  const service = new KnowledgeIngestionService(
    registry, store, memoryGraph, undefined, bus, logger, opts.maxItemsPerRun ?? 100,
  );

  return {
    service, addedMemories, errorLogs, emitted, writtenStates,
    get updateStateCalls() { return updateStateCalls; },
  } as Harness;
}

describe('KnowledgeIngestionService — 游标推进', () => {
  let signal: AbortSignal;
  beforeEach(() => { signal = new AbortController().signal; });

  it('正常路径：写入记忆并推进游标', async () => {
    const h = makeHarness();
    const result = await h.service.ingest(TENANT, ['src_1'], signal);
    assert.equal(result.imported, 2);
    assert.equal(h.addedMemories.length, 2);
    assert.equal(h.updateStateCalls, 1, '应推进一次游标');
  });

  it('游标推进失败 → 写 error 日志说明「下一轮将重复摄入」，不静默吞掉', async () => {
    const h = makeHarness({ updateStateFails: true });
    await h.service.ingest(TENANT, ['src_1'], signal);

    assert.equal(h.addedMemories.length, 2, '记忆确实已落库');
    assert.equal(h.errorLogs.length, 1, '必须留下 error 级痕迹');
    assert.match(h.errorLogs[0]!, /重复摄入/, '日志需说明后果');
    assert.match(h.errorLogs[0]!, /src_1/, '日志需含可定位信息');
  });

  /* 独立审查抓到的假绿：上面三条只断言 errorLogs，从未断言「游标失败**之后**会怎样」。
   * 首版实现在记日志后 rethrow，被同函数的 per-source catch 接住 →
   *   ① 已落库记忆的 knowledge:ingested 事件**被吞**，下游永远感知不到；
   *   ② skipped 计数把一批成功摄入的条目误计为跳过。
   * 变异（删掉 throw）时三条全绿 —— 等于完全没测到本次唯一的行为变更。 */
  it('游标失败但记忆已落库 → ingested 事件仍须发出（下游不得漏感知）', async () => {
    const h = makeHarness({ updateStateFails: true });
    const result = await h.service.ingest(TENANT, ['src_1'], signal);

    assert.equal(h.addedMemories.length, 2, '记忆已落库');
    assert.equal(h.emitted.length, 1, 'ingested 事件必须照常发出');
    assert.equal(h.emitted[0]!.sourceId, 'src_1');
    /* 成功摄入的条目不得被误计为 skipped。 */
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 0, '游标失败不改变摄入计数口径');
    /* 失败以结构化字段上报，而非借异常穿透到通用 catch。 */
    assert.deepEqual(result.cursorAdvanceFailures, ['src_1']);
  });

  it('单次运行内 fingerprint 去重仍生效（不因改动而回退）', async () => {
    const h = makeHarness({
      items: [
        { content: 'A', fingerprint: 'fp-1' },
        { content: 'A 重复', fingerprint: 'fp-1' },
        { content: 'B', fingerprint: 'fp-2' },
      ],
    });
    const result = await h.service.ingest(TENANT, ['src_1'], signal);
    assert.equal(result.imported, 2, '同 fingerprint 只摄入一次');
    assert.equal(result.skipped, 1);
  });

  /* ⚠️ 审计 #423：此前**只有 `!truncated` 才推进游标**，于是当 feed 条数长期
   * 超过 maxItemsPerRun 时，游标**永不推进** —— 每轮重新拉同一批、只处理前 N 条，
   * **超出部分永远读不到**（实测 3 轮写入 30 个节点 / 25 条 feed）。 */
  it('审计 #423：截断时必须按已处理位置推进游标（不得永不推进）', async () => {
    const h = makeHarness({
      items: [
        { content: 'a', publishedAt: 1000 },
        { content: 'b', publishedAt: 2000 },
        { content: 'c', publishedAt: 3000 },
      ],
      maxItemsPerRun: 2,          /* 只处理前 2 条 → 触发截断 */
      stateJson: '{"lastBuildTs":0}',
    });
    const result = await h.service.ingest(TENANT, ['src_1'], signal);

    assert.equal(result.imported, 2, '本轮只导入 2 条');
    /* 变异实测：改回 `if (!truncated)` → updateStateCalls=0，本断言转红。 */
    assert.equal(h.updateStateCalls, 1, '截断时也必须推进游标');

    const written = JSON.parse(h.writtenStates[0]!) as { lastBuildTs: number };
    /* 推进到**已处理的最后一条**（2000），而不是全部项的最大值（3000）——
     * 后者会跳过第 3 条，那是原守卫要防的事，方向相反但同样丢数据。 */
    assert.equal(written.lastBuildTs, 2000, '游标应停在已处理位置，不得跳过未处理项');
  });

  it('审计 #423：游标只进不退（乱序/并发下不得把已推进的游标拉回）', async () => {
    const h = makeHarness({
      items: [{ content: 'old', publishedAt: 500 }, { content: 'old2', publishedAt: 600 }],
      maxItemsPerRun: 1,
      stateJson: '{"lastBuildTs":9000}',   /* 游标已远超本批 */
    });
    await h.service.ingest(TENANT, ['src_1'], signal);
    assert.equal(h.updateStateCalls, 0, '本批时间戳更旧 → 不得回退游标');
  });

  it('审计 #423：源不提供 publishedAt 时保持不推进（保守，宁可重复不跳过）', async () => {
    const h = makeHarness({
      items: [{ content: 'x' }, { content: 'y' }, { content: 'z' }],
      maxItemsPerRun: 2,
    });
    await h.service.ingest(TENANT, ['src_1'], signal);
    assert.equal(h.updateStateCalls, 0, '无时间戳无法定位处理位置 → 不推进');
  });

  it('对照：未截断时仍用 source 的 nextState（不得被部分游标顶替）', async () => {
    const h = makeHarness({
      items: [{ content: 'a', publishedAt: 1000 }],
      maxItemsPerRun: 10,        /* 不截断 */
    });
    await h.service.ingest(TENANT, ['src_1'], signal);
    assert.equal(h.updateStateCalls, 1);
    const written = JSON.parse(h.writtenStates[0]!) as { cursor?: string };
    assert.equal(written.cursor, 'next', '未截断路径应写 source 返回的 nextState');
  });
});
