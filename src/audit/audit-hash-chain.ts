/**
 * 审计日志哈希链 — 单租户范围内的 append-only 链
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-E + §8 #5
 *
 * 设计要点：
 *
 *  - 每个 tenant 维护独立的链。`chain_seq` 从 1 起单调递增，`prev_hash` 指向同租户
 *    上一条记录的 record_hash；首条记录的 prev_hash 为 GENESIS_HASH（全 0）。
 *  - `record_hash = SHA256(canonical(record_without_hashes))`。注意 record_hash 输入
 *    包含 prev_hash 字段，因此任意一条记录的 payload/路径/时间被篡改都会导致后续
 *    所有 hash 失配。
 *  - 序列化采用规范化 JSON（按 key 字典序、显式 null、无尾随空白）。这样跨语言、
 *    跨 DB 引擎得到的 hash 一致，便于第三方审计工具 replay。
 *
 * 隔离性：本模块只承担纯计算职责；DB I/O 与同步原语由调用方（executors / store）
 * 控制。`computeRecordHash` 是无副作用纯函数，方便单元测试。
 */

import { createHash } from 'node:crypto';

/** Genesis hash for the first record of a tenant chain. 32 bytes of zero. */
export const GENESIS_HASH = '0'.repeat(64);

/** Hash chain input — all fields that participate in the canonical hash. */
export interface AuditHashInput {
  id: string;
  tenantId: string;
  eventKind: 'request' | 'business';
  createdAt: number;
  chainSeq: number;
  prevHash: string;
  method: string;
  path: string;
  requestId: string;
  statusCode: number;
  latencyMs: number;
  apiKeyHash: string | null;
  userId: string | null;
  userEmail: string | null;
  actorType: string | null;
  actorId: string | null;
  actionType: string;
  targetType: string | null;
  targetId: string | null;
  payloadJson: string | null;
}

/**
 * 按字典序序列化对象，避免 JSON.stringify 因 key 顺序产生 hash 漂移。
 * 不递归处理嵌套对象（payloadJson 已是字符串，整体作为单个字段参与）。
 */
function canonicalSerialize(input: AuditHashInput): string {
  const ordered: Record<string, string | number | null> = {
    actionType: input.actionType,
    actorId: input.actorId,
    actorType: input.actorType,
    apiKeyHash: input.apiKeyHash,
    chainSeq: input.chainSeq,
    createdAt: input.createdAt,
    eventKind: input.eventKind,
    id: input.id,
    latencyMs: input.latencyMs,
    method: input.method,
    path: input.path,
    payloadJson: input.payloadJson,
    prevHash: input.prevHash,
    requestId: input.requestId,
    statusCode: input.statusCode,
    targetId: input.targetId,
    targetType: input.targetType,
    tenantId: input.tenantId,
    userEmail: input.userEmail,
    userId: input.userId,
  };
  return JSON.stringify(ordered);
}

export function computeRecordHash(input: AuditHashInput): string {
  return createHash('sha256').update(canonicalSerialize(input)).digest('hex');
}

/** Result of a chain verification walk. */
export interface ChainVerifyResult {
  ok: boolean;
  totalChecked: number;
  /** Sequence numbers where a hash mismatch or chain break was detected. */
  breaks: ChainBreak[];
}

export interface ChainBreak {
  chainSeq: number;
  id: string;
  reason: 'prev_hash_mismatch' | 'record_hash_mismatch' | 'seq_gap';
  expected: string;
  actual: string;
}

/** Row shape required by the verifier — superset of AuditHashInput plus record_hash. */
export interface VerifiableRow extends AuditHashInput {
  recordHash: string;
}

/**
 * 顺序遍历 rows（按 chain_seq 升序）校验链完整性。
 *
 * 调用方负责按 chain_seq 升序传入。该函数不做排序，避免在大数据集上引入隐式 O(n log n)。
 */
export function verifyChain(rows: readonly VerifiableRow[]): ChainVerifyResult {
  const breaks: ChainBreak[] = [];
  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;

  for (const row of rows) {
    if (row.chainSeq !== expectedSeq) {
      breaks.push({
        chainSeq: row.chainSeq,
        id: row.id,
        reason: 'seq_gap',
        expected: String(expectedSeq),
        actual: String(row.chainSeq),
      });
      /* Re-sync expectedSeq to the row we saw so we still detect downstream breaks
       * even though we've already noted the gap. */
      expectedSeq = row.chainSeq;
    }
    if (row.prevHash !== expectedPrev) {
      breaks.push({
        chainSeq: row.chainSeq,
        id: row.id,
        reason: 'prev_hash_mismatch',
        expected: expectedPrev,
        actual: row.prevHash,
      });
    }
    const recomputed = computeRecordHash(row);
    if (recomputed !== row.recordHash) {
      breaks.push({
        chainSeq: row.chainSeq,
        id: row.id,
        reason: 'record_hash_mismatch',
        expected: recomputed,
        actual: row.recordHash,
      });
    }
    expectedPrev = row.recordHash;
    expectedSeq += 1;
  }

  return {
    ok: breaks.length === 0,
    totalChecked: rows.length,
    breaks,
  };
}
