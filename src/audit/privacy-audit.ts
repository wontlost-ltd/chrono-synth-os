/**
 * 隐私操作的**业务审计**共享辅助（全维评审 F5 debt）。
 *
 * GDPR Art.12（数据主体知情权）+ SOC2 CC6.1 要求关键数据操作（export/erase/import）留可证明的证据链：
 * 谁触发、目标、结果——写不可篡改 hash-chain 审计链，非仅通用 request 审计。
 *
 * 提取为共享函数供 v1 (`privacy.ts`) 与 v2 (`v2/index.ts` portability) 同一处调用——两条 API 都是同类
 * 「真实读写租户数据」的操作，不能有一条绕过审计链（Codex 复审发现 v2 portability import 曾漏审计）。
 *
 * payload 只放非敏感元数据（job id / 计数 / 阻断 hold id），绝不含导出内容/个人数据本身。
 * 审计失败**不阻塞**主操作返回（best-effort，与既有 recordBusinessAuditLog 调用点一致）。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { recordBusinessAuditLog } from './audit-log-store.js';
import type { JwtPayload } from '../types/auth.js';

/** 记录一条隐私业务审计。actorId 取 JWT sub（生产 JWT 启用时必有；非生产透传为 'unknown'）。 */
export function recordPrivacyAudit(
  tx: SyncWriteUnitOfWork,
  request: { tenantId: string; user?: unknown },
  actionType: string,
  targetId: string,
  payload: Record<string, unknown>,
): void {
  const actorId = (request.user as JwtPayload | undefined)?.sub ?? 'unknown';
  try {
    recordBusinessAuditLog(tx, {
      tenantId: request.tenantId,
      actorType: 'user',
      actorId,
      actionType,
      targetType: 'tenant_data',
      targetId,
      payload,
    });
  } catch { /* 审计失败不阻塞主操作（合规留痕是尽力而为，不能反噬用户请求） */ }
}
