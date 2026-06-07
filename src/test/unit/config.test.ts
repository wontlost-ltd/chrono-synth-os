import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, AppConfigSchema, intelligenceProvidesEmbeddings } from '../../config/index.js';

describe('配置系统', () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    Object.keys(savedEnv).forEach(k => delete savedEnv[k]);
  });

  it('无参数加载返回默认配置', () => {
    const config = loadConfig();
    assert.equal(config.db.path, ':memory:');
    assert.equal(config.log.level, 'info');
    assert.equal(config.log.json, false);
    assert.equal(config.server.host, '0.0.0.0');
    assert.equal(config.server.port, 3000);
    assert.equal(config.integration.fitnessThreshold, 0.6);
    assert.equal(config.integration.confidenceThreshold, 0.5);
  });

  it('overrides 覆盖默认值', () => {
    const config = loadConfig({ db: { path: './test.db' }, server: { host: '127.0.0.1', port: 8080 } });
    assert.equal(config.db.path, './test.db');
    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.server.port, 8080);
  });

  describe('intelligenceProvidesEmbeddings（ADR-0047 Ollama layer-2 embedding gate）', () => {
    it('ollama 无 apiKey → true（本地 provider 不需 key 即可 embedding，修复静默禁用 bug）', () => {
      const config = loadConfig({ intelligence: { provider: 'ollama', baseUrl: 'http://localhost:11434' } });
      assert.equal(config.intelligence.apiKey, undefined);
      assert.equal(intelligenceProvidesEmbeddings(config), true);
    });

    it('openai 无 apiKey → false，有 apiKey → true', () => {
      assert.equal(intelligenceProvidesEmbeddings(loadConfig({ intelligence: { provider: 'openai' } })), false);
      assert.equal(intelligenceProvidesEmbeddings(loadConfig({ intelligence: { provider: 'openai', apiKey: 'sk-x' } })), true);
    });

    it('anthropic 即便有 apiKey → false（无 embedding 接口，不注入会抛错的 provider）', () => {
      assert.equal(intelligenceProvidesEmbeddings(loadConfig({ intelligence: { provider: 'anthropic' } })), false);
      assert.equal(intelligenceProvidesEmbeddings(loadConfig({ intelligence: { provider: 'anthropic', apiKey: 'sk-ant' } })), false);
    });

    it('mock 维持原行为（按 apiKey gate）：无 key → false', () => {
      assert.equal(intelligenceProvidesEmbeddings(loadConfig({ intelligence: { provider: 'mock' } })), false);
    });
  });

  it('环境变量覆盖默认值', () => {
    setEnv('CHRONO_DB_PATH', '/tmp/env.db');
    setEnv('CHRONO_SERVER_PORT', '9090');
    setEnv('CHRONO_LOG_JSON', 'true');
    setEnv('CHRONO_OBSERVABILITY_WORKER_HTTP_PORT', '3110');
    setEnv('CHRONO_OBSERVABILITY_KAFKA_STARTUP_WAIT_MS', '45000');
    setEnv('CHRONO_RUNTIME_SESSION_TIMEOUT_MS', '90000');
    setEnv('CHRONO_BILLING_RECONCILIATION_ENABLED', 'true');
    setEnv('CHRONO_BILLING_RECONCILIATION_BATCH_SIZE', '25');
    setEnv('CHRONO_AUTH_METRICS_API_KEYS', 'scrape-a,scrape-b');
    setEnv('CHRONO_ENCRYPTION_DEFAULT_KEY_REF', 'tenant-enterprise');
    setEnv('CHRONO_ENCRYPTION_KEYRING_JSON', '{"tenant-enterprise":"dGVzdC10ZW5hbnQta2V5LXNob3VsZC1iZS0zMi1ieXRlcy0xMjM0NTY="}');
    setEnv('CHRONO_OIDC_ENABLED', 'true');
    setEnv('CHRONO_OIDC_ISSUER_URL', 'https://idp.example.test');
    setEnv('CHRONO_OIDC_CLIENT_ID', 'tenant-client');
    setEnv('CHRONO_OIDC_CLIENT_SECRET', 'tenant-secret');
    setEnv('CHRONO_SERVER_PUBLIC_URL', 'https://api.example.test');

    const config = loadConfig();
    assert.equal(config.db.path, '/tmp/env.db');
    assert.equal(config.server.port, 9090);
    assert.equal(config.log.json, true);
    assert.equal(config.observability.worker.http.port, 3110);
    assert.equal(config.observability.kafka.startupWaitMs, 45000);
    assert.equal(config.runtime.recovery.sessionTimeoutMs, 90000);
    assert.equal(config.billing.reconciliation.enabled, true);
    assert.equal(config.billing.reconciliation.batchSize, 25);
    assert.deepEqual(config.auth.metricsApiKeys, ['scrape-a', 'scrape-b']);
    assert.equal(config.encryption.defaultKeyRef, 'tenant-enterprise');
    assert.equal(config.oidc.enabled, true);
    assert.equal(config.oidc.issuerUrl, 'https://idp.example.test');
  });

  it('overrides 优先于环境变量', () => {
    setEnv('CHRONO_SERVER_PORT', '9090');

    const config = loadConfig({ server: { host: '0.0.0.0', port: 7070 } });
    assert.equal(config.server.port, 7070);
  });

  it('Zod 校验拒绝无效端口', () => {
    assert.throws(
      () => loadConfig({ server: { host: '0.0.0.0', port: 99999 } }),
    );
  });

  it('Zod 校验拒绝无效日志级别', () => {
    assert.throws(
      () => AppConfigSchema.parse({ log: { level: 'verbose' } }),
    );
  });

  it('不存在的配置文件不报错', () => {
    const config = loadConfig(undefined, '/nonexistent/config.json');
    assert.equal(config.db.path, ':memory:');
  });

  it('CHRONO_JWT_PRIVATE_KEY_FILE / PUBLIC_KEY_FILE 从文件路径读 PEM', async () => {
    /* 容器部署推荐 _FILE 形态：私钥仍 0600 强保护，且容器进程可以
     * 非 root 跑（host 文件给容器内 uid 可读即可）。
     * Regression test for NAS beta deployment where backend user: "0"
     * was a Major security workaround. */
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tmp = mkdtempSync(join(tmpdir(), 'jwt-file-test-'));
    const privPath = join(tmp, 'kid-1.priv.pem');
    const pubPath = join(tmp, 'kid-1.pub.pem');
    /* 假 PEM 内容，仅测试 env 是否读了文件 — schema 不解析 PEM。 */
    writeFileSync(privPath, '-----BEGIN PRIVATE KEY-----\nFAKE_PRIV_BODY\n-----END PRIVATE KEY-----\n');
    writeFileSync(pubPath, '-----BEGIN PUBLIC KEY-----\nFAKE_PUB_BODY\n-----END PUBLIC KEY-----\n');

    setEnv('CHRONO_JWT_PRIVATE_KEY_FILE', privPath);
    setEnv('CHRONO_JWT_PUBLIC_KEY_FILE', pubPath);
    setEnv('CHRONO_JWT_ENABLED', 'false');  /* avoid asym validation */

    const config = loadConfig();
    assert.match(config.jwt.privateKey, /BEGIN PRIVATE KEY/);
    assert.match(config.jwt.privateKey, /FAKE_PRIV_BODY/);
    assert.match(config.jwt.publicKey, /BEGIN PUBLIC KEY/);
    assert.match(config.jwt.publicKey, /FAKE_PUB_BODY/);
    /* 真换行被保留（不是 \n 字面量字符串） */
    assert.ok(config.jwt.privateKey.includes('\n'), 'PEM 真换行未保留');

    rmSync(tmp, { recursive: true });
  });

  it('默认 key ref 不存在于 keyring 时拒绝加载', () => {
    assert.throws(() => loadConfig({
      server: { publicUrl: 'https://api.example.test' },
      encryption: {
        enabled: true,
        masterKey: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
        defaultKeyRef: 'missing',
        keyring: {},
        keyRotationIntervalDays: 90,
      },
    }));
  });
});
