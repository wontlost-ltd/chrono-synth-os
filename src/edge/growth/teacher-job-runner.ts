/**
 * Teacher job 运行器（ADR-0052 Edge-P4）— 联网时批量消费离线成长队列。
 *
 * 论点红线：
 *   - teacher（注入函数：可包 LlmReflectionDistiller / PerceptionDistiller / knowledge ingestion）
 *     **只在本 runner 显式调用**（联网/成长阶段），**绝不在 runtime sense / 决策路径**调。
 *   - teacher 输出走蒸馏门（由 teacher 函数内部负责，本 runner 不碰身份核），不直接改核。
 *   - **失败隔离**：一个 job 的 teacher 失败标 failed 不抛、不阻断其他 job——更不阻断 runtime
 *     离线自治（Edge 设备 teacher 不可用时人格仍用确定性核运行）。
 *
 * 纯编排、确定性（给定同 teacher 行为 + 同队列 → 同结果）。
 */

import type { Logger } from '../../utils/logger.js';
import type { GrowthJob, GrowthJobQueue } from './growth-queue.js';

/** teacher 函数：跑一个成长 job，产出（蒸馏候选数等）摘要。失败应抛错（由 runner 隔离）。 */
export type TeacherFn = (job: GrowthJob) => Promise<TeacherOutcome>;

export interface TeacherOutcome {
  /** 本 job 产出的蒸馏候选数（仅统计；候选已由 teacher 交蒸馏门）。 */
  readonly candidatesIngested: number;
}

export interface RunSummary {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly totalCandidates: number;
}

export class TeacherJobRunner {
  constructor(
    private readonly queue: GrowthJobQueue,
    private readonly teacher: TeacherFn,
    private readonly logger?: Logger,
  ) {}

  /**
   * 消费当前所有 pending jobs（快照——本轮新入队的不在内）。每个 job 独立跑 teacher，失败隔离。
   * 返回汇总。**绝不在 runtime 路径调用本方法**——只在联网/成长阶段。
   */
  async runPending(): Promise<RunSummary> {
    const jobs = this.queue.pending();
    let succeeded = 0;
    let failed = 0;
    let totalCandidates = 0;

    for (const job of jobs) {
      this.queue.markRunning(job.id);
      try {
        const outcome = await this.teacher(job);
        /* 校验 teacher outcome：非有限非负 candidatesIngested 视为畸形（teacher 不可信）→ 当失败处理，
         * 不污染 summary。 */
        const n = outcome?.candidatesIngested;
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
          throw new Error(`teacher 返回畸形 candidatesIngested: ${String(n)}`);
        }
        this.queue.markDone(job.id);
        succeeded++;
        totalCandidates += n;
        this.safeLog('info', `job ${job.id}(${job.kind}) done，候选 ${n}`);
      } catch (err) {
        /* 失败隔离：标 failed，不抛、不中断后续 job、不影响 runtime。 */
        const reason = err instanceof Error ? err.message : String(err);
        this.queue.markFailed(job.id, reason);
        failed++;
        this.safeLog('warn', `job ${job.id}(${job.kind}) 失败（隔离）: ${reason}`);
      }
    }

    return { attempted: jobs.length, succeeded, failed, totalCandidates };
  }

  /** logger 隔离：logger 抛错绝不破坏 job 失败隔离（否则 logger 失败会阻断 runtime 自治）。 */
  private safeLog(level: 'info' | 'warn', msg: string): void {
    try {
      this.logger?.[level]('TeacherJobRunner', msg);
    } catch {
      /* 吞掉 logger 自身错误——日志失败不能破坏失败隔离不变量。 */
    }
  }
}
