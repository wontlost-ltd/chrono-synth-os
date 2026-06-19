import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectSummaryIntent, buildSummary } from '../../conversation/summary-builder.js';
import type { MemoryId, MemoryNode, MemoryEdge } from '@chrono/kernel';

/* 构造测试记忆 Map（最小 MemoryNode）。 */
function mem(id: string, content: string, salience = 0.5, createdAt = 1000): MemoryNode {
  return {
    id, kind: 'semantic', content, valence: 0, salience, createdAt,
    lastAccessedAt: createdAt, accessCount: 0, decayLambda: 0, lastDecayedAt: createdAt, consolidatedFrom: null,
  };
}
function asMap(nodes: MemoryNode[]): ReadonlyMap<MemoryId, MemoryNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}
const noEdges = (): MemoryEdge[] => [];

describe('detectSummaryIntent', () => {
  it('中文有主题 → matched + topic', () => {
    assert.deepEqual(detectSummaryIntent('总结一下你学过的带团队', 'zh-CN'), { matched: true, topic: '带团队' });
    assert.deepEqual(detectSummaryIntent('归纳你知道的危机管理', 'zh-CN'), { matched: true, topic: '危机管理' });
  });
  it('中文无主题（最近学了什么）→ matched + 无 topic', () => {
    for (const q of ['你最近学了什么', '总结一下你学到的东西', '你都学了些什么']) {
      const r = detectSummaryIntent(q, 'zh-CN');
      assert.equal(r.matched, true, q);
      assert.equal(r.topic, undefined, `${q} 不应有 topic`);
    }
  });
  it('英文有/无主题', () => {
    assert.deepEqual(detectSummaryIntent('what have you learned about crisis', 'en'), { matched: true, topic: 'crisis' });
    assert.equal(detectSummaryIntent('what have you learned', 'en').topic, undefined);
  });
  it('非归纳意图 → 不 matched（不误吞 self_intro/问名字）', () => {
    for (const [q, loc] of [['你会什么', 'zh-CN'], ['你是谁', 'zh-CN'], ['what is your name', 'en'], ['hello', 'en']] as const) {
      assert.equal(detectSummaryIntent(q, loc).matched, false, q);
    }
  });

  it('对抗（Codex 复审）：总结**外部对象**不当人格记忆归纳（须含「你学过」框架）', () => {
    for (const [q, loc] of [
      ['summarize this document', 'en'], ['can you summarize the meeting notes?', 'en'], ['summarize the report', 'en'],
      ['总结一下 flat white 做法', 'zh-CN'], ['总结一下：我最近在学吉他', 'zh-CN'],
    ] as const) {
      assert.equal(detectSummaryIntent(q, loc).matched, false, `「${q}」总结外部对象，不该当人格归纳`);
    }
  });
});

describe('buildSummary', () => {
  const mems = asMap([
    mem('m1', '带团队要授权，把决策权一起交出去', 0.8, 3000),
    mem('m2', '带团队的核心是激励而非控制', 0.7, 2000),
    mem('m3', '我学会了做 flat white', 0.6, 1000),
  ]);

  it('有主题 → 归纳相关记忆（含 lead-in + 条目 + footer）', () => {
    const s = buildSummary({ memories: mems, edgesFor: noEdges, topic: '带团队', locale: 'zh-CN' });
    assert.ok(s, '应有总述');
    assert.match(s!, /关于「带团队」/);
    assert.match(s!, /授权|激励/, '含相关记忆');
    assert.ok(!s!.includes('flat white'), '不相关记忆不进总述');
    assert.match(s!, /归纳自我相关的 \d+ 条记忆/, '含 footer');
  });

  it('无主题 → 最近记忆（createdAt 降序）', () => {
    const s = buildSummary({ memories: mems, edgesFor: noEdges, topic: undefined, locale: 'zh-CN' });
    assert.ok(s);
    assert.match(s!, /我最近记住的是/);
    /* 最新的 m1 在前。 */
    const recentIdx = s!.indexOf('授权');
    const flatIdx = s!.indexOf('flat white');
    assert.ok(recentIdx >= 0 && flatIdx >= 0 && recentIdx < flatIdx, '最近的记忆排前面');
  });

  it('主题无相关记忆 → summaryEmpty', () => {
    const s = buildSummary({ memories: mems, edgesFor: noEdges, topic: '量子物理', locale: 'zh-CN' });
    assert.match(s!, /还没学过|没学过/);
  });

  it('无任何记忆 → summaryNothing', () => {
    const s = buildSummary({ memories: asMap([]), edgesFor: noEdges, topic: undefined, locale: 'zh-CN' });
    assert.match(s!, /还没有可总结|多教我/);
  });

  it('去重：相同内容只出现一次', () => {
    const dup = asMap([mem('a', '同一句话', 0.8, 2000), mem('b', '同一句话', 0.7, 1000)]);
    const s = buildSummary({ memories: dup, edgesFor: noEdges, topic: undefined, locale: 'zh-CN' });
    const count = (s!.match(/同一句话/g) ?? []).length;
    assert.equal(count, 1, '相同内容去重');
  });

  it('英文 locale → 英文模板', () => {
    const enMems = asMap([mem('m1', 'delegation means handing over decisions', 0.8, 2000)]);
    const s = buildSummary({ memories: enMems, edgesFor: noEdges, topic: 'delegation', locale: 'en' });
    assert.match(s!, /Here's what I've learned about "delegation"/);
    assert.match(s!, /Summarized from \d+/);
  });

  it('确定性：相同输入 → 相同输出', () => {
    const a = buildSummary({ memories: mems, edgesFor: noEdges, topic: '带团队', locale: 'zh-CN' });
    const b = buildSummary({ memories: mems, edgesFor: noEdges, topic: '带团队', locale: 'zh-CN' });
    assert.equal(a, b);
  });
});
