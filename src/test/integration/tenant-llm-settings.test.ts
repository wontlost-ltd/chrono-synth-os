/**
 * BYOK per-tenant provider preference：active provider 偏好存储 + 有效配置解析 + GDPR。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { FieldEncryption } from '../../storage/encryption.js';
import { LlmCredentialStore } from '../../storage/llm-credential-store.js';
import {
  TenantLlmSettingsStore, resolveTenantLlmConfig, resolveTenantLlmConfigAtStartup,
  type GlobalLlmConfig,
} from '../../storage/tenant-llm-settings-store.js';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import type { IDatabase } from '../../storage/index.js';

const TENANT = 'tenant_a';
const ENC = { enabled: true, masterKey: Buffer.alloc(32, 7).toString('base64'), keyring: {}, defaultKeyRef: 'master', keyRotationIntervalDays: 90 };

/* 全局 config（active provider=anthropic）。 */
const GLOBAL: GlobalLlmConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  embeddingModel: 'text-embedding-3-small',
  apiKey: 'sk-global-anthropic',
  baseUrl: undefined,
  fallbacks: [{ provider: 'ollama', model: 'llama3' }],
};

describe('BYOK per-tenant provider preference', () => {
  let db: IDatabase;
  let enc: FieldEncryption;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    enc = new FieldEncryption(ENC);
  });

  it('无偏好 row → resolveTenantLlmConfig 完全回退全局 config（向后兼容）', () => {
    const eff = resolveTenantLlmConfig(db, TENANT, GLOBAL, enc);
    assert.equal(eff.provider, 'anthropic');
    assert.equal(eff.model, GLOBAL.model);
    assert.equal(eff.apiKey, 'sk-global-anthropic');   // 无 BYOK row → 回退全局 key
    assert.deepEqual(eff.fallbacks, GLOBAL.fallbacks);
  });

  it('租户切到自己的 active provider（openai）+ 取该 provider 的 BYOK key', () => {
    /* 租户存了 openai 的 key，并把 active provider 切到 openai。 */
    new LlmCredentialStore(db, enc, TENANT).store('openai', 'sk-tenant-openai', 'u', 1000);
    new TenantLlmSettingsStore(db, TENANT).upsert({ activeProvider: 'openai', now: 1000 });

    const eff = resolveTenantLlmConfig(db, TENANT, GLOBAL, enc);
    assert.equal(eff.provider, 'openai');                 // 用租户选的 provider，不是全局 anthropic
    assert.equal(eff.apiKey, 'sk-tenant-openai');         // 取的是 openai 的 per-tenant key
    assert.equal(eff.model, GLOBAL.model);                // 未覆盖 → 沿用全局 model
  });

  it('model/embedding/baseUrl 覆盖：非空覆盖，空/未设沿用全局', () => {
    new TenantLlmSettingsStore(db, TENANT).upsert({
      activeProvider: 'ollama', model: 'qwen2', baseUrl: 'http://10.0.0.5:11434', now: 1000,
    });
    const eff = resolveTenantLlmConfig(db, TENANT, GLOBAL, enc);
    assert.equal(eff.provider, 'ollama');
    assert.equal(eff.model, 'qwen2');                     // 覆盖
    assert.equal(eff.baseUrl, 'http://10.0.0.5:11434');   // 覆盖
    assert.equal(eff.embeddingModel, GLOBAL.embeddingModel); // 未设 → 沿用全局
  });

  it('active provider=ollama 无需 key：apiKey 回退全局（可 undefined），不抛错', () => {
    new TenantLlmSettingsStore(db, TENANT).upsert({ activeProvider: 'ollama', now: 1000 });
    const noKeyGlobal: GlobalLlmConfig = { ...GLOBAL, apiKey: undefined };
    const eff = resolveTenantLlmConfig(db, TENANT, noKeyGlobal, enc);
    assert.equal(eff.provider, 'ollama');
    assert.equal(eff.apiKey, undefined);                  // ollama 无需 key，回退全局 undefined
  });

  it('upsert 覆盖更新（一租户一行）+ 非法 provider 抛错', () => {
    const store = new TenantLlmSettingsStore(db, TENANT);
    store.upsert({ activeProvider: 'openai', now: 1000 });
    store.upsert({ activeProvider: 'anthropic', now: 2000 });
    assert.equal(store.get()?.active_provider, 'anthropic');
    const cnt = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM tenant_llm_settings WHERE tenant_id=?').get(TENANT)?.c;
    assert.equal(cnt, 1, '一租户一行，覆盖不多行');
    assert.throws(() => store.upsert({ activeProvider: 'gpt5', now: 3000 }), /非法 active_provider/);
  });

  it('租户隔离：A 的偏好，B 读不到（B 回退全局）', () => {
    new TenantLlmSettingsStore(db, 'A').upsert({ activeProvider: 'openai', now: 1000 });
    const effB = resolveTenantLlmConfig(db, 'B', GLOBAL, enc);
    assert.equal(effB.provider, 'anthropic', 'B 无偏好 → 全局 anthropic');
  });

  it('fail-closed：active provider 有 BYOK row 但解密失败 → resolveTenantLlmConfig 抛错（不静默用平台 key）', () => {
    new LlmCredentialStore(db, enc, TENANT).store('openai', 'sk-tenant-openai', 'u', 1000);
    new TenantLlmSettingsStore(db, TENANT).upsert({ activeProvider: 'openai', now: 1000 });
    /* 换一把 key 解 → 解密失败。 */
    const otherEnc = new FieldEncryption({ ...ENC, masterKey: Buffer.alloc(32, 9).toString('base64') });
    assert.throws(() => resolveTenantLlmConfig(db, TENANT, GLOBAL, otherEnc));
  });

  it('启动期安全变体：坏 BYOK row 不抛错，回退全局（不阻断 boot）', () => {
    new LlmCredentialStore(db, enc, TENANT).store('openai', 'sk-tenant-openai', 'u', 1000);
    new TenantLlmSettingsStore(db, TENANT).upsert({ activeProvider: 'openai', now: 1000 });
    const otherEnc = new FieldEncryption({ ...ENC, masterKey: Buffer.alloc(32, 9).toString('base64') });
    /* 启动期版本：解密失败回退全局，不抛。 */
    const eff = resolveTenantLlmConfigAtStartup(db, TENANT, GLOBAL, otherEnc);
    assert.equal(eff.provider, 'anthropic');              // 退回全局
    assert.equal(eff.apiKey, 'sk-global-anthropic');
  });
});

describe('BYOK provider preference GDPR：标准导出 + 擦除', () => {
  let os: ChronoSynthOS | undefined;
  afterEach(() => { os?.close(); os = undefined; });

  it('导出含偏好；擦除删除偏好', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    os = new ChronoSynthOS({ db, skipMigrations: true, clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    new TenantLlmSettingsStore(db, 'default').upsert({ activeProvider: 'openai', model: 'gpt-4o', now: 1000 });

    const privacy = new PrivacyService(os, undefined);
    const tables = privacy.exportData('default').content.tables as Record<string, Array<Record<string, unknown>>>;
    const rows = tables.tenant_llm_settings;
    assert.ok(rows?.length === 1, '应导出偏好');
    assert.equal(rows[0].active_provider, 'openai');

    privacy.eraseData('default');
    assert.equal(
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM tenant_llm_settings WHERE tenant_id = ?').get('default')?.c, 0,
      '偏好应随擦除删除',
    );
  });
});
