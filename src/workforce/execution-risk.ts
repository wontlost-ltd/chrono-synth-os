/**
 * 执行有效风险分级 + 审批路由（ADR-0055 D0.2/铁律1）——确定性，零-LLM。
 *
 * 铁律1「有效风险只升不降」：审批用的不是裸 task.riskLevel，而是
 *   effectiveRisk = max(task.riskLevel, 工具风险, 数据/动作分级, requireConfirmation)
 * 任何命中**对外承诺/敏感数据/资金/不可逆**的执行**强制 high**，不能被 A0 的 medium 或上级 worker 批准降级。
 * 风险判定**禁止用 LLM**——纯规则（A0 字段 + 工具 metadata + 确定性 action 标记）。
 */

import type { RiskLevel } from './types.js';

/** 风险等级序（用于 max）。 */
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** 一次拟执行的风险信号（确定性来源：A0 任务契约 + 工具 metadata + 动作分级）。 */
export interface ExecutionRiskSignals {
  /** 任务自身风险（A0 riskLevel）。 */
  readonly taskRisk: RiskLevel;
  /** 工具自身风险标记（工具 metadata）。 */
  readonly toolRisk?: RiskLevel;
  /** 涉及对外承诺（发邮件/提交工单/发布等）。 */
  readonly outboundCommitment?: boolean;
  /** 涉及敏感数据（PII/凭证/财务记录等）。 */
  readonly sensitiveData?: boolean;
  /** 涉及资金动作（支付/退款/转账）。 */
  readonly funds?: boolean;
  /** 不可逆操作（删除/发布/不可撤销）。 */
  readonly irreversible?: boolean;
  /** 工具权限要求二次确认（permission.requireConfirmation）。 */
  readonly requireConfirmation?: boolean;
}

/** 风险评估结果。 */
export interface RiskAssessment {
  readonly effectiveRisk: RiskLevel;
  /** 是否必须人类审批（上级 persona 批准不充分）。 */
  readonly requiresHuman: boolean;
  /** 可解释依据（哪些信号把风险顶上去）。 */
  readonly rationale: string;
}

/** 取两个风险的较高者。 */
function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/**
 * 确定性计算有效风险 + 是否必须人类审批（铁律1：只升不降）。
 * 任一「对外/敏感/资金/不可逆」命中 → 强制 high + requiresHuman（不可被 medium 降级）。
 */
export function assessExecutionRisk(signals: ExecutionRiskSignals): RiskAssessment {
  /* 硬升级信号：命中任一 → 强制 high + 必须人类。 */
  const hardSignals: Array<[boolean | undefined, string]> = [
    [signals.outboundCommitment, '对外承诺'],
    [signals.sensitiveData, '敏感数据'],
    [signals.funds, '资金动作'],
    [signals.irreversible, '不可逆操作'],
  ];
  const hit = hardSignals.filter(([v]) => v === true).map(([, label]) => label);
  if (hit.length > 0) {
    return { effectiveRisk: 'high', requiresHuman: true, rationale: `命中硬风险（${hit.join('、')}）→ 强制 high，必须人类审批` };
  }

  /* 否则取 max(任务风险, 工具风险)；requireConfirmation 至少顶到 medium。 */
  let risk = maxRisk(signals.taskRisk, signals.toolRisk ?? 'low');
  if (signals.requireConfirmation) risk = maxRisk(risk, 'medium');

  /* high → 必须人类；medium/low 不强制人类（medium 可上级 worker 审批，由 router 决定）。 */
  return {
    effectiveRisk: risk,
    requiresHuman: risk === 'high',
    rationale: risk === 'high' ? '有效风险 high → 必须人类审批'
      : risk === 'medium' ? '有效风险 medium → 需组织内审批'
        : '有效风险 low → 无需审批',
  };
}

/** 审批路由结果：要不要审批、谁能批。 */
export type ApprovalRoute =
  | { readonly kind: 'no_approval' }                               /* low：直接放行 */
  | { readonly kind: 'org_or_human' }                              /* medium：上级 worker 或人类（默认人类）*/
  | { readonly kind: 'human_only' };                               /* high/敏感等：必须人类 */

/**
 * 按风险评估 + enterprise policy 决定审批路由（确定性）。
 * @param allowWorkerApproval enterprise policy 是否允许上级数字员工审批 medium（默认 false=人类）。
 */
export function routeApproval(assessment: RiskAssessment, allowWorkerApproval: boolean): ApprovalRoute {
  if (assessment.requiresHuman) return { kind: 'human_only' };
  if (assessment.effectiveRisk === 'low') return { kind: 'no_approval' };
  /* medium：policy 开了 worker 审批 → org_or_human，否则仍只人类。 */
  return allowWorkerApproval ? { kind: 'org_or_human' } : { kind: 'human_only' };
}
