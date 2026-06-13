/**
 * BYOK LLM provider 凭据存储：加密落库、解密取回、per-tenant 解析优先、GDPR 脱敏导出。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { FieldEncryption } from '../../storage/encryption.js';
import { LlmCredentialStore, resolveLlmApiKey } from '../../storage/llm-credential-store.js';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import type { IDatabase } from '../../storage/index.js';

const TENANT = 'tenant_a';
/* 32-byte base64 master key（FieldEncryption deriveKey 需要）。 */
const ENC = { enabled: true, masterKey: Buffer.alloc(32, 7).toString('base64'), keyring: {}, defaultKeyRef: 'master', keyRotationIntervalDays: 90 };

describe('BYOK LLM 凭据存储', () => {
  let db: IDatabase;
  let enc: FieldEncryption;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    enc = new FieldEncryption(ENC);
  });

  it('store 加密落库（明文绝不进库）+ get 解密取回', () => {
    const store = new LlmCredentialStore(db, enc, TENANT);
    assert.equal(store.store('anthropic', 'sk-ant-SECRET', 'user_1', 1000), true);

    /* 直查库：列里只有密文，绝无明文。 */
    const row = db.prepare<{ api_key_encrypted: string }>(
      'SELECT api_key_encrypted FROM llm_provider_credentials WHERE tenant_id = ? AND provider = ?',
    ).get(TENANT, 'anthropic');
    assert.ok(row);
    assert.notEqual(row!.api_key_encrypted, 'sk-ant-SECRET', '库里不得是明文');
    assert.ok(!row!.api_key_encrypted.includes('SECRET'), '密文不得含明文片段');

    /* get 解密回明文。 */
    assert.equal(store.get('anthropic'), 'sk-ant-SECRET');
  });

  it('upsert 覆盖更新（同 provider 不留版本史）', () => {
    const store = new LlmCredentialStore(db, enc, TENANT);
    store.store('openai', 'sk-old', 'u', 1000);
    store.store('openai', 'sk-new', 'u', 2000);
    assert.equal(store.get('openai'), 'sk-new');
    const cnt = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM llm_provider_credentials WHERE tenant_id=? AND provider=?').get(TENANT, 'openai')?.c;
    assert.equal(cnt, 1, '覆盖更新，不多行');
  });

  it('租户隔离：A 存的 key，B 取不到', () => {
    new LlmCredentialStore(db, enc, 'A').store('anthropic', 'sk-A', 'u', 1000);
    assert.equal(new LlmCredentialStore(db, enc, 'B').get('anthropic'), undefined);
  });

  it('listProviders 只返回 provider 名（脱敏，不含 key）', () => {
    const store = new LlmCredentialStore(db, enc, TENANT);
    store.store('anthropic', 'sk-1', 'u', 1000);
    store.store('openai', 'sk-2', 'u', 1000);
    assert.deepEqual(store.listProviders().sort(), ['anthropic', 'openai']);
  });

  it('delete 撤销凭据', () => {
    const store = new LlmCredentialStore(db, enc, TENANT);
    store.store('anthropic', 'sk-x', 'u', 1000);
    store.delete('anthropic');
    assert.equal(store.get('anthropic'), undefined);
  });

  it('resolveLlmApiKey：有 per-tenant key → 用它；无 → 回退全局 config', () => {
    new LlmCredentialStore(db, enc, TENANT).store('anthropic', 'sk-tenant', 'u', 1000);
    /* 有 per-tenant → 用 tenant key（不是 fallback）。 */
    assert.equal(resolveLlmApiKey(db, TENANT, 'anthropic', enc, 'sk-global-fallback'), 'sk-tenant');
    /* 无 per-tenant（别 provider）→ 回退全局。 */
    assert.equal(resolveLlmApiKey(db, TENANT, 'openai', enc, 'sk-global-fallback'), 'sk-global-fallback');
    /* 无 encryption → 直接 fallback。 */
    assert.equal(resolveLlmApiKey(db, TENANT, 'anthropic', undefined, 'sk-global-fallback'), 'sk-global-fallback');
  });
});

describe('BYOK 凭据 GDPR：导出脱敏 + 擦除', () => {
  let os: ChronoSynthOS | undefined;
  afterEach(() => { os?.close(); os = undefined; });

  it('导出不含 api_key_encrypted；擦除删除凭据', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    os = new ChronoSynthOS({ db, skipMigrations: true, clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    const enc = new FieldEncryption(ENC);
    new LlmCredentialStore(db, enc, 'default').store('anthropic', 'sk-VERYSECRET', 'u', 1000);

    const privacy = new PrivacyService(os, undefined);
    const tables = privacy.exportData('default').content.tables as Record<string, Array<Record<string, unknown>>>;
    const rows = tables.llm_provider_credentials;
    assert.ok(rows?.length === 1, '应导出凭据元数据');
    assert.ok(!('api_key_encrypted' in rows[0]), 'api_key_encrypted 列不得出现在导出');
    assert.ok(!JSON.stringify(rows).includes('VERYSECRET'), '导出不得泄露密钥');

    privacy.eraseData('default');
    assert.equal(
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM llm_provider_credentials WHERE tenant_id = ?').get('default')?.c, 0,
      'BYOK 凭据应随擦除删除',
    );
  });
});
