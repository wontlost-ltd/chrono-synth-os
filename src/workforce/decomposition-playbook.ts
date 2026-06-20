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
 * 这是「数字主管(managing_editor)」确定性拆解一个内容目标的规则。
 */
const CONTENT_PIECE_PLAYBOOK: DecompositionPlaybook = {
  goalType: GOAL_TYPE_CONTENT_PIECE,
  decompose(goal): readonly TaskSpec[] {
    const topic = goal.title.trim() || '未命名主题';
    /* 固定职能链：研究员→写作→审核→发布助理。顺序与岗位绑定确定，相同目标相同序列。 */
    return [
      { assigneeRoleCode: 'researcher_ic', title: `研究主题：${topic}`, taskType: 'research' },
      { assigneeRoleCode: 'writer_ic', title: `撰写初稿：${topic}`, taskType: 'writing' },
      { assigneeRoleCode: 'reviewer_ic', title: `审核内容：${topic}`, taskType: 'review' },
      { assigneeRoleCode: 'publisher_ic', title: `准备发布：${topic}`, taskType: 'publish_prep' },
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
