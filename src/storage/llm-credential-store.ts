/**
 * BYOK LLM provider 凭据存储 — 薄适配器，加密在此层，密文落库。
 *
 * 安全契约：
 *   - store(provider, apiKey)：FieldEncryption 加密后落库，**明文绝不持久化**。
 *   - get(provider)：取密文解密返回明文（供 ModelRouter 用）；无凭据或未启用加密返回 undefined。
 *   - listProviders()：只返回 provider 名（脱敏，不含 key），供管理 UI。
 *   - delete(provider)：撤销 / GDPR 擦除。
 *
 * 未启用 FieldEncryption（enabled=false）时 encrypt/decrypt 是恒等——但本 store 仍要求注入
 * encryption；未注入则 store 报错（绝不明文落库）。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  llmCredQueryByTenantProvider, llmCredQueryByTenant,
  llmCredCmdUpsert, llmCredCmdDelete,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';
import { FieldEncryption } from './encryption.js';

export class LlmCredentialStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly encryption: FieldEncryption,
    private readonly tenantId: string = 'default',
  ) {
    /* 硬安全边界（Codex BYOK 复审）：拒绝 disabled FieldEncryption——否则 encrypt() 恒等返回明文，
     * api key 会明文落库。store 不依赖调用方纪律，自身 fail-closed。 */
    if (!encryption.isEnabled) {
      throw new Error('LlmCredentialStore 需要启用的 FieldEncryption（拒绝明文落库 api key）');
    }
    registerCoreSelfExecutors();
  }

  /** 加密落库某 provider 的 api key（覆盖既有）。空 key 视为无效，忽略。 */
  store(provider: string, apiKey: string, createdBy: string | null, now: number): boolean {
    if (!provider.trim() || !apiKey.trim()) return false;
    /* 加密后落库——明文绝不持久化。 */
    const apiKeyEncrypted = this.encryption.encrypt(apiKey);
    this.tx.execute(llmCredCmdUpsert({
      tenantId: this.tenantId, provider, apiKeyEncrypted, createdBy, now,
    }));
    return true;
  }

  /** 取某 provider 的明文 api key（解密）。无凭据返回 undefined。 */
  get(provider: string): string | undefined {
    const row = this.tx.queryOne(llmCredQueryByTenantProvider({ tenantId: this.tenantId, provider }));
    if (!row) return undefined;
    return this.encryption.decrypt(row.api_key_encrypted);
  }

  /** 列本租户已配置的 provider（脱敏，不含 key）。 */
  listProviders(): string[] {
    return [...this.tx.queryMany(llmCredQueryByTenant(this.tenantId))].map((r) => r.provider);
  }

  /** 删除某 provider 凭据（撤销 / GDPR）。 */
  delete(provider: string): void {
    this.tx.execute(llmCredCmdDelete({ tenantId: this.tenantId, provider }));
  }
}

/**
 * 安全构造 BYOK 用的 FieldEncryption：enabled=false 或 key 非法（如测试占位 key）时返回 undefined，
 * **不抛错**——BYOK 是可选特性，加密不可用就退化为只用全局 config key，绝不阻塞 app 启动/路由注册。
 */
export function tryByokEncryption(encryptionConfig: ConstructorParameters<typeof FieldEncryption>[0]): FieldEncryption | undefined {
  if (!encryptionConfig.enabled) return undefined;
  try {
    return new FieldEncryption(encryptionConfig);
  } catch {
    return undefined;
  }
}

/**
 * 解析 ModelRouter 构造该用的 api key（BYOK）：优先本租户该 provider 的加密 key，
 * 缺失则回退全局 config 的 key（向后兼容）。加密未启用时直接返回 fallback。
 * **fail-closed**（Codex 复审）：有 BYOK row 但解密失败 → **抛错**（不静默回退平台 key）。
 * 调用方（ModelRouter 构造处）若需对坏 row 优雅降级，应自行 try/catch。
 */
export function resolveLlmApiKey(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  provider: string,
  encryption: FieldEncryption | undefined,
  configFallback: string | undefined,
): string | undefined {
  /* 加密未配置（disabled/key 非法 → tryByokEncryption 返回 undefined）：BYOK 不可用，回退全局。 */
  if (!encryption || !encryption.isEnabled) return configFallback;
  const store = new LlmCredentialStore(tx, encryption, tenantId);
  /* fail-closed 语义（Codex BYOK 复审）：区分「无 row」与「解密失败」。
   * 无 row → 回退全局（合法兼容）；有 row 但解密失败 → **抛错**，绝不静默改用平台 key
   * （否则用户以为用自己的 key 实际走平台 key，计费/合规/审计风险）。 */
  return store.get(provider) ?? configFallback;
}

/**
 * resolveLlmApiKey 的**启动期安全变体**（Codex BYOK 复审）：用于 app 初始化时构造的默认租户 router。
 * 解密失败时回退全局 config 而非抛错——避免一个坏的默认租户 BYOK row 阻断**整个 app 启动**。
 * 请求期路由仍用严格的 resolveLlmApiKey（fail-closed，坏 key 让该请求报错而非静默用平台 key）。
 */
export function resolveLlmApiKeyAtStartup(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  provider: string,
  encryption: FieldEncryption | undefined,
  configFallback: string | undefined,
): string | undefined {
  try {
    return resolveLlmApiKey(tx, tenantId, provider, encryption, configFallback);
  } catch {
    /* 启动期坏 row：退回全局 config，不阻断 boot（请求期会用严格版重新解析 per-tenant）。 */
    return configFallback;
  }
}
