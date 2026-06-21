/**
 * 服务端工具风险派生（E3 安全修复，ADR-0055 铁律1）——风险信号必须来自**可信来源**（工具 registry
 * metadata），不能完全信任 HTTP 调用方 body。
 *
 * 攻击面（Codex 复审致命）：若 riskSignals 全靠 body，攻击者可对一个 low 任务**省略**所有高风险信号，
 * 让 email.send/支付/发布等高风险工具被评成 low → 不需要审批 → 直接真实执行对外动作。
 *
 * 修复：服务端按 toolId 从 registry 读工具自身风险（静态 highRisk + 按 args 的动态 isHighRisk），
 * 与 body 声明的信号取并（只增不减）。body 仍可**上调**风险（声明 funds/outbound 等），但**无法下调**
 * 工具自身的高风险。pipeline 只暴露布尔 highRisk（无 funds/outbound 细分），故服务端把高风险工具映射为
 * toolRisk=high + requireConfirmation=true（确定性顶到必须人类审批门）。
 */

import type { ExecutionRiskSignals } from './execution-risk.js';

/** 能按 toolId 查工具风险的最小接口（ToolRegistry 子集，便于解耦+单测）。 */
export interface ToolRiskSource {
  get(toolId: string): {
    readonly metadata: { readonly highRisk: boolean };
    isHighRisk?(args: Record<string, unknown>): boolean;
  } | undefined;
}

/** body 可声明的风险信号（不含 taskRisk——那由任务 A0 契约定）。 */
export type DeclaredRiskSignals = Omit<ExecutionRiskSignals, 'taskRisk'>;

/**
 * 合并「服务端工具派生风险」与「调用方声明风险」（只增不减）。
 *   - 工具静态 highRisk 或按 args 动态高风险 → toolRisk 顶到 'high' + requireConfirmation=true；
 *   - 未注册工具：不臆造低风险（保守，requireConfirmation=true，让其走审批/被管线 tool_not_found 拦）；
 *   - body 声明的 outbound/sensitive/funds/irreversible/toolRisk 一律保留（只能上调）。
 * 返回喂给 assessExecutionRisk 的信号（不含 taskRisk，调用方再拼 task.riskLevel）。
 */
export function deriveRiskSignals(
  source: ToolRiskSource,
  toolId: string,
  args: Record<string, unknown>,
  declared: DeclaredRiskSignals | undefined,
): DeclaredRiskSignals {
  const adapter = source.get(toolId);
  /* 工具自身风险（不可信调用方无法下调）。未注册工具保守按「需确认」处理。 */
  const toolHighRisk = adapter ? (adapter.metadata.highRisk || (adapter.isHighRisk?.(args) ?? false)) : true;

  const d = declared ?? {};
  /* toolRisk 取较高者（body 声明的 vs 工具派生的）。 */
  const declaredToolRisk = d.toolRisk ?? 'low';
  const toolRisk = toolHighRisk ? 'high' : declaredToolRisk;

  return {
    toolRisk,
    /* 工具高风险 → 强制二次确认（至少顶到 medium，配合硬信号可能更高）。body 声明的也保留。 */
    requireConfirmation: toolHighRisk || d.requireConfirmation === true,
    /* 以下硬信号 body 只能上调（true 保留，缺省不臆造）。 */
    outboundCommitment: d.outboundCommitment === true,
    sensitiveData: d.sensitiveData === true,
    funds: d.funds === true,
    irreversible: d.irreversible === true,
  };
}
