/**
 * GitHub App 凭据存储（GithubAppCredentialStore）：加密落库、解密取回、fail-closed、
 * installation → tenant 反查（安全不变量：反查不带 tenant_id）。
 *
 * 安全断言重点（Task 3 两条红线）：
 *   1. fail-closed：disabled FieldEncryption → 构造器抛错（拒绝明文私钥/webhook secret 落库）。
 *   2. 密文落库：store 后直查 private_key_encrypted / webhook_secret_encrypted 列，断言 ≠ 明文。
 *   3. 反查全局唯一：resolveTenantByInstallation 用 (github_host, installation_id) 反查未知 tenant，
 *      绝不带 tenant_id 过滤。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { FieldEncryption } from '../../storage/encryption.js';
import { GithubAppCredentialStore } from '../../storage/github-app-credential-store.js';
import type { IDatabase } from '../../storage/index.js';

const TENANT = 'tenant_a';
/* 32-byte base64 master key（FieldEncryption deriveKey 需要）。 */
const ENC = { enabled: true, masterKey: Buffer.alloc(32, 7).toString('base64'), keyring: {}, defaultKeyRef: 'master', keyRotationIntervalDays: 90 };

const PRIVATE_KEY_PEM = '-----BEGIN RSA PRIVATE KEY-----\nSUPER_SECRET_KEY_MATERIAL\n-----END RSA PRIVATE KEY-----';
const WEBHOOK_SECRET = 'whsec_SUPERSECRET';

describe('GitHub App 凭据存储', () => {
  let db: IDatabase;
  let enc: FieldEncryption;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    enc = new FieldEncryption(ENC);
  });

  it('硬安全边界：disabled FieldEncryption → 构造器抛错（拒绝明文落库私钥/secret）', () => {
    const disabled = new FieldEncryption({ ...ENC, enabled: false });
    assert.throws(() => new GithubAppCredentialStore(db, disabled, TENANT), /启用的 FieldEncryption/);
  });

  it('storeApp → getApp 往返：私钥/webhook secret 密文落库明文不落库，getApp 解密回原文', () => {
    const store = new GithubAppCredentialStore(db, enc, TENANT);
    store.storeApp('app_123', PRIVATE_KEY_PEM, WEBHOOK_SECRET, 'https://ghe.example.com', 'user_1', 1000);

    /* 直查库：加密列里只有密文，绝无明文片段。 */
    const row = db.prepare<{ private_key_encrypted: string; webhook_secret_encrypted: string; app_id: string; ghe_base_url: string | null }>(
      'SELECT private_key_encrypted, webhook_secret_encrypted, app_id, ghe_base_url FROM github_app_credentials WHERE tenant_id = ?',
    ).get(TENANT);
    assert.ok(row);
    assert.notEqual(row!.private_key_encrypted, PRIVATE_KEY_PEM, '库里私钥不得是明文');
    assert.ok(!row!.private_key_encrypted.includes('SUPER_SECRET_KEY_MATERIAL'), '私钥密文不得含明文片段');
    assert.ok(!row!.webhook_secret_encrypted.includes('SUPERSECRET'), 'webhook secret 密文不得含明文片段');
    /* 非加密列照常明文落库。 */
    assert.equal(row!.app_id, 'app_123');
    assert.equal(row!.ghe_base_url, 'https://ghe.example.com');

    /* getApp 解密回明文。 */
    const app = store.getApp();
    assert.ok(app);
    assert.equal(app!.appId, 'app_123');
    assert.equal(app!.privateKeyPem, PRIVATE_KEY_PEM);
    assert.equal(app!.webhookSecret, WEBHOOK_SECRET);
    assert.equal(app!.gheBaseUrl, 'https://ghe.example.com');
  });

  it('getApp：无凭据 → undefined', () => {
    const store = new GithubAppCredentialStore(db, enc, TENANT);
    assert.equal(store.getApp(), undefined);
  });

  it('storeApp upsert：同 tenant 覆盖更新，不留版本史', () => {
    const store = new GithubAppCredentialStore(db, enc, TENANT);
    store.storeApp('app_1', PRIVATE_KEY_PEM, WEBHOOK_SECRET, null, 'u', 1000);
    store.storeApp('app_2', PRIVATE_KEY_PEM, WEBHOOK_SECRET, null, 'u', 2000);
    assert.equal(store.getApp()!.appId, 'app_2');
    const cnt = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM github_app_credentials WHERE tenant_id = ?').get(TENANT)?.c;
    assert.equal(cnt, 1, '覆盖更新，不多行');
  });

  it('resolveTenantByInstallation：命中唯一行（反查未知 tenant）', () => {
    const store = new GithubAppCredentialStore(db, enc, TENANT);
    store.upsertInstallation('inst_42', 'github.com', 'acme-org', '["acme/repo"]', 1000);

    /* 反查方**不知道** tenant，只有 (host, installation_id)。 */
    const hit = store.resolveTenantByInstallation('github.com', 'inst_42');
    assert.ok(hit);
    assert.equal(hit!.tenantId, TENANT);

    /* 不存在的 installation → undefined。 */
    assert.equal(store.resolveTenantByInstallation('github.com', 'inst_999'), undefined);
  });

  it('resolveTenantByInstallation：跨租户反查——A 装的 installation，用任意 tenant 的 store 都能反查到 A', () => {
    /* 安全不变量：反查不带 tenant_id 过滤。B 的 store 也能反查出属于 A 的 installation。 */
    new GithubAppCredentialStore(db, enc, 'tenant_A').upsertInstallation('inst_shared', 'github.com', 'a-org', null, 1000);
    const storeB = new GithubAppCredentialStore(db, enc, 'tenant_B');
    const hit = storeB.resolveTenantByInstallation('github.com', 'inst_shared');
    assert.ok(hit, '反查不受调用方 tenant 限制');
    assert.equal(hit!.tenantId, 'tenant_A', '反查返回 installation 真实归属 tenant');
  });

  it('upsertInstallation：同 (host, installation_id) 覆盖更新，id 稳定不变', () => {
    const store = new GithubAppCredentialStore(db, enc, TENANT);
    store.upsertInstallation('inst_7', 'github.com', 'org1', null, 1000);
    const id1 = db.prepare<{ id: string }>('SELECT id FROM github_installations WHERE github_host=? AND installation_id=?').get('github.com', 'inst_7')?.id;
    store.upsertInstallation('inst_7', 'github.com', 'org1-renamed', '["r"]', 2000);
    const rows = db.prepare<{ id: string; account: string | null; c: number }>(
      'SELECT id, account FROM github_installations WHERE github_host=? AND installation_id=?',
    ).all('github.com', 'inst_7');
    assert.equal(rows.length, 1, '覆盖更新，不多行');
    assert.equal(rows[0].id, id1, 'id 稳定不变（冲突更新不换主键）');
    assert.equal(rows[0].account, 'org1-renamed', '元数据被更新');
  });
});
