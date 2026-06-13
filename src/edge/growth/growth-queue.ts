/**
 * 离线成长队列（ADR-0052 Edge-P4）— 端侧离线时积累的「成长素材」，联网时交 teacher 跑 job。
 *
 * 论点（与 ADR-0047/0051/0052 一致）：teacher（LLM/多模态/感知 distiller）**只在联网+成长阶段**
 * 跑，绝不进 runtime sense。Edge 设备离线时人格用确定性核运行；离线积累的成长素材（待反思的
 * 记忆、待感知的媒体引用）先入本队列，联网时 TeacherJobRunner 批量消费 → 蒸馏候选 → 蒸馏门。
 *
 * 纯确定性、零依赖、可序列化（复用 Edge-P3 持久化落盘）。
 */

/** 成长 job 状态。 */
export type GrowthJobStatus = 'pending' | 'running' | 'done' | 'failed';

/** 成长 job 类别（决定交给哪个 teacher）。 */
export type GrowthJobKind = 'reflection' | 'perception' | 'knowledge';

/** 一个待跑的成长 job。 */
export interface GrowthJob {
  readonly id: string;
  readonly kind: GrowthJobKind;
  /** 成长素材载荷（如记忆 id 列表、媒体引用）。 */
  readonly payload: Record<string, unknown>;
  /** 入队时刻（epoch ms）。 */
  readonly enqueuedAt: number;
  status: GrowthJobStatus;
  /** 失败原因（failed 时）。 */
  failureReason?: string;
  /** 重试次数。 */
  attempts: number;
}

export class GrowthJobQueue {
  private readonly jobs: GrowthJob[] = [];
  private seq = 0;

  /** 入队一个成长 job（离线积累）。返回 job 拷贝。 */
  enqueue(kind: GrowthJobKind, payload: Record<string, unknown>, now: number): GrowthJob {
    const job: GrowthJob = {
      id: `gjob_${this.seq++}`,
      kind,
      payload: deepClone(payload),
      enqueuedAt: now,
      status: 'pending',
      attempts: 0,
    };
    this.jobs.push(job);
    return cloneJob(job);
  }

  /** 待跑（pending）jobs 拷贝，按入队序。 */
  pending(): readonly GrowthJob[] {
    return this.jobs.filter((j) => j.status === 'pending').map(cloneJob);
  }

  /** 标记 running。 */
  markRunning(id: string): boolean {
    return this.transition(id, 'running');
  }

  /** 标记完成。 */
  markDone(id: string): boolean {
    return this.transition(id, 'done');
  }

  /** 标记失败（记录原因 + 累加 attempts）。失败的 job 不阻断其他 job。 */
  markFailed(id: string, reason: string): boolean {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return false;
    j.status = 'failed';
    j.failureReason = reason;
    j.attempts++;
    return true;
  }

  /** 把 failed job 重置为 pending（联网重试）。 */
  retry(id: string): boolean {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || j.status !== 'failed') return false;
    j.status = 'pending';
    return true;
  }

  /** 全部 jobs 拷贝（审计/回放）。 */
  all(): readonly GrowthJob[] {
    return this.jobs.map(cloneJob);
  }

  /** 序列化落盘（离线持久化）。 */
  serialize(): string {
    return JSON.stringify({ seq: this.seq, jobs: this.jobs });
  }

  private transition(id: string, to: GrowthJobStatus): boolean {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return false;
    j.status = to;
    if (to === 'running') j.attempts++;
    return true;
  }

  /** 从序列化恢复。 */
  static fromSerialized(serialized: string): GrowthJobQueue {
    const parsed = JSON.parse(serialized) as { seq?: unknown; jobs?: unknown };
    if (typeof parsed.seq !== 'number' || !Number.isInteger(parsed.seq) || parsed.seq < 0 || !Array.isArray(parsed.jobs)) {
      throw new Error('GrowthJobQueue.fromSerialized: 畸形序列化数据');
    }
    const q = new GrowthJobQueue();
    q.seq = parsed.seq;
    for (const raw of parsed.jobs) q.jobs.push(validateJob(raw));
    return q;
  }
}

const VALID_KINDS: ReadonlySet<string> = new Set(['reflection', 'perception', 'knowledge']);
const VALID_STATUS: ReadonlySet<string> = new Set(['pending', 'running', 'done', 'failed']);

function validateJob(raw: unknown): GrowthJob {
  if (raw === null || typeof raw !== 'object') throw new Error('GrowthJobQueue: job 非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) throw new Error('GrowthJobQueue: job id 缺失');
  if (!VALID_KINDS.has(r.kind as string)) throw new Error('GrowthJobQueue: job kind 非法');
  if (!VALID_STATUS.has(r.status as string)) throw new Error('GrowthJobQueue: job status 非法');
  if (r.payload === null || typeof r.payload !== 'object') throw new Error('GrowthJobQueue: job payload 非对象');
  if (typeof r.enqueuedAt !== 'number' || !Number.isFinite(r.enqueuedAt)) throw new Error('GrowthJobQueue: enqueuedAt 非有限数');
  if (typeof r.attempts !== 'number' || !Number.isInteger(r.attempts) || r.attempts < 0) throw new Error('GrowthJobQueue: attempts 非法');
  return {
    id: r.id, kind: r.kind as GrowthJobKind, payload: deepClone(r.payload as Record<string, unknown>),
    enqueuedAt: r.enqueuedAt, status: r.status as GrowthJobStatus,
    failureReason: typeof r.failureReason === 'string' ? r.failureReason : undefined,
    attempts: r.attempts,
  };
}

function cloneJob(j: GrowthJob): GrowthJob {
  return { ...j, payload: deepClone(j.payload) };
}

function deepClone(o: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
}
