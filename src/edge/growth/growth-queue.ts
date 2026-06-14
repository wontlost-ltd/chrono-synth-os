/**
 * 离线成长队列（ADR-0052 Edge-P4）— 端侧离线时积累的「成长素材」，联网时交 teacher 跑 job。
 *
 * 论点（与 ADR-0047/0051/0052 一致）：teacher（LLM/多模态/感知 distiller）**只在联网+成长阶段**
 * 跑，绝不进 runtime sense。Edge 设备离线时人格用确定性核运行；离线积累的成长素材（待反思的
 * 记忆、待感知的媒体引用）先入本队列，联网时 TeacherJobRunner 批量消费 → 蒸馏候选 → 蒸馏门。
 *
 * 纯确定性、零依赖、可序列化（复用 Edge-P3 持久化落盘）。
 */

import { cloneJsonObject } from '../json-clone.js';

/** growth-queue 序列化格式版本（前向兼容；不兼容变更须升版本 + 迁移）。 */
const GROWTH_QUEUE_SCHEMA_VERSION = 1;

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

  /** 标记 running（仅 pending→running 合法）。进入 running 即一次尝试 → attempts+1；清旧失败原因。 */
  markRunning(id: string): boolean {
    const j = this.find(id, 'pending');
    if (!j) return false;
    j.status = 'running';
    j.attempts++;   /* attempts = 进入 running 的次数 = 真实尝试次数（markFailed 不再重复 +1）。 */
    j.failureReason = undefined;   /* 重跑清旧失败原因（避免 done/重试后残留 stale reason）。 */
    return true;
  }

  /** 标记完成（仅 running→done 合法）。 */
  markDone(id: string): boolean {
    const j = this.find(id, 'running');
    if (!j) return false;
    j.status = 'done';
    return true;
  }

  /** 标记失败（仅 running→failed 合法）。记录原因；**不重复加 attempts**（markRunning 已加）。 */
  markFailed(id: string, reason: string): boolean {
    const j = this.find(id, 'running');
    if (!j) return false;
    j.status = 'failed';
    j.failureReason = reason;
    return true;
  }

  /** 把 failed job 重置为 pending（联网重试，仅 failed→pending 合法）。 */
  retry(id: string): boolean {
    const j = this.find(id, 'failed');
    if (!j) return false;
    j.status = 'pending';
    return true;
  }

  /** 全部 jobs 拷贝（审计/回放）。 */
  all(): readonly GrowthJob[] {
    return this.jobs.map(cloneJob);
  }

  /** 序列化落盘（离线持久化）。带 schemaVersion 供未来格式演进兼容。 */
  serialize(): string {
    return JSON.stringify({ schemaVersion: GROWTH_QUEUE_SCHEMA_VERSION, seq: this.seq, jobs: this.jobs });
  }

  /** 查找指定 id 且处于 requiredStatus 的 job（from-state 校验，挡非法转移）。 */
  private find(id: string, requiredStatus: GrowthJobStatus): GrowthJob | undefined {
    const j = this.jobs.find((x) => x.id === id);
    return j && j.status === requiredStatus ? j : undefined;
  }

  /**
   * 从序列化恢复。**完整校验**（Codex Edge-P4 复审）：逐条 validateJob + id 唯一 +
   * seq 必须大于已恢复 job 的最大 gjob_N 序号（否则新入队 id 会与旧重复）。
   */
  static fromSerialized(serialized: string): GrowthJobQueue {
    const parsed = JSON.parse(serialized) as { schemaVersion?: unknown; seq?: unknown; jobs?: unknown };
    const version = parsed.schemaVersion ?? 1;   /* 缺省视为 v1（向后兼容早期无版本落盘）。 */
    if (version !== GROWTH_QUEUE_SCHEMA_VERSION) {
      throw new Error(`GrowthJobQueue.fromSerialized: 不支持的 schemaVersion ${String(version)}（期望 ${GROWTH_QUEUE_SCHEMA_VERSION}）`);
    }
    if (typeof parsed.seq !== 'number' || !Number.isInteger(parsed.seq) || parsed.seq < 0 || !Array.isArray(parsed.jobs)) {
      throw new Error('GrowthJobQueue.fromSerialized: 畸形序列化数据');
    }
    const q = new GrowthJobQueue();
    const seenIds = new Set<string>();
    let maxIdSeq = -1;
    for (const raw of parsed.jobs) {
      const job = validateJob(raw);
      if (seenIds.has(job.id)) throw new Error(`GrowthJobQueue.fromSerialized: job id 重复 ${job.id}`);
      seenIds.add(job.id);
      const idSeq = parseJobIdSeq(job.id);
      if (idSeq !== undefined) maxIdSeq = Math.max(maxIdSeq, idSeq);
      q.jobs.push(job);
    }
    if (parsed.seq <= maxIdSeq) {
      throw new Error(`GrowthJobQueue.fromSerialized: seq(${parsed.seq}) 必须大于已有 job 最大序号(${maxIdSeq})`);
    }
    q.seq = parsed.seq;
    return q;
  }
}

/** 从 'gjob_N' 解析序号 N；非此格式返回 undefined。 */
function parseJobIdSeq(id: string): number | undefined {
  const m = /^gjob_(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
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

/* deepClone 复用 edge 本地共享 util（收口审查）。 */
const deepClone = cloneJsonObject;
