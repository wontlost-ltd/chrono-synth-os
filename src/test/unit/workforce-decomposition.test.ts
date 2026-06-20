import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDecompositionPlaybook, supportedGoalTypes, GOAL_TYPE_CONTENT_PIECE } from '../../workforce/decomposition-playbook.js';

/* 数字组织确定性目标分解（零-LLM）——相同目标 → 相同任务规格序列。 */
describe('decomposition playbook（确定性目标分解）', () => {
  it('内容运营目标 → 研究/写作/审核/发布 四环节，顺序固定', () => {
    const pb = getDecompositionPlaybook(GOAL_TYPE_CONTENT_PIECE);
    assert.ok(pb, '内容运营 playbook 存在');
    const specs = pb!.decompose({ title: '咖啡冲煮指南', description: '' });
    assert.equal(specs.length, 4);
    assert.deepEqual(specs.map((s) => s.assigneeRoleCode), ['researcher_ic', 'writer_ic', 'reviewer_ic', 'publisher_ic']);
    assert.deepEqual(specs.map((s) => s.taskType), ['research', 'writing', 'review', 'publish_prep']);
    assert.ok(specs.every((s) => s.title.includes('咖啡冲煮指南')), '任务标题带主题');
  });

  it('确定性可复现：相同目标 → 逐字相同的任务规格序列', () => {
    const pb = getDecompositionPlaybook(GOAL_TYPE_CONTENT_PIECE)!;
    const a = pb.decompose({ title: 'X', description: 'D' });
    const b = pb.decompose({ title: 'X', description: 'D' });
    assert.deepEqual(a, b);
  });

  it('A0 契约字段：每个任务带 risk/tool-eligible/acceptance/capabilities', () => {
    const pb = getDecompositionPlaybook(GOAL_TYPE_CONTENT_PIECE)!;
    const specs = pb.decompose({ title: '主题', description: '' });
    /* 每个 spec 都有完整契约字段。 */
    assert.ok(specs.every((s) => ['low', 'medium', 'high'].includes(s.riskLevel)), '都有 riskLevel');
    assert.ok(specs.every((s) => typeof s.allowsToolExecution === 'boolean'), '都有 allowsToolExecution');
    assert.ok(specs.every((s) => s.acceptanceCriteria.length > 0), '都有验收标准');
    assert.ok(specs.every((s) => s.requiredCapabilities.length > 0), '都有所需能力');
    /* 发布环节风险更高 + 标记可走工具（备 D 切片）；研究/写作低风险不走工具。 */
    const publish = specs.find((s) => s.taskType === 'publish_prep')!;
    assert.equal(publish.riskLevel, 'high');
    assert.equal(publish.allowsToolExecution, true);
    const research = specs.find((s) => s.taskType === 'research')!;
    assert.equal(research.riskLevel, 'low');
    assert.equal(research.allowsToolExecution, false);
    assert.deepEqual(research.requiredCapabilities, ['research']);
  });

  it('A0 qualityRubric：playbook 带验收维度', () => {
    const pb = getDecompositionPlaybook(GOAL_TYPE_CONTENT_PIECE)!;
    assert.ok(pb.qualityRubric.length >= 3, '至少几个验收维度');
    assert.ok(pb.qualityRubric.every((d) => d.dimension.length > 0 && d.description.length > 0));
    assert.ok(pb.qualityRubric.some((d) => d.dimension === '合规'), '含合规维度');
  });

  it('空标题 → 用占位主题（不崩、仍确定性）', () => {
    const pb = getDecompositionPlaybook(GOAL_TYPE_CONTENT_PIECE)!;
    const specs = pb.decompose({ title: '   ', description: '' });
    assert.equal(specs.length, 4);
    assert.ok(specs[0]!.title.includes('未命名主题'));
  });

  it('未知 goalType → undefined（不臆造，调用方应拒绝）', () => {
    assert.equal(getDecompositionPlaybook('strategy_planning'), undefined);
  });

  it('supportedGoalTypes 含内容运营', () => {
    assert.ok(supportedGoalTypes().includes(GOAL_TYPE_CONTENT_PIECE));
  });
});
