/**
 * 数字员工运行信号 service（C0：enterprise 类人化隔离地基）。
 *
 * 蓝图铁律：类人化「信号」是 B 端资产，类人化「表演」是负债。本 service 把 companion 的类人化能力
 * **翻译成企业运营语言**，且**完全不走 companion 路径**（不碰 /companion/chat、不用 COMPANION_PERSONA_ID
 * ='default'、不复用 companion relationship 表——那会在多用户/多员工间串味，串味修复留 C1）。
 *
 * C0 提供第一个安全信号：**worker 运行健康/负载**（companion 的 mood→B 端 agent health，绝不叫「心情」）。
 * 纯确定性、零-LLM——从该 worker 在 org_tasks 的任务派生，相同任务状态 → 相同信号。per-(org, worker)
 * 作用域，天然无串味（信号属于 worker 自己，不属于「某个对手方」）。
 */

import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgTask } from './types.js';

/** worker 运行信号（B 端运营视图，非「心情」）。 */
export interface WorkerOperatingSignal {
  readonly workerId: string;
  /** 当前在手任务数（已委派/进行中/已提交未审）。 */
  readonly activeTaskCount: number;
  /** 已交付（approved/submitted）任务数。 */
  readonly deliveredTaskCount: number;
  /** 阻塞任务数（blocked）。 */
  readonly blockedTaskCount: number;
  /** 高风险在手任务数（riskLevel=high）。 */
  readonly highRiskTaskCount: number;
  /** 在手且**已逾期**（dueAt < now）的任务数（SLA 信号，C 链时间感知）。 */
  readonly overdueTaskCount: number;
  /** 在手且**临近截止**（now ≤ dueAt < now + DUE_SOON_WINDOW）的任务数。 */
  readonly dueSoonTaskCount: number;
  /**
   * 负载等级（确定性派生）：idle（无在手）/ normal / heavy（在手多或有高风险/阻塞/逾期）。
   * 管理者据此知道哪个 worker 需要关注/复核/再分配。
   */
  readonly load: 'idle' | 'normal' | 'heavy';
  /**
   * 是否需要人工关注（确定性）：有阻塞 或 有高风险在手 或**有逾期** → true。这是「健康度」信号，不是情绪。
   */
  readonly needsAttention: boolean;
}

/** 在手（未完成）状态集合。 */
const ACTIVE_STATUSES: ReadonlySet<OrgTask['status']> = new Set(['delegated', 'in_progress', 'submitted']);
/** 已交付状态集合。 */
const DELIVERED_STATUSES: ReadonlySet<OrgTask['status']> = new Set(['submitted', 'approved']);
/** 负载判 heavy 的在手任务阈值。 */
const HEAVY_ACTIVE_THRESHOLD = 4;
/** 「临近截止」窗口（24h 内未到期算 due_soon）。确定性常量。 */
const DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

export class WorkerSignalsService {
  /**
   * @param now 时钟（C 链 SLA 时间感知用：据 now 与任务 due_at 算 overdue/due_soon）。
   *   缺省 0：无截止判定（旧调用方不传时不报逾期，保持向后兼容——但应传真实时钟才有 SLA 信号）。
   */
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly now: () => number = () => 0,
  ) {}

  /**
   * 算一个 worker 的运行信号（确定性，零-LLM）。worker 不存在 → undefined。
   * 信号只读 org_tasks（worker 自己的任务），不碰 companion 任何东西，per-(org, worker) 无串味。
   * SLA：据 now 与在手任务 due_at 确定性派生 overdue/due_soon（now=0 时不报，向后兼容）。
   */
  getOperatingSignal(orgId: string, workerId: string): WorkerOperatingSignal | undefined {
    if (!this.store.getWorker(orgId, workerId)) return undefined;
    const tasks = this.store.listTasksByAssignee(orgId, workerId);
    const nowMs = this.now();

    let activeTaskCount = 0;
    let deliveredTaskCount = 0;
    let blockedTaskCount = 0;
    let highRiskActive = 0;
    let overdueTaskCount = 0;
    let dueSoonTaskCount = 0;
    for (const t of tasks) {
      if (ACTIVE_STATUSES.has(t.status)) {
        activeTaskCount++;
        if (t.riskLevel === 'high') highRiskActive++;
        /* SLA 时间感知（仅在手任务、有截止、有真实时钟才判）：逾期 / 临近。 */
        if (t.dueAt !== null && nowMs > 0) {
          if (t.dueAt < nowMs) overdueTaskCount++;
          else if (t.dueAt < nowMs + DUE_SOON_WINDOW_MS) dueSoonTaskCount++;
        }
      }
      if (DELIVERED_STATUSES.has(t.status)) deliveredTaskCount++;
      if (t.status === 'blocked') blockedTaskCount++;
    }

    const needsAttention = blockedTaskCount > 0 || highRiskActive > 0 || overdueTaskCount > 0;
    const load: WorkerOperatingSignal['load'] =
      activeTaskCount === 0 ? 'idle'
        : (activeTaskCount >= HEAVY_ACTIVE_THRESHOLD || needsAttention) ? 'heavy'
          : 'normal';

    return {
      workerId,
      activeTaskCount,
      deliveredTaskCount,
      blockedTaskCount,
      highRiskTaskCount: highRiskActive,
      overdueTaskCount,
      dueSoonTaskCount,
      load,
      needsAttention,
    };
  }
}
