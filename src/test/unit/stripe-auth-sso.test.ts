/**
 * Wave 13 迁移覆盖测试
 * StripeWebhookService / AuthService.cleanupExpired / SsoUserService
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  SWHS_QUERY_LATEST_SUBSCRIPTION, SWHS_QUERY_SUB_BY_STRIPE_CUSTOMER,
  SWHS_CMD_RECORD_EVENT, SWHS_CMD_PERSIST_STRIPE_CUSTOMER,
  SWHS_CMD_PURCHASE_ADDON, SWHS_CMD_UPDATE_SUBSCRIPTION,
  SWHS_CMD_CANCEL_BY_CUSTOMER, SWHS_CMD_CANCEL_TENANT_ADDONS,
  AUTH_QUERY_USER_BY_EMAIL, AUTH_QUERY_USER_BY_ID,
  AUTH_QUERY_REFRESH_TOKEN, AUTH_QUERY_USER_BRIEF_BY_EMAIL,
  AUTH_QUERY_USER_COUNT_BY_TENANT, AUTH_QUERY_SUB_EXISTS,
  AUTH_CMD_CREATE_USER, AUTH_CMD_CREATE_SUBSCRIPTION,
  AUTH_CMD_CREATE_REFRESH_TOKEN, AUTH_CMD_REVOKE_TOKEN_BY_ID,
  AUTH_CMD_REVOKE_TOKEN_BY_HASH, AUTH_CMD_REVOKE_TOKENS_BY_USER,
  AUTH_CMD_CLEANUP_EXPIRED_TOKENS, AUTH_CMD_UPDATE_DISPLAY_NAME,
} from '@chrono/kernel';
import { registerCoreSelfExecutors, resetCoreSelfExecutors } from '../../storage/executors/index.js';
import { resolveQueryExecutor, resolveCommandExecutor } from '../../storage/legacy-sync-bridge.js';
import { createMemoryDatabase, runMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { StripeWebhookService } from '../../billing/stripe-webhook-service.js';
import { EntitlementService } from '../../billing/entitlement-service.js';
import { SsoUserService } from '../../identity/sso-user-service.js';
import { AuthService } from '../../identity/auth-service.js';

function seedSubscription(db: IDatabase, tenantId: string, opts: { stripeCustomerId?: string; planId?: string } = {}): string {
  const id = `sub_${randomUUID()}`;
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO subscriptions (id, tenant_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(id, tenantId, opts.stripeCustomerId ?? null, opts.planId ?? 'free', now, now + 86400000, now, now);
  return id;
}

function seedAddOn(db: IDatabase, addOnId: string): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO add_ons (id, code, name, description, stripe_price_id, resource, quota_amount, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'extra_memories', 100, TRUE, ?, ?)`,
  ).run(addOnId, `code_${addOnId}`, 'Test AddOn', 'desc', now, now);
}

describe('StripeWebhook + Auth + SSO 执行器注册', () => {
  beforeEach(() => {
    resetCoreSelfExecutors();
  });

  it('全部 StripeWebhook query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();
    assert.ok(resolveQueryExecutor(SWHS_QUERY_LATEST_SUBSCRIPTION));
    assert.ok(resolveQueryExecutor(SWHS_QUERY_SUB_BY_STRIPE_CUSTOMER));
    assert.ok(resolveCommandExecutor(SWHS_CMD_RECORD_EVENT));
    assert.ok(resolveCommandExecutor(SWHS_CMD_PERSIST_STRIPE_CUSTOMER));
    assert.ok(resolveCommandExecutor(SWHS_CMD_PURCHASE_ADDON));
    assert.ok(resolveCommandExecutor(SWHS_CMD_UPDATE_SUBSCRIPTION));
    assert.ok(resolveCommandExecutor(SWHS_CMD_CANCEL_BY_CUSTOMER));
    assert.ok(resolveCommandExecutor(SWHS_CMD_CANCEL_TENANT_ADDONS));
  });

  it('全部 Auth query/command 执行器注册完整', () => {
    registerCoreSelfExecutors();
    assert.ok(resolveQueryExecutor(AUTH_QUERY_USER_BY_EMAIL));
    assert.ok(resolveQueryExecutor(AUTH_QUERY_USER_BY_ID));
    assert.ok(resolveQueryExecutor(AUTH_QUERY_REFRESH_TOKEN));
    assert.ok(resolveQueryExecutor(AUTH_QUERY_USER_BRIEF_BY_EMAIL));
    assert.ok(resolveQueryExecutor(AUTH_QUERY_USER_COUNT_BY_TENANT));
    assert.ok(resolveQueryExecutor(AUTH_QUERY_SUB_EXISTS));
    assert.ok(resolveCommandExecutor(AUTH_CMD_CREATE_USER));
    assert.ok(resolveCommandExecutor(AUTH_CMD_CREATE_SUBSCRIPTION));
    assert.ok(resolveCommandExecutor(AUTH_CMD_CREATE_REFRESH_TOKEN));
    assert.ok(resolveCommandExecutor(AUTH_CMD_REVOKE_TOKEN_BY_ID));
    assert.ok(resolveCommandExecutor(AUTH_CMD_REVOKE_TOKEN_BY_HASH));
    assert.ok(resolveCommandExecutor(AUTH_CMD_REVOKE_TOKENS_BY_USER));
    assert.ok(resolveCommandExecutor(AUTH_CMD_CLEANUP_EXPIRED_TOKENS));
    assert.ok(resolveCommandExecutor(AUTH_CMD_UPDATE_DISPLAY_NAME));
  });
});

describe('StripeWebhookService 数据平面契约', () => {
  let db: IDatabase;
  let service: StripeWebhookService;

  beforeEach(() => {
    resetCoreSelfExecutors();
    db = createMemoryDatabase();
    runMigrations(db);
    const entitlementService = new EntitlementService(db);
    service = new StripeWebhookService(db, entitlementService);
  });

  it('processEvent 幂等：重复事件标记 duplicate', () => {
    const tenantId = `tenant_${randomUUID()}`;
    seedSubscription(db, tenantId, { stripeCustomerId: 'cus_test' });
    const result1 = service.processEvent('evt_1', 'charge.succeeded', {});
    assert.equal(result1.received, true);
    assert.equal(result1.duplicate, undefined);

    const result2 = service.processEvent('evt_1', 'charge.succeeded', {});
    assert.equal(result2.received, true);
    assert.equal(result2.duplicate, true);
  });

  it('getLatestSubscription 返回最新订阅', () => {
    const tenantId = `tenant_${randomUUID()}`;
    seedSubscription(db, tenantId, { planId: 'pro' });
    const sub = service.getLatestSubscription(tenantId);
    assert.ok(sub);
    assert.equal(sub.tenant_id, tenantId);
    assert.equal(sub.plan_id, 'pro');
  });

  it('getLatestSubscription 无订阅时返回 undefined', () => {
    const sub = service.getLatestSubscription('nonexistent');
    assert.equal(sub, undefined);
  });

  it('persistStripeCustomerId 回写客户 ID', () => {
    const tenantId = `tenant_${randomUUID()}`;
    const subId = seedSubscription(db, tenantId);
    service.persistStripeCustomerId('cus_new', subId);
    const sub = service.getLatestSubscription(tenantId);
    assert.equal(sub?.stripe_customer_id, 'cus_new');
  });

  it('purchaseAddOn 插入 tenant_add_ons 记录', () => {
    const tenantId = `tenant_${randomUUID()}`;
    seedSubscription(db, tenantId);
    const addOnId = `addon_${randomUUID()}`;
    seedAddOn(db, addOnId);
    service.purchaseAddOn(tenantId, addOnId);
    const row = db.prepare<{ tenant_id: string; add_on_id: string; status: string }>(
      'SELECT tenant_id, add_on_id, status FROM tenant_add_ons WHERE tenant_id = ?',
    ).get(tenantId);
    assert.ok(row);
    assert.equal(row.add_on_id, addOnId);
    assert.equal(row.status, 'active');
  });

  it('handleSubscriptionUpsert 更新订阅状态和计划', () => {
    const tenantId = `tenant_${randomUUID()}`;
    seedSubscription(db, tenantId, { stripeCustomerId: 'cus_upsert' });
    service.processEvent('evt_upsert', 'customer.subscription.updated', {
      id: 'stripe_sub_1',
      customer: 'cus_upsert',
      status: 'active',
      current_period_start: 1000,
      current_period_end: 2000,
      items: { data: [] },
    });
    const sub = service.getLatestSubscription(tenantId);
    assert.equal(sub?.stripe_subscription_id, 'stripe_sub_1');
    assert.equal(sub?.status, 'active');
  });

  it('handleSubscriptionDeleted 取消订阅和附加组件', () => {
    const tenantId = `tenant_${randomUUID()}`;
    seedSubscription(db, tenantId, { stripeCustomerId: 'cus_del', planId: 'pro' });
    const addOnId = `addon_${randomUUID()}`;
    seedAddOn(db, addOnId);
    service.purchaseAddOn(tenantId, addOnId);

    service.processEvent('evt_del', 'customer.subscription.deleted', {
      customer: 'cus_del',
    });

    const sub = service.getLatestSubscription(tenantId);
    assert.equal(sub?.status, 'canceled');
    assert.equal(sub?.plan_id, 'free');

    const addon = db.prepare<{ status: string }>(
      'SELECT status FROM tenant_add_ons WHERE tenant_id = ?',
    ).get(tenantId);
    assert.equal(addon?.status, 'canceled');
  });

  it('Stripe 客户查找返回最新订阅（ORDER BY created_at DESC）', () => {
    const tenantId = `tenant_${randomUUID()}`;
    seedSubscription(db, tenantId, { stripeCustomerId: 'cus_multi', planId: 'free' });
    /* 创建第二条更新的订阅 */
    const now = Date.now() + 1000;
    db.prepare<void>(
      `INSERT INTO subscriptions (id, tenant_id, stripe_customer_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, ?, 'cus_multi', 'pro', 'active', ?, ?, ?, ?)`,
    ).run(`sub_${randomUUID()}`, tenantId, now, now + 86400000, now, now);

    service.processEvent('evt_multi', 'customer.subscription.updated', {
      id: 'stripe_sub_multi',
      customer: 'cus_multi',
      status: 'active',
      current_period_start: 1000,
      current_period_end: 2000,
      items: { data: [] },
    });

    /* 验证更新的是最新订阅（pro），而非旧的（free） */
    const rows = db.prepare<{ plan_id: string; stripe_subscription_id: string | null }>(
      'SELECT plan_id, stripe_subscription_id FROM subscriptions WHERE stripe_customer_id = ? ORDER BY created_at DESC',
    ).all('cus_multi');
    assert.equal(rows[0].stripe_subscription_id, 'stripe_sub_multi');
  });
});

describe('AuthService.cleanupExpired 数据平面契约', () => {
  let db: IDatabase;

  beforeEach(() => {
    resetCoreSelfExecutors();
    db = createMemoryDatabase();
    runMigrations(db);
  });

  it('清理过期和已吊销的令牌', () => {
    const now = Date.now();
    const old = now - 31 * 24 * 60 * 60 * 1000;
    /* 先创建用户以满足 FK 约束 */
    db.prepare<void>(
      'INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('user_1', 'cleanup@test.com', 'hash', 'admin', 'tenant_cleanup', now, now);
    /* 已吊销且过期的令牌 */
    db.prepare<void>(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, is_revoked, expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run('rt_old', 'user_1', 'hash_old', old, old);
    /* 未吊销但过期的令牌 */
    db.prepare<void>(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, is_revoked, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run('rt_expired', 'user_1', 'hash_expired', old, now);
    /* 活跃令牌 */
    db.prepare<void>(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, is_revoked, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run('rt_active', 'user_1', 'hash_active', now + 86400000, now);

    const cleaned = AuthService.cleanupExpired(db);
    assert.equal(cleaned, 2);

    const remaining = db.prepare<{ id: string }>('SELECT id FROM refresh_tokens').all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'rt_active');
  });

  it('无令牌时清理返回 0', () => {
    const cleaned = AuthService.cleanupExpired(db);
    assert.equal(cleaned, 0);
  });
});

describe('SsoUserService 数据平面契约', () => {
  let db: IDatabase;
  let service: SsoUserService;

  beforeEach(() => {
    resetCoreSelfExecutors();
    db = createMemoryDatabase();
    runMigrations(db);
    service = new SsoUserService(db);
  });

  it('OIDC 首次用户创建 admin 角色', () => {
    const tenantId = `tenant_${randomUUID()}`;
    const result = service.findOrCreateForOidc('first@example.com', tenantId);
    assert.equal(result.isNew, true);
    assert.equal(result.role, 'admin');
    assert.equal(result.tenantId, tenantId);
  });

  it('OIDC 第二用户分配 member 角色', () => {
    const tenantId = `tenant_${randomUUID()}`;
    service.findOrCreateForOidc('first@example.com', tenantId);
    const result = service.findOrCreateForOidc('second@example.com', tenantId);
    assert.equal(result.isNew, true);
    assert.equal(result.role, 'member');
  });

  it('OIDC 已有用户返回 isNew=false', () => {
    const tenantId = `tenant_${randomUUID()}`;
    service.findOrCreateForOidc('existing@example.com', tenantId);
    const result = service.findOrCreateForOidc('existing@example.com', tenantId);
    assert.equal(result.isNew, false);
    assert.equal(result.tenantId, tenantId);
  });

  it('OIDC 邮箱跨租户绑定抛出认证错误', () => {
    const tenantA = `tenant_${randomUUID()}`;
    const tenantB = `tenant_${randomUUID()}`;
    service.findOrCreateForOidc('cross@example.com', tenantA);
    assert.throws(
      () => service.findOrCreateForOidc('cross@example.com', tenantB),
      (err: Error) => err.message.includes('已绑定其他 tenant'),
    );
  });

  it('OIDC displayName 更新身份记录', () => {
    const tenantId = `tenant_${randomUUID()}`;
    const result = service.findOrCreateForOidc('named@example.com', tenantId, 'Alice');
    const identity = db.prepare<{ display_name: string }>(
      'SELECT display_name FROM identities WHERE user_id = ?',
    ).get(result.userId);
    assert.equal(identity?.display_name, 'Alice');
  });

  it('SSO 新用户自动创建 tenant 和订阅', () => {
    const result = service.findOrCreateForSso('sso@example.com');
    assert.equal(result.isNew, true);
    assert.equal(result.role, 'admin');
    const sub = db.prepare<{ id: string }>(
      'SELECT id FROM subscriptions WHERE tenant_id = ?',
    ).get(result.tenantId);
    assert.ok(sub);
  });

  it('SSO 已有用户返回 isNew=false 并确保订阅存在', () => {
    const result1 = service.findOrCreateForSso('returning@example.com');
    const result2 = service.findOrCreateForSso('returning@example.com');
    assert.equal(result2.isNew, false);
    assert.equal(result2.userId, result1.userId);
    assert.equal(result2.tenantId, result1.tenantId);
  });

  it('ensureSubscription 幂等不重复创建', () => {
    const result = service.findOrCreateForSso('idempotent@example.com');
    /* 再次调用不应创建第二条订阅 */
    service.findOrCreateForSso('idempotent@example.com');
    const subs = db.prepare<{ id: string }>(
      'SELECT id FROM subscriptions WHERE tenant_id = ?',
    ).all(result.tenantId);
    assert.equal(subs.length, 1);
  });
});
