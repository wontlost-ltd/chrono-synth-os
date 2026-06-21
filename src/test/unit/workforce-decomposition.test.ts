import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDecompositionPlaybook, supportedGoalTypes, GOAL_TYPE_CONTENT_PIECE, GOAL_TYPE_SUPPORT_TICKET, GOAL_TYPE_DATA_ANALYSIS } from '../../workforce/decomposition-playbook.js';

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

  /* A1 多 goal type：客服中台 + 数据分析，复用 A0 契约。 */
  it('A1 客服工单：分诊→处理→升级准备→质检，契约+rubric 完整', () => {
    const pb = getDecompositionPlaybook(GOAL_TYPE_SUPPORT_TICKET)!;
    const specs = pb.decompose({ title: '登录失败', description: '' });
    assert.deepEqual(specs.map((s) => s.taskType), ['triage', 'handle', 'escalation_prep', 'qa']);
    /* 升级准备高风险 + 标记可走工具（备 D）。 */
    const esc = specs.find((s) => s.taskType === 'escalation_prep')!;
    assert.equal(esc.riskLevel, 'high');
    assert.equal(esc.allowsToolExecution, true);
    assert.ok(pb.qualityRubric.some((d) => d.dimension === '时效'));
  });

  it('A1 数据分析：澄清→取数→分析→复核→报告，契约+rubric 完整', () => {
    const pb = getDecompositionPlaybook(GOAL_TYPE_DATA_ANALYSIS)!;
    const specs = pb.decompose({ title: '月活分析', description: '' });
    assert.deepEqual(specs.map((s) => s.taskType), ['clarify', 'extract', 'analyze', 'review', 'report']);
    /* 取数标记可走工具（备 D）。 */
    const ext = specs.find((s) => s.taskType === 'extract')!;
    assert.equal(ext.allowsToolExecution, true);
    assert.ok(pb.qualityRubric.some((d) => d.dimension === '可复现'));
  });

  it('A1 三种 goal type 各自确定性可复现', () => {
    for (const gt of [GOAL_TYPE_CONTENT_PIECE, GOAL_TYPE_SUPPORT_TICKET, GOAL_TYPE_DATA_ANALYSIS]) {
      const pb = getDecompositionPlaybook(gt)!;
      assert.deepEqual(pb.decompose({ title: 'X', description: 'D' }), pb.decompose({ title: 'X', description: 'D' }));
    }
  });

  it('supportedGoalTypes 含全部三种', () => {
    const types = supportedGoalTypes();
    assert.ok(types.includes(GOAL_TYPE_SUPPORT_TICKET));
    assert.ok(types.includes(GOAL_TYPE_DATA_ANALYSIS));
    assert.equal(types.length, 3);
  });

  /* 通用契约守卫（Codex 复审）：**所有**已注册 playbook 的每个 TaskSpec 都必须填全 A0 契约字段 +
   * 带非空 rubric。新增 playbook 漏字段会在此被抓住（防测试名强于覆盖）。 */
  it('契约守卫：每个 goal type 的每个任务都填全 A0 契约 + 有 rubric', () => {
    for (const goalType of supportedGoalTypes()) {
      const pb = getDecompositionPlaybook(goalType)!;
      assert.ok(pb.qualityRubric.length > 0, `${goalType} 有 rubric`);
      assert.ok(pb.qualityRubric.every((d) => d.dimension.length > 0 && d.description.length > 0), `${goalType} rubric 维度非空`);
      const specs = pb.decompose({ title: '测试主题', description: 'D' });
      assert.ok(specs.length > 0, `${goalType} 至少一个任务`);
      for (const s of specs) {
        assert.ok(s.assigneeRoleCode.length > 0, `${goalType}/${s.taskType} 有 assignee`);
        assert.ok(s.title.length > 0, `${goalType}/${s.taskType} 有 title`);
        assert.ok(['low', 'medium', 'high'].includes(s.riskLevel), `${goalType}/${s.taskType} 有合法 riskLevel`);
        assert.equal(typeof s.allowsToolExecution, 'boolean', `${goalType}/${s.taskType} 有 allowsToolExecution`);
        assert.ok(s.acceptanceCriteria.length > 0, `${goalType}/${s.taskType} 有验收标准`);
        assert.ok(s.requiredCapabilities.length > 0, `${goalType}/${s.taskType} 有所需能力`);
      }
    }
  });
});
