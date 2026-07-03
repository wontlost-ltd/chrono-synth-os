/**
 * 工具动作编译器 service（ADR-0060 R1 / T1）——运行时零-LLM 的「工具调用参数从哪来」入口。
 *
 * 把「取候选规则（store）→ 确定性解析唯一规则 + 构造 arguments（kernel 纯函数）」串成一个运行时接口。
 * 数字人格要调某工具做某任务时，调本 service 得到 ToolCallPlan（toolId + arguments + 幂等键），再喂给
 * ToolInvocationPipeline 7 门执行（红线 5：本层只解决参数构造，不替代任何执行门）。
 *
 * 严守 ADR-0060 红线：运行时**不调 LLM**（智能已在编译期变成确定性规则）；无规则/冲突/过期/schema 不符/
 * 缺字段/枚举越界/缺必填 → **fail-closed**（要求人工补，绝不猜），由调用方决定登记学习/退回人工。
 *
 * T1 边界：规则表由 T2/T3 学习通道填充；T1 阶段表为空 → 一切 fail-closed（no_rule），不改任何现有行为。
 */

import type { McpToolSchema, ToolCompileResult, ToolRuleKey } from '@chrono/kernel';
import { resolveActiveRule, compileToolCall } from '@chrono/kernel';
import type { ToolActionRuleStore } from '../storage/tool-action-rule-store.js';

/** 一次工具动作编译请求。 */
export interface CompileToolActionInput {
  readonly personaId: string;
  readonly toolId: string;
  readonly capability: string;
  /** 目标 tool 的 inputSchema（校验必填项）。 */
  readonly toolSchema: McpToolSchema;
  /** 目标 tool inputSchema 的版本（与规则 schemaVersion 比对；不符 → fail-closed）。 */
  readonly schemaVersion: string;
  /** 任务结构化字段（pick/template/enum 取值源）。 */
  readonly taskFields: Readonly<Record<string, unknown>>;
}

export class ToolActionCompilerService {
  constructor(
    private readonly store: ToolActionRuleStore,
    private readonly tenantId: string,
    private readonly now: () => number,
  ) {}

  /**
   * 运行时据确定性规则把任务字段编译成一次工具调用计划。
   * @returns ToolCompileResult：ok=plan（喂管线执行）/ fail-closed（要求人工介入，绝不猜）。
   */
  compile(input: CompileToolActionInput): ToolCompileResult {
    const now = this.now();
    const candidates = this.store.listCandidates(input.personaId, input.toolId, input.capability);
    const key: ToolRuleKey = {
      tenantId: this.tenantId,
      personaId: input.personaId,
      toolId: input.toolId,
      capability: input.capability,
      schemaVersion: input.schemaVersion,
    };
    const resolution = resolveActiveRule(candidates, key, now);
    if (!resolution.ok) {
      /* 无规则/冲突/过期 → fail-closed（红线 10 + fail-closed 铁律）。 */
      return { ok: false, failClosed: true, reason: resolution.reason, code: resolution.code };
    }
    return compileToolCall(resolution.rule, input.taskFields, input.toolSchema, now);
  }
}
