/**
 * 组织经验蒸馏（M3）——把组织执行经验**确定性**地凝练成「playbook 改进候选」，零-LLM 运行时。
 *
 * 蓝图 M3：数字员工稳定变强 = 离线蒸馏，非运行时推理（ADR-0047 铁律）。本切片做闭环的**确定性那一半**：
 *   组织执行历史（完成/返工/升级/逾期）→ 确定性度量 → 经蒸馏门 → 产出**改进候选**（指出当前规则包哪个
 *   环节弱 + 确定性推荐的调整方向）。
 *
 * 关键红线：本 service **不生成新 playbook 规则**（那是离线 LLM 编译的事，经蒸馏门后 register 更高 version）。
 * 它只做可信的、可复现的**度量 + 门控 + 方向建议**——相同执行历史 → 相同候选（无 LLM/随机/时钟依赖，
 * 度量从落库数据算）。这样既证明「数字员工能从经验变强」，又不破坏零-LLM 运行时。
 */

import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgTask } from './types.js';
import { getDecompositionPlaybook } from './decomposition-playbook.js';

/** 蒸馏门：样本不足/无显著弱点 → 不产候选（不无中生有改规则）。 */
const MIN_SAMPLE_GOALS = 5;          /* 样本目标数下限（统计意义） */
const REWORK_RATE_THRESHOLD = 0.25;  /* 返工率（被 reject 的任务占比）**达到或超过**即弱点（>=） */
const ESCALATION_RATE_THRESHOLD = 0.3; /* 升级率（产生过升级的目标占比，>=） */
const OVERDUE_RATE_THRESHOLD = 0.3;  /* 逾期率（含逾期任务的占比，>=） */

/** 一个环节（taskType）的确定性度量。 */
export interface StageMetric {
  readonly taskType: string;
  readonly sampleTasks: number;
  readonly reworkRate: number;   /* rejected / total */
  /** 逾期占比：**仍在手**（非 approved/rejected）且最后活动(updatedAt)晚于 due_at 的任务占比（不引入运行时 now，纯函数）。 */
  readonly overdueRate: number;
}

/** 改进方向（确定性推荐，非 LLM）：弱点 → 调整哪类规则字段。 */
export type ImprovementDirection =
  | 'tighten_acceptance_criteria'  /* 返工高 → 验收标准应更明确 */
  | 'relax_sla'                    /* 逾期高 → SLA 时限可能过紧 */
  | 'add_escalation_path'          /* 升级率高 → 该环节需更顺畅的升级/资源 */
  | 'split_stage';                 /* 单环节返工+逾期双高 → 拆分该环节 */

/** 一条 playbook 改进候选（经蒸馏门产出，喂给离线编译生成更高 version）。 */
export interface PlaybookDistillationCandidate {
  readonly goalType: string;
  /** 基于哪个 playbook 版本的经验（候选是针对这个版本的改进）。 */
  readonly basedOnVersion: number;
  /** 建议的新版本号（basedOnVersion + 1）。 */
  readonly proposedVersion: number;
  readonly sampleGoals: number;
  /** 命中的弱点环节 + 确定性推荐方向。 */
  readonly weaknesses: readonly { readonly taskType: string; readonly direction: ImprovementDirection; readonly rationale: string }[];
  readonly stageMetrics: readonly StageMetric[];
}

/** 蒸馏结果：要么产出候选，要么说明为何不产（样本不足/无显著弱点）。 */
export type DistillPlaybookResult =
  | { readonly kind: 'candidate'; readonly candidate: PlaybookDistillationCandidate }
  | { readonly kind: 'insufficient_samples'; readonly sampleGoals: number; readonly required: number }
  | { readonly kind: 'no_weakness'; readonly sampleGoals: number; readonly stageMetrics: readonly StageMetric[] };

export class PlaybookDistiller {
  constructor(private readonly store: OrgWorkforceStore) {}

  /**
   * 蒸馏某 goalType 的执行经验为改进候选（确定性）。只看**当前激活版本**产生的目标样本。
   * 无 playbook / 样本不足 / 无显著弱点 → 不产候选（诚实，不无中生有）。
   */
  distill(orgId: string, goalType: string): DistillPlaybookResult {
    const playbook = getDecompositionPlaybook(goalType);
    if (!playbook) {
      return { kind: 'insufficient_samples', sampleGoals: 0, required: MIN_SAMPLE_GOALS };
    }
    const version = playbook.version;
    const goals = this.store.listGoalsByTypeAndVersion(orgId, goalType, version);
    if (goals.length < MIN_SAMPLE_GOALS) {
      return { kind: 'insufficient_samples', sampleGoals: goals.length, required: MIN_SAMPLE_GOALS };
    }

    /* 逐 goal 收集任务 + 升级；按 taskType 聚合返工/逾期。确定性：只读落库数据。 */
    const byStage = new Map<string, { total: number; rejected: number; overdue: number }>();
    let goalsWithEscalation = 0;
    for (const goal of goals) {
      const tasks = this.store.listTasksByGoal(orgId, goal.id);
      let goalHasEscalation = false;
      for (const t of tasks) {
        const s = byStage.get(t.taskType) ?? { total: 0, rejected: 0, overdue: 0 };
        s.total++;
        if (t.status === 'rejected') s.rejected++;
        if (this.isOverdue(t)) s.overdue++;
        byStage.set(t.taskType, s);
        /* 该任务有升级 → 记 goal 升级。 */
        if (this.store.listEscalationsByTask(orgId, t.id).length > 0) goalHasEscalation = true;
      }
      if (goalHasEscalation) goalsWithEscalation++;
    }

    const stageMetrics: StageMetric[] = [...byStage.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([taskType, s]) => ({
        taskType, sampleTasks: s.total,
        reworkRate: s.total > 0 ? s.rejected / s.total : 0,
        overdueRate: s.total > 0 ? s.overdue / s.total : 0,
      }));

    const escalationRate = goals.length > 0 ? goalsWithEscalation / goals.length : 0;

    /* 确定性弱点判定 + 方向映射（无 LLM）。逾期弱点由 stage 级 overdueRate 给出（更精确到环节），
     * goal 级 goalsWithOverdue 仅作可观测不重复进弱点。 */
    const weaknesses = this.deriveWeaknesses(stageMetrics, escalationRate);
    if (weaknesses.length === 0) {
      return { kind: 'no_weakness', sampleGoals: goals.length, stageMetrics };
    }
    return {
      kind: 'candidate',
      candidate: {
        goalType, basedOnVersion: version, proposedVersion: version + 1,
        sampleGoals: goals.length, weaknesses, stageMetrics,
      },
    };
  }

  /** 任务是否逾期：有 due_at 且（已离手但完成晚于 due_at 无从精确判，故只判**仍在手且 due_at 已过**——确定性近似）。 */
  private isOverdue(t: OrgTask): boolean {
    if (t.dueAt === null) return false;
    /* 仍在手(未 approved)且更新时刻晚于 due_at（最后一次活动已过截止）→ 视为逾期。
     * 不引入运行时 now（保持纯函数确定性）；用 updatedAt 作该任务最后已知时间。 */
    const stillOpen = t.status !== 'approved' && t.status !== 'rejected';
    return stillOpen && t.updatedAt > t.dueAt;
  }

  /** 确定性把度量映射成弱点 + 改进方向（规则表，非 LLM）。 */
  private deriveWeaknesses(
    stageMetrics: readonly StageMetric[], escalationRate: number,
  ): PlaybookDistillationCandidate['weaknesses'] {
    const out: { taskType: string; direction: ImprovementDirection; rationale: string }[] = [];
    for (const m of stageMetrics) {
      const highRework = m.reworkRate >= REWORK_RATE_THRESHOLD;
      const highOverdue = m.overdueRate >= OVERDUE_RATE_THRESHOLD;
      if (highRework && highOverdue) {
        out.push({ taskType: m.taskType, direction: 'split_stage', rationale: `返工率 ${pct(m.reworkRate)} + 逾期率 ${pct(m.overdueRate)} 双高，建议拆分该环节` });
      } else if (highRework) {
        out.push({ taskType: m.taskType, direction: 'tighten_acceptance_criteria', rationale: `返工率 ${pct(m.reworkRate)} 偏高，建议明确验收标准` });
      } else if (highOverdue) {
        out.push({ taskType: m.taskType, direction: 'relax_sla', rationale: `逾期率 ${pct(m.overdueRate)} 偏高，建议放宽 SLA` });
      }
    }
    /* goal 级升级率高 → 整体需更顺畅升级路径（挂到样本最多的环节作锚）。 */
    if (escalationRate >= ESCALATION_RATE_THRESHOLD && stageMetrics.length > 0) {
      /* 锚点 = 样本最多的环节；并列时按 taskType 字典序兜底（显式 tie-breaker，不依赖 sort 稳定性）。 */
      const anchor = [...stageMetrics].sort((a, b) => b.sampleTasks - a.sampleTasks || a.taskType.localeCompare(b.taskType))[0]!;
      out.push({ taskType: anchor.taskType, direction: 'add_escalation_path', rationale: `目标升级率 ${pct(escalationRate)} 偏高，建议补强升级路径` });
    }
    /* 去重（同 taskType 同 direction 只留一条）+ 确定性排序。 */
    const seen = new Set<string>();
    return out
      .filter((w) => { const k = `${w.taskType}|${w.direction}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (a.taskType < b.taskType ? -1 : a.taskType > b.taskType ? 1 : a.direction < b.direction ? -1 : 1));
  }
}

/** 百分比格式化（确定性，无浮点漂移展示）。 */
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
