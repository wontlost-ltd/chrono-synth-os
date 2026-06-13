/**
 * 同步 outbox（ADR-0052 Edge-P3）— 端侧本地变更的待同步队列。
 *
 * 端侧离线时产生的变更（记忆 append、环境观测、价值更新候选）先入本地 outbox，联网时按序上送云端。
 * 每条 entry 带 `deviceId` + 单调 `seq` —— 这是冲突解决的去重锚点（同 device 的同 seq 是同一变更，
 * 多设备合并时据此天然去重）。纯确定性、零依赖。
 */

/** 变更类别（决定冲突解决策略，见 conflict.ts）。 */
export type ChangeClass = 'fact' | 'projection' | 'identity';

/** 一条待同步变更。 */
export interface OutboxEntry {
  /** 设备标识（多设备去重/冲突锚点）。 */
  readonly deviceId: string;
  /** 本设备单调序号（从 1 起递增）。 */
  readonly seq: number;
  /** 变更类别。 */
  readonly changeClass: ChangeClass;
  /** 变更操作 kind（如 'memory.append' / 'value.update'）。 */
  readonly opKind: string;
  /** 变更载荷（已序列化的领域数据）。 */
  readonly payload: Record<string, unknown>;
  /** 端侧产生时刻（epoch ms）。 */
  readonly at: number;
  /** 是否已上送云端。 */
  synced: boolean;
}

export class SyncOutbox {
  private readonly entries: OutboxEntry[] = [];
  private nextSeq = 1;

  constructor(private readonly deviceId: string) {}

  /** 入队一条本地变更，分配单调 seq。返回该 entry。 */
  enqueue(changeClass: ChangeClass, opKind: string, payload: Record<string, unknown>, at: number): OutboxEntry {
    const entry: OutboxEntry = {
      deviceId: this.deviceId,
      seq: this.nextSeq++,
      changeClass,
      opKind,
      payload,
      at,
      synced: false,
    };
    this.entries.push(entry);
    return entry;
  }

  /** 待同步（未 synced）的变更，按 seq 升序。 */
  pending(): readonly OutboxEntry[] {
    return this.entries.filter((e) => !e.synced);
  }

  /** 标记某 seq 已上送。 */
  markSynced(seq: number): boolean {
    const e = this.entries.find((x) => x.seq === seq);
    if (!e) return false;
    e.synced = true;
    return true;
  }

  /** 全部变更（含已同步），用于审计/回放。 */
  all(): readonly OutboxEntry[] {
    return [...this.entries];
  }

  /** 序列化（与 UoW 一起落盘）。 */
  serialize(): string {
    return JSON.stringify({ deviceId: this.deviceId, nextSeq: this.nextSeq, entries: this.entries });
  }
}
