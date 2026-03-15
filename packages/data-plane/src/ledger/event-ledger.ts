/**
 * Event Ledger — 事件溯源基础设施的核心抽象
 * 支持单流追加、按流加载、消费者批量拉取与 ACK
 */

/** 待追加的草稿事件 — 版本由 ledger 分配 */
export interface DraftEvent {
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly commandId: string;
  readonly payloadJson: string;
  readonly backfillSourceId?: string;
}

/** 已持久化的账本事件 */
export interface LedgerEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly occurredAt: number;
  readonly commandId: string;
  readonly payloadJson: string;
  readonly backfillSourceId?: string;
}

/** 追加结果 */
export interface AppendResult {
  readonly newVersion: number;
  readonly eventCount: number;
}

/** 乐观并发冲突 */
export class VersionConflictError extends Error {
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  constructor(streamId: string, expectedVersion: number, actualVersion: number) {
    super(`版本冲突: 流 ${streamId} 期望版本 ${expectedVersion}，实际版本 ${actualVersion}`);
    this.name = 'VersionConflictError';
    this.streamId = streamId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** 消费者批次 — 包含不透明句柄用于确认 */
export interface ConsumerBatch {
  readonly events: readonly LedgerEvent[];
  readonly batchHandle: string;
}

/** 事件账本接口 — 所有运行时实现此接口 */
export interface EventLedger {
  append(
    tenantId: string,
    streamId: string,
    events: readonly [DraftEvent, ...DraftEvent[]],
    expectedVersion?: number,
  ): Promise<AppendResult>;
  loadStream(tenantId: string, streamId: string, sinceVersion?: number): Promise<readonly LedgerEvent[]>;
  nextBatch(consumerId: string, batchSize: number): Promise<ConsumerBatch>;
  ackBatch(consumerId: string, batchHandle: string): Promise<void>;
}

/** 权威模式 — 控制表写入与 ledger 写入的主从关系 */
export type AuthorityMode =
  | 'tables_primary'
  | 'dual_write'
  | 'ledger_primary'
  | 'rollback_tables';

/** 权威切换器 — 管理双写模式转换 */
export interface AuthoritySwitch {
  currentMode(): Promise<AuthorityMode>;
  switchTo(mode: AuthorityMode, reason: string): Promise<void>;
}
