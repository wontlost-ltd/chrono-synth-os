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
 * 身份核 op 前缀白名单（取证自 packages/kernel/src/domain/core-self/*-queries.ts 的真实 kind）。
 * **新增身份核域 op 必须登记此处**——否则会被误判 fact 而绕过 pending（Codex Edge-P3 复审：
 * 原用 'value.' 但真实 kernel kind 是 'core-value.'，导致护栏漏真实身份核 op）。
 * 同时覆盖蒸馏 artifact kind（value_shift 等若直接同步）。
 */
const IDENTITY_OP_PREFIXES: readonly string[] = [
  'core-value.',          /* 价值权重 */
  'survival-anchor.',     /* L0 生存锚 */
  'narrative.',           /* 叙事 */
  'decision-style.',      /* L2 决策风格 */
  'cognitive-model.',     /* L3 认知模型 */
  'personaRule.',         /* 规则 */
  'response-template.',   /* 回应模板 */
  'rt.',                  /* response-template 简写（若用） */
];
/** 蒸馏身份核 artifact kind（若直接作为 op 同步）。 */
const IDENTITY_ARTIFACT_KINDS: readonly string[] = [
  'value_shift', 'narrative_patch', 'decision_style_patch', 'cognitive_model_patch', 'response_template', 'rule',
];

/**
 * 从 opKind 推导变更类别（防误标护栏）。身份核（value/narrative/anchor/decision-style/cognitive/
 * rule/template）→ identity（绝不自动应用）；派生读模型 → projection；其余（记忆/环境观测）→ fact。
 * 这是「身份核绝不 last-write-wins」的纵深防御：即便调用方误把 core-value.update 标成 fact，
 * enqueue 也会用 opKind 推导拦截不一致。
 */
export function classifyOpKind(opKind: string): ChangeClass {
  if (IDENTITY_OP_PREFIXES.some((p) => opKind.startsWith(p)) || IDENTITY_ARTIFACT_KINDS.includes(opKind)) {
    return 'identity';
  }
  if (opKind.startsWith('projection.')) return 'projection';
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
   * (deviceId, seq) 去重锚点（同一变更被当成新变更）。
   *
   * **完整校验**（Codex Edge-P3 复审）：逐条校验 entry shape + changeClass 与 opKind 推导一致
   * （复用 enqueue 护栏，防坏落盘数据绕过身份核护栏）+ seq 正整数不重复 + nextSeq > max(seq)。
   * 任一不合法抛错，不构造出违反不变量的 outbox。
   */
  static fromSerialized(serialized: string): SyncOutbox {
    const parsed = JSON.parse(serialized) as { deviceId?: unknown; nextSeq?: unknown; entries?: unknown };
    if (typeof parsed.deviceId !== 'string' || typeof parsed.nextSeq !== 'number'
      || !Number.isInteger(parsed.nextSeq) || parsed.nextSeq < 1 || !Array.isArray(parsed.entries)) {
      throw new Error('SyncOutbox.fromSerialized: 畸形序列化顶层数据');
    }
    const ob = new SyncOutbox(parsed.deviceId);
    const seenSeq = new Set<number>();
    let maxSeq = 0;
    for (const raw of parsed.entries) {
      const e = validateEntry(raw, parsed.deviceId);
      if (seenSeq.has(e.seq)) throw new Error(`SyncOutbox.fromSerialized: seq 重复 ${e.seq}`);
      seenSeq.add(e.seq);
      maxSeq = Math.max(maxSeq, e.seq);
      ob.entries.push(e);
    }
    if (parsed.nextSeq <= maxSeq) {
      throw new Error(`SyncOutbox.fromSerialized: nextSeq(${parsed.nextSeq}) 必须大于 max(seq)(${maxSeq})`);
    }
    ob.nextSeq = parsed.nextSeq;
    return ob;
  }
}

/** 深拷贝一条 entry（payload 经 JSON round-trip 真深拷贝），防 live reference（含嵌套）外泄。 */
function cloneEntry(e: OutboxEntry): OutboxEntry {
  return { ...e, payload: JSON.parse(JSON.stringify(e.payload)) as Record<string, unknown> };
}

/** 校验并规范化一条落盘 entry：shape + changeClass 与 opKind 推导一致 + seq 正整数。 */
function validateEntry(raw: unknown, deviceId: string): OutboxEntry {
  if (raw === null || typeof raw !== 'object') throw new Error('SyncOutbox.fromSerialized: entry 非对象');
  const r = raw as Record<string, unknown>;
  if (r.deviceId !== deviceId) throw new Error(`SyncOutbox.fromSerialized: entry deviceId 不一致`);
  if (typeof r.seq !== 'number' || !Number.isInteger(r.seq) || r.seq < 1) throw new Error('SyncOutbox.fromSerialized: seq 非正整数');
  if (typeof r.opKind !== 'string' || r.opKind.length === 0) throw new Error('SyncOutbox.fromSerialized: opKind 缺失');
  if (r.changeClass !== 'fact' && r.changeClass !== 'projection' && r.changeClass !== 'identity') {
    throw new Error('SyncOutbox.fromSerialized: changeClass 非法');
  }
  /* 复用护栏：落盘的 changeClass 必须与 opKind 推导一致（防坏数据绕过身份核护栏）。 */
  const derived = classifyOpKind(r.opKind);
  if (derived !== r.changeClass) {
    throw new Error(`SyncOutbox.fromSerialized: opKind「${r.opKind}」推导 ${derived} 与落盘 ${String(r.changeClass)} 不一致`);
  }
  if (r.payload === null || typeof r.payload !== 'object') throw new Error('SyncOutbox.fromSerialized: payload 非对象');
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) throw new Error('SyncOutbox.fromSerialized: at 非有限数');
  return {
    deviceId, seq: r.seq, changeClass: r.changeClass, opKind: r.opKind,
    payload: JSON.parse(JSON.stringify(r.payload)) as Record<string, unknown>,
    at: r.at, synced: r.synced === true,
  };
}
