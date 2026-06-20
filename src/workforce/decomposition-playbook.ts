/**
 * 确定性目标分解 playbook（智能来源）——数字组织的「manager 怎么拆目标」用确定性规则，零-LLM。
 *
 * 论点（ADR-0047）：运行时不调 LLM。组织决策的「智能」来自**已蒸馏/已规则化的 playbook**，
 * 而非运行时推理。本切片硬编码一个内容运营域的 reference playbook 作为结构样板；未来同一接口由
 * 蒸馏管线编译生成（LLM 离线产出候选 → 蒸馏门 → 编译成确定性规则）。
 *
 * 可复现：相同目标 → 相同任务规格序列。无随机、无时钟、无网络。
 */

import type { DecompositionPlaybook, TaskSpec } from './types.js';

/** 受限 goal type：内容运营「产出一篇内容」。 */
export const GOAL_TYPE_CONTENT_PIECE = 'content_piece';

/**
 * 内容运营分解 playbook：一篇内容 = 研究 → 写作 → 审核 → 发布准备，分派给对应岗位。
 * 这是「数字主管(managing_editor)」确定性拆解一个内容目标的规则。每个任务带 A0 稳定契约字段
 * （风险/是否可走工具/验收标准/所需能力），供后续协作/执行/展示复用。本切片全 stub（allowsToolExecution
 * 暂为 false，发布环节标 true 以备 D 切片，但 D 未接前仍走 stub）。
 */
const CONTENT_PIECE_PLAYBOOK: DecompositionPlaybook = {
  goalType: GOAL_TYPE_CONTENT_PIECE,
  qualityRubric: [
    { dimension: '准确性', description: '事实与引用无误，不臆造' },
    { dimension: '完整性', description: '覆盖主题要点，无明显遗漏' },
    { dimension: '风格', description: '语言清晰、面向目标读者' },
    { dimension: '合规', description: '不含敏感/越界内容，符合发布规范' },
  ],
  decompose(goal): readonly TaskSpec[] {
    const topic = goal.title.trim() || '未命名主题';
    /* 固定职能链：研究员→写作→审核→发布助理。顺序与岗位绑定确定，相同目标相同序列。 */
    return [
      { assigneeRoleCode: 'researcher_ic', title: `研究主题：${topic}`, taskType: 'research', riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: '收集到可引用的事实与来源', requiredCapabilities: ['research'] },
      { assigneeRoleCode: 'writer_ic', title: `撰写初稿：${topic}`, taskType: 'writing', riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: '初稿覆盖研究要点、结构完整', requiredCapabilities: ['writing'] },
      { assigneeRoleCode: 'reviewer_ic', title: `审核内容：${topic}`, taskType: 'review', riskLevel: 'medium', allowsToolExecution: false, acceptanceCriteria: '事实/风格/合规均通过，标注修改', requiredCapabilities: ['review', 'compliance'] },
      /* 发布环节涉及对外动作，未来由 D 真实执行（故标 allowsToolExecution=true + 风险更高）；D 接入前仍 stub。 */
      { assigneeRoleCode: 'publisher_ic', title: `准备发布：${topic}`, taskType: 'publish_prep', riskLevel: 'high', allowsToolExecution: true, acceptanceCriteria: '发布清单就绪，待人类/上级最终确认', requiredCapabilities: ['publishing'] },
    ];
  },
};

/** 所有已注册的确定性分解 playbook（按 goalType 索引）。 */
const PLAYBOOKS: ReadonlyMap<string, DecompositionPlaybook> = new Map([
  [CONTENT_PIECE_PLAYBOOK.goalType, CONTENT_PIECE_PLAYBOOK],
]);

/** 取某 goalType 的确定性分解 playbook；无 → undefined（调用方应拒绝未知 goalType，不臆造）。 */
export function getDecompositionPlaybook(goalType: string): DecompositionPlaybook | undefined {
  return PLAYBOOKS.get(goalType);
}

/** 已支持的 goal type 列表（用于校验/文档）。 */
export function supportedGoalTypes(): readonly string[] {
  return [...PLAYBOOKS.keys()];
}
