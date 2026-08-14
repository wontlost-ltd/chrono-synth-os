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
  errorLogs: string[];
  /** 捕获 knowledge:ingested 事件——不捕获就无法发现「事件被吞」这类回退。 */
  emitted: Array<{ sourceId: string }>;
}

/** 造一个只含所需能力的最小 service；updateStateFails 控制游标推进是否抛错。 */
function makeHarness(opts: { updateStateFails?: boolean; items?: Array<{ content: string; fingerprint?: string }> } = {}): Harness {
  const addedMemories: string[] = [];
  const errorLogs: string[] = [];
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
      { id: 'src_1', type: 'rss', configJson: '{}', stateJson: '{"cursor":"old"}' },
    ],
    updateState: (): void => {
      updateStateCalls += 1;
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
    registry, store, memoryGraph, undefined, bus, logger,
  );

  return {
    service, addedMemories, errorLogs, emitted,
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
});
