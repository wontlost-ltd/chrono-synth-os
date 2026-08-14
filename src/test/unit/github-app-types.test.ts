/**
 * 单元测试：GitHub App/Installation kernel 契约（github-app-types）。
 *
 * kernel 契约层只声明 Query/Command 的 { kind, params } 形状（不含 SQL——SQL 在
 * src/storage/executors 的执行器里，与 llm-credential-queries.ts / llm-credential-executors.ts
 * 同架构）。因此本测试断言的是「契约形状」这一参数化等价物：
 *   githubInstallQueryByHostIid 生成的 Query 必须在 params 里同时携带 githubHost 与
 *   installationId 两列，对应 Task 1 建的 UNIQUE(github_host, installation_id) 全局唯一约束
 *   （webhook 反查的安全不变量：一个 (host, installation) 只能属于一个 tenant）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_INSTALL_QUERY_BY_HOST_IID,
  GITHUB_APPCRED_QUERY_BY_TENANT,
  GITHUB_APPCRED_CMD_UPSERT,
  GITHUB_APPCRED_CMD_DELETE,
  GITHUB_INSTALL_CMD_UPSERT,
  GITHUB_INSTALL_QUERY_LIST_BY_TENANT,
  githubInstallQueryByHostIid,
  githubAppCredQueryByTenant,
  githubAppCredUpsert,
  githubAppCredDelete,
  githubInstallUpsert,
  githubInstallListByTenant,
  type GithubAppCredentialRow,
  type GithubInstallationRow,
} from '@chrono/kernel';

describe('github-app-types kernel 契约', () => {
  describe('githubInstallQueryByHostIid（webhook 反查关键）', () => {
    it('按 (github_host, installation_id) 两列过滤——params 同时携带两列', () => {
      const q = githubInstallQueryByHostIid({ githubHost: 'github.com', installationId: '123' });
      // 参数化等价于 WHERE github_host = ? AND installation_id = ?：两过滤列都在 params 里
      assert.equal(q.kind, GITHUB_INSTALL_QUERY_BY_HOST_IID);
      assert.equal(q.params.githubHost, 'github.com');
      assert.equal(q.params.installationId, '123');
    });

    it('两列都必须存在（缺一即无法定位唯一 installation）', () => {
      const q = githubInstallQueryByHostIid({ githubHost: 'ghe.example.com', installationId: '999' });
      const keys = Object.keys(q.params).sort();
      assert.deepEqual(keys, ['githubHost', 'installationId']);
    });

    it('GitHub Enterprise 自托管 host 也能反查（host 不硬编码 github.com）', () => {
      const q = githubInstallQueryByHostIid({ githubHost: 'ghe.corp.internal', installationId: '42' });
      assert.equal(q.params.githubHost, 'ghe.corp.internal');
      assert.equal(q.params.installationId, '42');
    });
  });

  describe('App 凭据契约（per-tenant 单例，同 BYOK upsert 语义）', () => {
    it('githubAppCredQueryByTenant → 按 tenant 查，params 是 tenantId', () => {
      const q = githubAppCredQueryByTenant('tenant-a');
      assert.equal(q.kind, GITHUB_APPCRED_QUERY_BY_TENANT);
      assert.equal(q.params, 'tenant-a');
    });

    it('githubAppCredUpsert → 覆盖语义，密文列透传', () => {
      const cmd = githubAppCredUpsert({
        tenantId: 'tenant-a',
        appId: 'app-123',
        privateKeyEncrypted: 'enc-pk',
        webhookSecretEncrypted: 'enc-ws',
        gheBaseUrl: null,
        createdBy: 'user-1',
        now: 1000,
      });
      assert.equal(cmd.kind, GITHUB_APPCRED_CMD_UPSERT);
      assert.equal(cmd.params.tenantId, 'tenant-a');
      assert.equal(cmd.params.privateKeyEncrypted, 'enc-pk');
      assert.equal(cmd.params.webhookSecretEncrypted, 'enc-ws');
      assert.equal(cmd.params.gheBaseUrl, null);
    });

    it('githubAppCredUpsert 支持 GHE base url（自托管实例）', () => {
      const cmd = githubAppCredUpsert({
        tenantId: 'tenant-a',
        appId: 'app-123',
        privateKeyEncrypted: 'enc-pk',
        webhookSecretEncrypted: 'enc-ws',
        gheBaseUrl: 'https://ghe.corp.internal/api/v3',
        createdBy: null,
        now: 1000,
      });
      assert.equal(cmd.params.gheBaseUrl, 'https://ghe.corp.internal/api/v3');
      assert.equal(cmd.params.createdBy, null);
    });

    it('githubAppCredDelete → 按 tenant 删（撤销 / GDPR 擦除）', () => {
      const cmd = githubAppCredDelete('tenant-a');
      assert.equal(cmd.kind, GITHUB_APPCRED_CMD_DELETE);
      assert.equal(cmd.params, 'tenant-a');
    });
  });

  describe('Installation 契约', () => {
    it('githubInstallUpsert → 携带映射全字段', () => {
      const cmd = githubInstallUpsert({
        id: 'inst-row-1',
        tenantId: 'tenant-a',
        installationId: '123',
        githubHost: 'github.com',
        account: 'acme',
        repos: '["acme/repo"]',
        now: 2000,
      });
      assert.equal(cmd.kind, GITHUB_INSTALL_CMD_UPSERT);
      assert.equal(cmd.params.installationId, '123');
      assert.equal(cmd.params.githubHost, 'github.com');
      assert.equal(cmd.params.account, 'acme');
      assert.equal(cmd.params.repos, '["acme/repo"]');
    });

    it('githubInstallListByTenant → 按 tenant 列举，params 是 tenantId', () => {
      const q = githubInstallListByTenant('tenant-a');
      assert.equal(q.kind, GITHUB_INSTALL_QUERY_LIST_BY_TENANT);
      assert.equal(q.params, 'tenant-a');
    });
  });

  describe('Row 类型对齐 DB 列（编译期校验 + 运行期形状）', () => {
    it('GithubAppCredentialRow 字段与表列一致', () => {
      const row: GithubAppCredentialRow = {
        tenant_id: 't',
        app_id: 'a',
        private_key_encrypted: 'pk',
        webhook_secret_encrypted: 'ws',
        ghe_base_url: null,
        created_by: null,
        created_at: 1,
        updated_at: 2,
      };
      assert.deepEqual(Object.keys(row).sort(), [
        'app_id', 'created_at', 'created_by', 'ghe_base_url',
        'private_key_encrypted', 'tenant_id', 'updated_at', 'webhook_secret_encrypted',
      ]);
    });

    it('GithubInstallationRow 字段与表列一致', () => {
      const row: GithubInstallationRow = {
        id: 'i',
        tenant_id: 't',
        installation_id: '1',
        github_host: 'github.com',
        account: null,
        repos: null,
        created_at: 1,
        updated_at: 2,
        /* v127 安装入口产品化：暂停状态列（可空，NULL=未暂停）。 */
        suspended_at: null,
      };
      assert.deepEqual(Object.keys(row).sort(), [
        'account', 'created_at', 'github_host', 'id',
        'installation_id', 'repos', 'suspended_at', 'tenant_id', 'updated_at',
      ]);
    });
  });
});
