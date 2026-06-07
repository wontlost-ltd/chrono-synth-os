/**
 * ADR-0047：ArtifactCompiler 单元测试
 * 验证 compiled 工件被确定性地应用到核心状态（value/edge/narrative/template）。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/index.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { CoreRhythmLayer } from '../../core/core-rhythm-layer.js';
import { ArtifactCompiler } from '../../intelligence/artifact-compiler.js';
import { ResponseTemplateStore } from '../../storage/response-template-store.js';
import type { DistilledArtifact } from '@chrono/kernel';

function artifact(overrides: Partial<DistilledArtifact> & Pick<DistilledArtifact, 'kind' | 'payload'>): DistilledArtifact {
  return {
    id: 'dart-1', source: 'reflection', confidence: 0.9,
    evidence: [{ type: 'pattern', id: 'e1', score: 0.7 }],
    status: 'approved', createdAt: 1000,
    ...overrides,
  } as DistilledArtifact;
}

describe('ArtifactCompiler (ADR-0047)', () => {
  let db: IDatabase;
  let core: CoreRhythmLayer;
  let templates: ResponseTemplateStore;
  let compiler: ArtifactCompiler;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const clock = new TestClock(1000);
    core = new CoreRhythmLayer(db, new EventBus(), clock, new SilentLogger());
    templates = new ResponseTemplateStore(db, 'default');
    compiler = new ArtifactCompiler(core, new SilentLogger(), templates, clock);
  });

  it('value_shift 编译为价值权重', () => {
    const v = core.addValue('curiosity', 0.5);
    const r = compiler.compile('p1', artifact({
      kind: 'value_shift',
      payload: { valueId: v.id, currentWeight: 0.5, suggestedWeight: 0.6, delta: 0.1, patternAgrees: true },
    }));
    assert.equal(r.ok, true);
    assert.equal(core.values.getById(v.id)?.weight, 0.6);
  });

  it('value_shift 目标价值不存在 → 失败（不抛错）', () => {
    const r = compiler.compile('p1', artifact({
      kind: 'value_shift',
      payload: { valueId: 'missing', currentWeight: 0.5, suggestedWeight: 0.6, delta: 0.1, patternAgrees: true },
    }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /value not found/);
  });

  it('memory_edge 编译为记忆图边', () => {
    const m1 = core.addMemory('episodic', '记忆A', 0.5, 0.8);
    const m2 = core.addMemory('semantic', '记忆B', 0.3, 0.6);
    const r = compiler.compile('p1', artifact({
      kind: 'memory_edge',
      payload: { sourceId: m1.id, targetId: m2.id, relation: 'enriched_by', strength: 0.7 },
    }));
    assert.equal(r.ok, true);
    const edges = core.memories.getEdgesFor(m1.id);
    assert.ok(edges.some((e) => e.target === m2.id && e.relation === 'enriched_by'));
  });

  it('memory_edge 源记忆不存在 → 失败（不抛错）', () => {
    const r = compiler.compile('p1', artifact({
      kind: 'memory_edge',
      payload: { sourceId: 'nope', targetId: 'nope2', relation: 'r', strength: 0.5 },
    }));
    assert.equal(r.ok, false);
  });

  it('narrative_patch 编译为叙事', () => {
    const r = compiler.compile('p1', artifact({
      kind: 'narrative_patch',
      payload: { narrative: '我是一个更专注的数字人。' },
    }));
    assert.equal(r.ok, true);
    assert.equal(core.narrative.get(), '我是一个更专注的数字人。');
  });

  it('narrative_patch 空内容 → 失败', () => {
    const r = compiler.compile('p1', artifact({ kind: 'narrative_patch', payload: { narrative: '  ' } }));
    assert.equal(r.ok, false);
  });

  it('response_template 编译进专用持久表（不落会衰减的 procedural memory）', () => {
    const memBefore = core.memories.getAllMemories().size;
    const r = compiler.compile('p1', artifact({
      id: 'dart-tpl',
      kind: 'response_template',
      payload: { intent: 'greeting', template: '你好，我记得你。' },
    }));
    assert.equal(r.ok, true);
    /* 不再污染记忆图（旧实现会 +1 procedural memory） */
    assert.equal(core.memories.getAllMemories().size, memBefore, '不应写入 procedural memory');
    /* 落专用表：可按 intent 取最新版本，且溯源到工件 */
    const tpl = templates.getLatestByIntent('p1', 'greeting');
    assert.ok(tpl, '应在专用表可检索');
    assert.equal(tpl?.template, '你好，我记得你。');
    assert.equal(tpl?.version, 1);
    assert.equal(tpl?.artifactId, 'dart-tpl');
  });

  it('response_template 同 intent 再编译 → 版本递增、留史', () => {
    compiler.compile('p1', artifact({ id: 'a1', kind: 'response_template', payload: { intent: 'greeting', template: 'v1 文案' } }));
    const r2 = compiler.compile('p1', artifact({ id: 'a2', kind: 'response_template', payload: { intent: 'greeting', template: 'v2 文案' } }));
    assert.equal(r2.ok, true);
    assert.equal(templates.getLatestByIntent('p1', 'greeting')?.version, 2);
    assert.equal(templates.getLatestByIntent('p1', 'greeting')?.template, 'v2 文案');
    /* 留史：两个版本都在 */
    assert.equal(templates.listVersionsByIntent('p1', 'greeting').length, 2);
  });

  it('response_template 未注入 store → unsupported 显式失败（不静默）', () => {
    const noStore = new ArtifactCompiler(core, new SilentLogger());
    const r = noStore.compile('p1', artifact({ kind: 'response_template', payload: { intent: 'x', template: 't' } }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /store not configured/);
  });

  it('rule / decision_style_patch 等未支持 kind → unsupported（不静默丢弃）', () => {
    for (const kind of ['rule', 'decision_style_patch', 'cognitive_model_patch'] as const) {
      const r = compiler.compile('p1', artifact({ kind, payload: {} }));
      assert.equal(r.ok, false, `${kind} 应 unsupported`);
      if (!r.ok) assert.match(r.reason, /unsupported artifact kind/);
    }
  });
});
