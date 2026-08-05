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

  it('getApp 跨租户隔离：同 DB 两租户各存各的凭据，各读回自己的（byTenant 必带 WHERE tenant_id）', () => {
    /* 安全不变量（app-cred 方向，与反查方向对称）：github_app_credentials 是 per-tenant 单例，
     * getApp 的 byTenant 查询**必须**带 WHERE tenant_id 过滤——否则 B 会读到 A 的私钥凭据（跨租户泄漏）。
     * 本用例在同一 DB 建两租户各一条 app-cred 行，若 byTenant 去掉 tenant_id 过滤（取任意首行），
     * B 就会读到 A 的 'appA'，断言必然失败。 */
    new GithubAppCredentialStore(db, enc, 'tenant_A').storeApp('appA', PRIVATE_KEY_PEM, WEBHOOK_SECRET, null, 'ua', 1000);
    new GithubAppCredentialStore(db, enc, 'tenant_B').storeApp('appB', PRIVATE_KEY_PEM, WEBHOOK_SECRET, null, 'ub', 2000);

    /* B 读到 B 自己的（不是 A 的）。 */
    const appB = new GithubAppCredentialStore(db, enc, 'tenant_B').getApp();
    assert.ok(appB, 'B 应读到自己的凭据');
    assert.equal(appB!.appId, 'appB', 'B 读到自己的 appB（byTenant 不受污染，绝非 A 的 appA）');

    /* 反向：A 读到 A 自己的（不是 B 的）。 */
    const appA = new GithubAppCredentialStore(db, enc, 'tenant_A').getApp();
    assert.ok(appA, 'A 应读到自己的凭据');
    assert.equal(appA!.appId, 'appA', 'A 读到自己的 appA（byTenant 不受污染，绝非 B 的 appB）');
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

  /* 安装入口产品化：装/卸/暂停/改授权的存储侧能力。删除与暂停按
   * (github_host, installation_id) 全局唯一键定位——平台级映射表，不带 tenant 过滤
   * （与 resolveTenantByInstallation 同款）。 */
  describe('installation 生命周期（删除 / 暂停 / 授权仓库同步）', () => {
    /** 直查 suspended_at 列（绕过 store，验证列真被写入）。 */
    function readSuspendedAt(installationId: string): number | null {
      const row = db.prepare<{ suspended_at: number | null }>(
        'SELECT suspended_at FROM github_installations WHERE github_host=? AND installation_id=?',
      ).get('github.com', installationId);
      return row?.suspended_at ?? null;
    }

    it('deleteInstallation：删除后反查不到（卸载即停学的存储侧基础）', () => {
      const store = new GithubAppCredentialStore(db, enc, TENANT);
      store.upsertInstallation('inst_1', 'github.com', 'acme', 'acme/web', 1000);
      assert.ok(store.resolveTenantByInstallation('github.com', 'inst_1'), '删前能反查到');

      const deleted = store.deleteInstallation('github.com', 'inst_1');

      assert.equal(deleted, true, '应报告删除成功');
      assert.equal(store.resolveTenantByInstallation('github.com', 'inst_1'), undefined, '删后反查不到');
    });

    it('deleteInstallation：删不存在的行返回 false（幂等，不抛错）', () => {
      const store = new GithubAppCredentialStore(db, enc, TENANT);
      assert.equal(store.deleteInstallation('github.com', 'never_existed'), false);
    });

    it('setInstallationSuspended：置位与清除 suspended_at', () => {
      const store = new GithubAppCredentialStore(db, enc, TENANT);
      store.upsertInstallation('inst_2', 'github.com', 'acme', null, 1000);

      store.setInstallationSuspended('github.com', 'inst_2', 5000, 5000);
      assert.equal(readSuspendedAt('inst_2'), 5000, 'suspend 置位');

      store.setInstallationSuspended('github.com', 'inst_2', null, 6000);
      assert.equal(readSuspendedAt('inst_2'), null, 'unsuspend 清除');
    });

    it('updateInstallationRepos：同步授权仓库列表（该列此前写了从不读）', () => {
      const store = new GithubAppCredentialStore(db, enc, TENANT);
      store.upsertInstallation('inst_3', 'github.com', 'acme', 'acme/web', 1000);

      store.updateInstallationRepos('github.com', 'inst_3', 'acme/web,acme/api', 2000);

      const row = db.prepare<{ repos: string | null }>(
        'SELECT repos FROM github_installations WHERE github_host=? AND installation_id=?',
      ).get('github.com', 'inst_3');
      assert.equal(row?.repos, 'acme/web,acme/api');
    });

    it('新建 installation 默认未暂停（suspended_at 为 NULL，既有行兼容）', () => {
      const store = new GithubAppCredentialStore(db, enc, TENANT);
      store.upsertInstallation('inst_4', 'github.com', 'acme', null, 1000);
      assert.equal(readSuspendedAt('inst_4'), null);
    });
  });
});
