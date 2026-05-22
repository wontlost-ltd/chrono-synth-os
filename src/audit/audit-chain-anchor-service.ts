/**
 * Audit chain KMS anchor service (P0-E v2)
 *
 * 周期性把每租户审计链的尾哈希提交给外部 KMS 签名后落地，作为
 * 链外信任锚。Restore-check 时只要校验最近一份锚（KMS pubkey）+
 * 链内哈希一致，就能识别"数据库被批量重写"的高级篡改。
 *
 * 关键设计：
 *   - 严格脱离请求路径：所有 KMS sign 调用通过 setInterval 异步触发，
 *     不会阻塞业务请求；
 *   - 由 feature flag `audit.kms-sign-chain-tail` 控制开关：默认关闭，
 *     运维侧确认 KMS 接入后再打开；
 *   - 同一 (tenant_id, to_seq, tail_hash) 三元组幂等：UNIQUE 索引保证
 *     重复触发不会写入冗余行。
 */

import { randomUUID } from 'node:crypto';
import type { FeatureFlagService } from '../feature-flags/feature-flag-service.js';
import type { IDatabase } from '../storage/database.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';

const DEFAULT_INTERVAL_MS = 60_000;

export interface AuditChainAnchorRow {
  id: string;
  tenantId: string;
  fromSeq: number;
  toSeq: number;
  tailHash: string;
  signature: string;
  keyId: string;
  alg: string;
  signedAt: string;
}

/**
 * 平台级审计行（无租户）落库时 tenant_id 可能是 ''。锚定层统一映射到
 * 'platform'，与 break-glass 服务保持一致；这样 feature flag 决策、
 * 锚记录、恢复报告的分区键都用同一个常量。
 */
export const PLATFORM_TENANT_PARTITION = 'platform';

export function normalizeAnchorTenantId(tenantId: string): string {
  return tenantId === '' ? PLATFORM_TENANT_PARTITION : tenantId;
}

/**
 * 域分离的锚签名载荷：把 KMS 签名绑定到 (tenant, fromSeq, toSeq, tailHash)
 * 元数据，避免相同 tailHash 在不同窗口被复用作为签名。
 * 验证侧必须用同一序列化，因此固定字段顺序、固定 schema 标签。
 */
export const AUDIT_ANCHOR_PAYLOAD_SCHEMA = 'chrono.audit-chain-anchor.v1';

export function buildAuditAnchorPayload(input: {
  tenantId: string;
  fromSeq: number;
  toSeq: number;
  tailHash: string;
}): Buffer {
  const canonical = {
    schema: AUDIT_ANCHOR_PAYLOAD_SCHEMA,
    tenantId: normalizeAnchorTenantId(input.tenantId),
    fromSeq: input.fromSeq,
    toSeq: input.toSeq,
    tailHash: input.tailHash,
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

/**
 * 仅供锚定使用的 KMS 抽象 — 与现有 KmsClient (envelope encryption)
 * 不同：这里只需要 sign / verify 一段字节。供应商接入时，在适配层把
 * 该签名映射到底层 KMS API 即可。
 */
export interface AuditChainKmsProvider {
  sign(payload: Buffer): Promise<{ keyId: string; signature: Buffer | string; alg: string }>;
  verify?(payload: Buffer, signature: Buffer, keyId: string, alg: string): Promise<boolean>;
}

export interface AuditChainAnchorServiceDeps {
  db: IDatabase;
  kmsProvider: AuditChainKmsProvider;
  featureFlags: Pick<FeatureFlagService, 'isEnabled'>;
  clock: Clock;
  logger: Logger;
  intervalMs?: number;
}

interface TenantRow { tenant_id: string }
interface SeqRow { chain_seq: number | bigint; record_hash: string }
interface AnchorSqlRow {
  id: string;
  tenant_id: string;
  from_seq: number | bigint;
  to_seq: number | bigint;
  tail_hash: string;
  signature: string;
  key_id: string;
  alg: string;
  signed_at: string;
}

export class AuditChainAnchorService {
  private readonly db: IDatabase;
  private readonly kmsProvider: AuditChainKmsProvider;
  private readonly featureFlags: Pick<FeatureFlagService, 'isEnabled'>;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(deps: AuditChainAnchorServiceDeps) {
    this.db = deps.db;
    this.kmsProvider = deps.kmsProvider;
    this.featureFlags = deps.featureFlags;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.triggerOnce().catch(err => {
        this.logger.error('AuditChainAnchor', '后台锚定任务失败', err);
      });
    }, this.intervalMs);
    /* 不阻塞 Node 退出 */
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 测试 / 运维侧手动触发；调度器复用同一函数 */
  async triggerOnce(): Promise<{ anchored: Array<{ tenantId: string; toSeq: number; keyId: string }>; skipped: number }> {
    if (this.running) return { anchored: [], skipped: 0 };
    this.running = true;
    try {
      return await this.anchorPendingTails();
    } finally {
      this.running = false;
    }
  }

  private async anchorPendingTails(): Promise<{ anchored: Array<{ tenantId: string; toSeq: number; keyId: string }>; skipped: number }> {
    const tenants = this.db.prepare<TenantRow>(
      `SELECT DISTINCT tenant_id
         FROM audit_log
        WHERE chain_seq IS NOT NULL
        ORDER BY tenant_id`,
    ).all();

    const anchored: Array<{ tenantId: string; toSeq: number; keyId: string }> = [];
    let skipped = 0;

    for (const tenant of tenants) {
      const rawTenantId = tenant.tenant_id;
      /* partitionTenant 仅用于 feature flag 决策 + 签名 payload 域分离；
       * anchor 行本身必须使用原始 tenant_id 写入，使其与 audit_log
       * 的同名列对应，验证侧才能交叉查回 record_hash。 */
      const partitionTenant = normalizeAnchorTenantId(rawTenantId);
      const decision = this.featureFlags.isEnabled('audit.kms-sign-chain-tail', partitionTenant);
      if (!decision.enabled) {
        skipped += 1;
        continue;
      }

      const tail = this.getTail(rawTenantId);
      if (!tail) continue;

      const toSeq = Number(tail.chain_seq);
      const latestAnchor = this.getLatestAnchor(rawTenantId);
      if (latestAnchor && latestAnchor.toSeq >= toSeq) continue;

      const fromSeq = latestAnchor
        ? latestAnchor.toSeq + 1
        : this.getFirstSeqNumber(rawTenantId);
      if (fromSeq === null) continue;

      const tailHash = tail.record_hash;
      const payload = buildAuditAnchorPayload({ tenantId: partitionTenant, fromSeq, toSeq, tailHash });
      let signed: { keyId: string; signature: Buffer | string; alg: string };
      try {
        signed = await this.signWithTimeout(payload);
      } catch (err) {
        /* KMS 失败不阻塞其它租户；记录后跳过本租户，靠下次定时再试。
         * 包含超时 / 拒绝 / 网络错误 — 都视为暂时不可用，由监控指标
         * 反映新鲜度（详见 SignTimeoutMs）。 */
        this.logger.error('AuditChainAnchor', 'KMS 签名失败，跳过该租户的锚定', {
          tenantId: partitionTenant, fromSeq, toSeq, error: (err as Error).message,
        });
        continue;
      }
      const signature = Buffer.isBuffer(signed.signature)
        ? signed.signature.toString('base64')
        : signed.signature;

      const inserted = this.insertAnchor({
        id: randomUUID(),
        tenantId: rawTenantId,
        fromSeq,
        toSeq,
        tailHash,
        signature,
        keyId: signed.keyId,
        alg: signed.alg,
        signedAt: new Date(this.clock.now()).toISOString(),
      });

      if (inserted) {
        anchored.push({ tenantId: partitionTenant, toSeq, keyId: signed.keyId });
      }
    }

    return { anchored, skipped };
  }

  /**
   * KMS 签名带 hard timeout — 防止某次 hang 永久占用 running=true 槽
   * 导致后续调度全部跳过。默认 10s 与外部 KMS RTT 上限对齐，超时按
   * 失败处理（落 error log + 不写锚 + 下一次 interval 再试）。
   */
  private async signWithTimeout(payload: Buffer): Promise<{ keyId: string; signature: Buffer | string; alg: string }> {
    const timeoutMs = 10_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.kmsProvider.sign(payload),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`KMS sign timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getLatestAnchor(tenantId: string): AuditChainAnchorRow | undefined {
    const row = this.db.prepare<AnchorSqlRow>(
      `SELECT id, tenant_id, from_seq, to_seq, tail_hash, signature, key_id, alg, signed_at
         FROM audit_chain_anchors
        WHERE tenant_id = ?
        ORDER BY to_seq DESC
        LIMIT 1`,
    ).get(tenantId);
    return row ? anchorFromRow(row) : undefined;
  }

  private getTail(tenantId: string): SeqRow | undefined {
    return this.db.prepare<SeqRow>(
      `SELECT chain_seq, record_hash
         FROM audit_log
        WHERE tenant_id = ? AND chain_seq IS NOT NULL AND record_hash IS NOT NULL
        ORDER BY chain_seq DESC
        LIMIT 1`,
    ).get(tenantId);
  }

  private getFirstSeqNumber(tenantId: string): number | null {
    const row = this.db.prepare<SeqRow>(
      `SELECT chain_seq, record_hash
         FROM audit_log
        WHERE tenant_id = ? AND chain_seq IS NOT NULL AND record_hash IS NOT NULL
        ORDER BY chain_seq ASC
        LIMIT 1`,
    ).get(tenantId);
    return row ? Number(row.chain_seq) : null;
  }

  private insertAnchor(row: AuditChainAnchorRow): boolean {
    const result = this.db.prepare<void>(
      `INSERT INTO audit_chain_anchors
         (id, tenant_id, from_seq, to_seq, tail_hash, signature, key_id, alg, signed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, to_seq, tail_hash) DO NOTHING`,
    ).run(
      row.id,
      row.tenantId,
      row.fromSeq,
      row.toSeq,
      row.tailHash,
      row.signature,
      row.keyId,
      row.alg,
      row.signedAt,
    );
    return Number(result.changes) > 0;
  }
}

export function anchorFromRow(row: AnchorSqlRow): AuditChainAnchorRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fromSeq: Number(row.from_seq),
    toSeq: Number(row.to_seq),
    tailHash: row.tail_hash,
    signature: row.signature,
    keyId: row.key_id,
    alg: row.alg,
    signedAt: row.signed_at,
  };
}
