/**
 * 同步 outbox（ADR-0052 Edge-P3）— 端侧本地变更的待同步队列。
 *
 * 端侧离线时产生的变更（记忆 append、环境观测、价值更新候选）先入本地 outbox，联网时按序上送云端。
 * 每条 entry 带 `deviceId` + 单调 `seq` —— 这是冲突解决的去重锚点（同 device 的同 seq 是同一变更，
 * 多设备合并时据此天然去重）。纯确定性、零依赖。
 */

/** 变更类别（决定冲突解决策略，见 conflict.ts）。 */
export type ChangeClass = 'fact' | 'projection' | 'identity';

/**
 * 从 opKind 推导变更类别（防误标护栏）。身份核（value/narrative/decision-style/cognitive/
 * rule/template）→ identity（绝不自动应用）；派生读模型 → projection；其余（记忆/环境观测）→ fact。
 * 这是「身份核绝不 last-write-wins」的纵深防御：即便调用方误把 value.update 标成 fact，enqueue
 * 也会用 opKind 推导拦截不一致。
 */
export function classifyOpKind(opKind: string): ChangeClass {
  if (/^(value|narrative|decision-style|cognitive-model|rule|response-template)\./.test(opKind)) return 'identity';
  if (/^projection\./.test(opKind)) return 'projection';
  return 'fact';
}

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

  /**
   * 入队一条本地变更，分配单调 seq。返回该 entry（拷贝，不暴露内部 live reference）。
   * **防误标护栏**：传入 changeClass 必须与 opKind 推导一致——否则抛错（防身份核被误标成 fact
   * 而绕过 pending）。这是「身份核绝不自动应用」的纵深防御。
   */
  enqueue(changeClass: ChangeClass, opKind: string, payload: Record<string, unknown>, at: number): OutboxEntry {
    const derived = classifyOpKind(opKind);
    if (derived !== changeClass) {
      throw new Error(`outbox enqueue: opKind「${opKind}」推导类别 ${derived} 与传入 ${changeClass} 不一致（防身份核误标）`);
    }
    const entry: OutboxEntry = {
      deviceId: this.deviceId,
      seq: this.nextSeq++,
      changeClass,
      opKind,
      payload: { ...payload },
      at,
      synced: false,
    };
    this.entries.push(entry);
    return { ...entry, payload: { ...entry.payload } };
  }

  /** 待同步（未 synced）的变更拷贝，按 seq 升序（不暴露 live reference）。 */
  pending(): readonly OutboxEntry[] {
    return this.entries.filter((e) => !e.synced).map(cloneEntry);
  }

  /** 标记某 seq 已上送。 */
  markSynced(seq: number): boolean {
    const e = this.entries.find((x) => x.seq === seq);
    if (!e) return false;
    e.synced = true;
    return true;
  }

  /** 全部变更拷贝（含已同步），用于审计/回放。 */
  all(): readonly OutboxEntry[] {
    return this.entries.map(cloneEntry);
  }

  /** 序列化（与 UoW 一起落盘）。 */
  serialize(): string {
    return JSON.stringify({ deviceId: this.deviceId, nextSeq: this.nextSeq, entries: this.entries });
  }

  /**
   * 从序列化恢复（落盘重载）。**保留 nextSeq** 使 seq 续接——否则重启后从 1 起会破坏
   * (deviceId, seq) 去重锚点（同一变更被当成新变更）。畸形输入抛错。
   */
  static fromSerialized(serialized: string): SyncOutbox {
    const parsed = JSON.parse(serialized) as { deviceId?: unknown; nextSeq?: unknown; entries?: unknown };
    if (typeof parsed.deviceId !== 'string' || typeof parsed.nextSeq !== 'number' || !Array.isArray(parsed.entries)) {
      throw new Error('SyncOutbox.fromSerialized: 畸形序列化数据');
    }
    const ob = new SyncOutbox(parsed.deviceId);
    ob.nextSeq = parsed.nextSeq;
    for (const e of parsed.entries as OutboxEntry[]) ob.entries.push(cloneEntry(e));
    return ob;
  }
}

/** 深拷贝一条 entry（payload 也拷贝），防 live reference 外泄。 */
function cloneEntry(e: OutboxEntry): OutboxEntry {
  return { ...e, payload: { ...e.payload } };
}
