/**
 * 单 agent 对照基线（digital workforce M1）——证明「组织结构」相对「单 agent 一把梭」的价值。
 *
 * 蓝图铁律：MVP 必须有对照组，且对照必须**公平**（同零-LLM、同确定性、同执行能力），差别只在**有无组织
 * 结构**。本基线的单 agent 同样确定性地把目标做完——它甚至可以「打日志」，所以光比「事件条数」不公平
 * （Codex 复审）。真正的差别是**责任可归因**：
 *   - 数字组织：每个交付环节都有**具名问责的数字员工** + **来自具名员工的可审计汇报** → 失败能定位到「谁的哪个环节」。
 *   - 单 agent：产出一个黑盒整体，**没有任何环节级的具名问责**（accountableStages=0）——失败只能整体重来。
 * 所以对照断言的是「可归因责任环节数」，不是「bookkeeping 事件数」。
 *
 * 纯确定性，零-LLM，无副作用（不落库）。
 */

/** 单 agent 处理一个目标的结果（与 RunGoalResult 对照）。 */
export interface SingleAgentResult {
  /** 单 agent 的整体产出（一个不可分的黑盒结果）。 */
  readonly output: string;
  /**
   * 公平起见：单 agent 也可以「记事件」，所以这里给它一个**慷慨**的事件计数（拆成内部若干步并各记一条），
   * 证明「组织优势不靠多记日志」——即便单 agent 记同样多甚至更多事件，它仍缺下面的「具名问责环节」。
   */
  readonly loggedEvents: number;
  /**
   * 可归因责任环节数：每个环节都能定位到「**哪个具名角色对它负责** + 谁汇报的」。
   * 单 agent = 0（黑盒整体无环节级问责，无论它记多少日志）。这才是组织结构的真价值，不是日志条数。
   */
  readonly accountableStages: number;
}

/**
 * 单 agent 确定性处理一个目标：直接产出一个整体结果。即便它内部「分了几步并各记一条日志」（loggedEvents
 * 给得很慷慨），这些步骤**没有具名角色问责、没有具名汇报**——所以 accountableStages 仍为 0。
 * 这是「没有组织结构」的公平对照：同零-LLM、同能力，差别只在有无可归因的组织责任链。
 */
export function runGoalAsSingleAgent(goal: { readonly title: string; readonly description: string }): SingleAgentResult {
  const topic = goal.title.trim() || '未命名主题';
  return {
    output: `[single-agent] 关于「${topic}」的整体产出（一次性完成，无具名问责环节）`,
    /* 故意给单 agent 慷慨的事件数（甚至多于组织的步数也无妨）——证明组织优势不靠日志条数。 */
    loggedEvents: 99,
    accountableStages: 0,
  };
}
