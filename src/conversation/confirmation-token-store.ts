/**
 * 对话确认 Token 存储（P1-C 加固 2）
 *
 * require_confirmation 命中时签发一次性 token；调用方携带 token 重发即放行。
 * Token 必须：
 *   - 与 (tenant, persona, session, externalUser) 强绑定
 *   - 与 input_hash 绑定，防止改写消息后复用 token
 *   - 30 分钟过期
 *   - 一次性消费（consumed_at 设置后无法再用）
 */

import { createHash, randomBytes } from 'node:crypto';
import type { IDatabase } from '../storage/database.js';
import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';

const TOKEN_BYTES = 24;
export const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;

export interface IssueTokenInput {
  tenantId: string;
  personaId: string;
  sessionId: string;
  externalUserId: string;
  topic: string;
  rule: BehaviorBoundary['rule'];
  userInput: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: number;
}

export interface VerifyTokenInput {
  token: string;
  tenantId: string;
  personaId: string;
  sessionId: string;
  externalUserId: string;
  userInput: string;
}

export class ConfirmationTokenStore {
  constructor(
    private readonly db: IDatabase,
    private readonly ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  ) {}

  issue(input: IssueTokenInput): IssuedToken {
    const id = `cct_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    const inputHash = hashInput(input.userInput);

    this.db.prepare<void>(
      `INSERT INTO conversation_confirmation_tokens
        (id, tenant_id, persona_id, session_id, external_user_id,
         requested_topic, requested_rule, input_hash, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.tenantId,
      input.personaId,
      input.sessionId,
      input.externalUserId,
      input.topic,
      input.rule,
      inputHash,
      now,
      expiresAt,
    );

    return { token: id, expiresAt };
  }

  /**
   * 验证 + 消费一次性 token。返回 true 表示 token 有效且已被消费。
   * 失败原因记入返回值便于审计。
   */
  consume(input: VerifyTokenInput): { ok: true } | { ok: false; reason: string } {
    const row = this.db.prepare<{
      tenant_id: string;
      persona_id: string;
      session_id: string;
      external_user_id: string;
      input_hash: string;
      expires_at: number;
      consumed_at: number | null;
    }>(
      `SELECT tenant_id, persona_id, session_id, external_user_id, input_hash, expires_at, consumed_at
         FROM conversation_confirmation_tokens
        WHERE id = ?`,
    ).get(input.token);

    if (!row) return { ok: false, reason: 'token_not_found' };
    if (row.consumed_at !== null) return { ok: false, reason: 'token_already_consumed' };
    if (row.expires_at < Date.now()) return { ok: false, reason: 'token_expired' };
    if (
      row.tenant_id !== input.tenantId ||
      row.persona_id !== input.personaId ||
      row.session_id !== input.sessionId ||
      row.external_user_id !== input.externalUserId
    ) {
      return { ok: false, reason: 'token_context_mismatch' };
    }
    if (row.input_hash !== hashInput(input.userInput)) {
      return { ok: false, reason: 'token_input_changed' };
    }

    /* 原子标记为已消费；防止竞态 */
    const result = this.db.prepare<void>(
      `UPDATE conversation_confirmation_tokens
          SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL`,
    ).run(Date.now(), input.token);

    if ((result.changes ?? 0) === 0) {
      return { ok: false, reason: 'token_already_consumed' };
    }
    return { ok: true };
  }

  pruneExpired(now = Date.now()): number {
    const result = this.db.prepare<void>(
      'DELETE FROM conversation_confirmation_tokens WHERE expires_at < ?',
    ).run(now);
    return result.changes ?? 0;
  }
}

function hashInput(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}
