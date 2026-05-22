/**
 * Audit chain KMS anchor verifier (P0-E v2)
 *
 * 与 AuditChainAnchorService 成对使用：在 restore-check 等离线流程把
 * "数据库内哈希链" 与 "KMS 签名锚" 做交叉验证。
 *
 * 严格语义（GA 模式）：
 *   - requireAnchorsForTenants 列出的租户必须至少存在一条锚记录，
 *     否则报告 missing_anchor_for_tenant（severity=error）；
 *   - requireSignatures=true 时，运行时若未注入可验签的 kmsProvider，
 *     'signature_not_verified' 升级为 error；
 *   - 默认 requireSignatures=false 保持向后兼容（单元测试 / 旧脚本
 *     可以在不接 KMS 的前提下读取报告）。
 *
 * 输出语义：
 *   - severity='error' → 链条与锚不一致 / KMS 验签失败 / 缺锚 →
 *     必须人工介入；
 *   - severity='info'  → 仅观测性结果，不影响最终 ok。
 */

import type { IDatabase } from '../storage/database.js';
import type { Logger } from '../utils/logger.js';
import { verifyAuditChain } from './audit-log-store.js';
import {
  buildAuditAnchorPayload,
  normalizeAnchorTenantId,
  type AuditChainKmsProvider,
} from './audit-chain-anchor-service.js';

export type AuditAnchorIssueSeverity = 'error' | 'info';

export interface AuditAnchorIssue {
  tenantId: string;
  anchorId: string;
  reason:
    | 'chain_broken_before_anchor'
    | 'missing_anchor_tail'
    | 'tail_hash_mismatch'
    | 'signature_invalid'
    | 'signature_verify_failed'
    | 'signature_not_verified'
    | 'missing_anchor_for_tenant';
  severity: AuditAnchorIssueSeverity;
}

export interface VerifyAuditAnchorsDeps {
  db: IDatabase;
  kmsProvider?: Pick<AuditChainKmsProvider, 'verify'>;
  logger?: Logger;
  /**
   * 严格 GA 模式：未在该列表内的租户允许"无锚"通过；列表内的租户
   * 若没有任何锚记录，会被标记为 missing_anchor_for_tenant=error。
   */
  requireAnchorsForTenants?: readonly string[];
  /**
   * 严格 GA 模式：true 时若 kmsProvider 缺失或未提供 verify，
   * 'signature_not_verified' 升级为 error。
   */
  requireSignatures?: boolean;
}

interface AnchorRow {
  id: string;
  tenant_id: string;
  from_seq: number | bigint;
  to_seq: number | bigint;
  tail_hash: string;
  signature: string;
  key_id: string;
  alg: string;
}

interface TailRow { record_hash: string | null }

/**
 * verify 调用的硬超时保护：与签名路径一致地避免恶意/异常 KMS 模块
 * hang 住调度。超时后 race 输出 reject，调用方 catch 后标 verify_failed。
 */
async function raceWithTimeout<T>(p: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function verifyAuditAnchors(
  deps: VerifyAuditAnchorsDeps,
): Promise<{ ok: boolean; issues: AuditAnchorIssue[] }> {
  const anchors = deps.db.prepare<AnchorRow>(
    `SELECT id, tenant_id, from_seq, to_seq, tail_hash, signature, key_id, alg
       FROM audit_chain_anchors
      ORDER BY tenant_id, to_seq ASC`,
  ).all();

  const issues: AuditAnchorIssue[] = [];
  const requireSignatures = deps.requireSignatures === true;
  const missingSignatureSeverity: AuditAnchorIssueSeverity = requireSignatures ? 'error' : 'info';

  /* "缺锚"检查：在严格模式下，每个被审计行覆盖的租户都必须有锚。
   * anchor 行的 tenant_id 与 audit_log.tenant_id 同形（原始值），所以
   * 直接相等比较即可——无需用 normalize 形式去匹配，否则会跳过 ''→'platform' 这类异常。
   * issue.tenantId 始终使用 normalize 形式，与消费方（audit-restore-check）
   * 的过滤键保持一致，避免平台租户被静默丢弃。 */
  if (deps.requireAnchorsForTenants && deps.requireAnchorsForTenants.length > 0) {
    const anchorsByTenant = new Set(anchors.map(a => a.tenant_id));
    for (const rawTenantId of deps.requireAnchorsForTenants) {
      if (!anchorsByTenant.has(rawTenantId)) {
        issues.push({
          tenantId: normalizeAnchorTenantId(rawTenantId),
          anchorId: '',
          reason: 'missing_anchor_for_tenant',
          severity: 'error',
        });
      }
    }
  }

  for (const anchor of anchors) {
    const rawTenantId = anchor.tenant_id;
    /* 报告里 tenantId 用 normalize 形式，使消费方（如 audit-restore-check）
     * 能稳定区分平台级与租户级 anchor。链表/audit_log 查询继续用 rawTenantId。 */
    const tenantId = normalizeAnchorTenantId(rawTenantId);
    const anchorId = anchor.id;
    const toSeq = Number(anchor.to_seq);
    const fromSeq = Number(anchor.from_seq);

    const chain = verifyAuditChain(deps.db, rawTenantId, { toSeq });
    if (!chain.ok) {
      issues.push({ tenantId, anchorId, reason: 'chain_broken_before_anchor', severity: 'error' });
      continue;
    }

    const tail = deps.db.prepare<TailRow>(
      `SELECT record_hash
         FROM audit_log
        WHERE tenant_id = ? AND chain_seq = ?
        LIMIT 1`,
    ).get(rawTenantId, toSeq);

    if (!tail?.record_hash) {
      issues.push({ tenantId, anchorId, reason: 'missing_anchor_tail', severity: 'error' });
      continue;
    }

    if (tail.record_hash !== anchor.tail_hash) {
      issues.push({ tenantId, anchorId, reason: 'tail_hash_mismatch', severity: 'error' });
      continue;
    }

    if (!deps.kmsProvider?.verify) {
      issues.push({ tenantId, anchorId, reason: 'signature_not_verified', severity: missingSignatureSeverity });
      deps.logger?.info('AuditAnchorVerifier', '锚签名验证已跳过（运行时无 KMS verify 能力）', {
        tenantId, anchorId,
      });
      continue;
    }

    try {
      /* 签名 payload 与锚定服务保持一致：用 normalize 后的租户名 +
       * fromSeq/toSeq/tailHash 重建。否则 '' / 'platform' 处会签验不一致。
       * verify 也用硬超时保护，防止流氓 KMS 模块 hang 住整个 restore-check。 */
      const verified = await raceWithTimeout(
        deps.kmsProvider.verify(
          buildAuditAnchorPayload({ tenantId, fromSeq, toSeq, tailHash: anchor.tail_hash }),
          Buffer.from(anchor.signature, 'base64'),
          anchor.key_id,
          anchor.alg,
        ),
        10_000,
        'KMS verify timed out',
      );
      if (!verified) {
        issues.push({ tenantId, anchorId, reason: 'signature_invalid', severity: 'error' });
      }
    } catch (err) {
      deps.logger?.error('AuditAnchorVerifier', '锚签名验证抛出异常', err);
      issues.push({ tenantId, anchorId, reason: 'signature_verify_failed', severity: 'error' });
    }
  }

  return {
    ok: !issues.some(issue => issue.severity === 'error'),
    issues,
  };
}
