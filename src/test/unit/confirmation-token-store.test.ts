/**
 * 单元测试：ConfirmationTokenStore（P1-C 加固 2）
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { ConfirmationTokenStore } from '../../conversation/confirmation-token-store.js';
import type { IDatabase } from '../../storage/database.js';

const CTX = {
  tenantId: 't1',
  personaId: 'pcore_x',
  sessionId: 's1',
  externalUserId: 'eu',
};

describe('ConfirmationTokenStore', () => {
  let db: IDatabase;
  let store: ConfirmationTokenStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runMigrations(db);
    store = new ConfirmationTokenStore(db);
  });

  afterEach(() => db.close());

  it('issue 返回 token + expiresAt', () => {
    const r = store.issue({
      ...CTX,
      topic: '修改账户',
      rule: 'require_confirmation',
      userInput: '请帮我修改账户',
    });
    assert.ok(r.token.startsWith('cct_'));
    assert.ok(r.expiresAt > Date.now());
  });

  it('consume 有效 token → ok', () => {
    const issued = store.issue({
      ...CTX, topic: 't', rule: 'require_confirmation', userInput: 'msg',
    });
    const r = store.consume({ token: issued.token, ...CTX, userInput: 'msg' });
    assert.deepEqual(r, { ok: true });
  });

  it('consume 已消费 token → token_already_consumed', () => {
    const issued = store.issue({
      ...CTX, topic: 't', rule: 'require_confirmation', userInput: 'msg',
    });
    store.consume({ token: issued.token, ...CTX, userInput: 'msg' });
    const r = store.consume({ token: issued.token, ...CTX, userInput: 'msg' });
    assert.equal((r as { ok: false; reason: string }).reason, 'token_already_consumed');
  });

  it('consume 不同 input → token_input_changed', () => {
    const issued = store.issue({
      ...CTX, topic: 't', rule: 'require_confirmation', userInput: 'original',
    });
    const r = store.consume({ token: issued.token, ...CTX, userInput: 'tampered' });
    assert.equal((r as { ok: false; reason: string }).reason, 'token_input_changed');
  });

  it('consume 跨 session 复用 → token_context_mismatch', () => {
    const issued = store.issue({
      ...CTX, topic: 't', rule: 'require_confirmation', userInput: 'msg',
    });
    const r = store.consume({
      token: issued.token,
      tenantId: CTX.tenantId,
      personaId: CTX.personaId,
      sessionId: 'other-session',
      externalUserId: CTX.externalUserId,
      userInput: 'msg',
    });
    assert.equal((r as { ok: false; reason: string }).reason, 'token_context_mismatch');
  });

  it('consume 不存在的 token → token_not_found', () => {
    const r = store.consume({ token: 'cct_does_not_exist', ...CTX, userInput: 'x' });
    assert.equal((r as { ok: false; reason: string }).reason, 'token_not_found');
  });

  it('pruneExpired 删除过期未消费 token', () => {
    const ttl = 50;
    const shortStore = new ConfirmationTokenStore(db, ttl);
    shortStore.issue({ ...CTX, topic: 't', rule: 'require_confirmation', userInput: 'msg' });
    /* 等待过期 */
    return new Promise<void>((resolve) => setTimeout(() => {
      const removed = shortStore.pruneExpired();
      assert.equal(removed, 1);
      resolve();
    }, ttl + 30));
  });
});
