/**
 * 主动消息 outbound 队列 store（ADR-0054 Phase 2：主动性管道）。
 *
 * 数字人据内部信号「主动开口」的消息落此队列，客户端拉取未读 nudge。Phase 2 只提供管道
 * （enqueue / list / markRead），触发逻辑（ProactiveEngine/Gate）留待 Phase 3。
 *
 * 红线（ADR-0054）：
 *   - 幂等（红线 8）：enqueue 用 (tenant_id, persona_id, signal_type, source_id, signal_version) 唯一索引，
 *     冲突即忽略——同一信号最多一条主动消息。enqueue 返回是否真插入（false=该信号已入过队）。
 *   - 归属（红线 7）：所有读写按 tenant_id + persona_id scope；markRead 还要求 id 归属，绝不跨租户。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  proactiveMessageCmdEnqueue,
  proactiveMessageQueryList,
  proactiveMessageQueryById,
  proactiveMessageQueryWindowStats,
  proactiveMessageCmdMarkRead,
  type ProactiveMessageRow,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';
import { generatePrefixedId } from '../utils/index.js';

/** 入队一条主动消息所需的信号溯源 + 内容。 */
export interface ProactiveMessageInput {
  readonly personaId: string;
  /** 触发信号类型（如 'core:memory-consolidated'）。 */
  readonly signalType: string;
  /** 触发信号的来源对象 id（如被巩固的 memory id）——幂等键组成。 */
  readonly sourceId: string;
  /** 信号版本（同一 source 多次演进时区分；默认 0）——幂等键组成。 */
  readonly signalVersion?: number;
  /** 确定性 composer 产出的主动文本。 */
  readonly body: string;
  /** 消息类别（growth/memory/milestone…），供客户端分组渲染。 */
  readonly kind?: string;
}

export class ProactiveMessageStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly now: () => number,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /**
   * 入队一条主动消息（幂等）。返回 true=真插入；false=该信号已入过队（幂等忽略）。
   */
  enqueue(input: ProactiveMessageInput): boolean {
    const result = this.tx.execute(proactiveMessageCmdEnqueue({
      id: generatePrefixedId('pmsg'),
      tenantId: this.tenantId,
      personaId: input.personaId,
      signalType: input.signalType,
      sourceId: input.sourceId,
      signalVersion: input.signalVersion ?? 0,
      body: input.body,
      kind: input.kind ?? 'general',
      now: this.now(),
    }));
    return result.rowsAffected > 0;
  }

  /** 列出某 persona 的主动消息（可按 status 过滤，最新在前）。 */
  list(personaId: string, opts: { status?: string; limit?: number } = {}): ProactiveMessageRow[] {
    return [...this.tx.queryMany(proactiveMessageQueryList({
      tenantId: this.tenantId,
      personaId,
      status: opts.status,
      limit: opts.limit ?? 50,
    }))];
  }

  /** 列出某 persona 的未读主动消息。 */
  listUnread(personaId: string, limit = 50): ProactiveMessageRow[] {
    return this.list(personaId, { status: 'unread', limit });
  }

  /**
   * 窗口统计：windowCount=created_at≥since 的消息数（频率上限）；lastCreatedAt=最近一条时间（静默期）。
   * 供 ProactiveGate 节制判定（ADR-0054 红线 3：主动≠骚扰）。
   */
  windowStats(personaId: string, since: number): { windowCount: number; lastCreatedAt: number | null } {
    const row = this.tx.queryOne(proactiveMessageQueryWindowStats({
      tenantId: this.tenantId, personaId, since,
    }));
    return {
      windowCount: row?.window_count ?? 0,
      lastCreatedAt: row?.last_created_at ?? null,
    };
  }

  /**
   * 标记某条主动消息为已读（幂等）。
   *   - 'not_found'：不存在 / 非本租户 / 非本 persona（route → 404）。
   *   - 'marked'：之前未读，本次置已读。
   *   - 'already_read'：已读（幂等，route → 200，客户端重试友好）。
   */
  markRead(id: string, personaId: string): 'not_found' | 'marked' | 'already_read' {
    const result = this.tx.execute(proactiveMessageCmdMarkRead({
      id,
      tenantId: this.tenantId,
      personaId,
      now: this.now(),
    }));
    if (result.rowsAffected > 0) return 'marked';
    /* 未改：要么不存在，要么已读——查归属区分（防对不存在/他人消息泄漏存在性）。 */
    const row = this.tx.queryOne(proactiveMessageQueryById({ id, tenantId: this.tenantId, personaId }));
    return row ? 'already_read' : 'not_found';
  }
}
