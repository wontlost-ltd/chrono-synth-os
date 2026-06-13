/**
 * 租户级 active LLM provider 偏好 — store + 有效配置解析（BYOK 后续）。
 *
 * BYOK（llm-credential-store）解决「用哪个 key」，本模块解决「用哪个 provider」：
 *   - TenantLlmSettingsStore：读写租户 active provider 偏好（非 secret 配置）。
 *   - resolveTenantLlmConfig：把全局 config.intelligence 与租户偏好合并成「有效 LLM 配置」
 *     （provider/model/embeddingModel/baseUrl + 按有效 provider 解析的 BYOK key + 全局 fallbacks），
 *     供 ModelRouter 构造。无偏好 row → 完全回退全局 config（行为不变 = 向后兼容）。
 *
 * 关键：apiKey 按**有效 provider**（可能 ≠ 全局 provider）解析 BYOK key——租户切到自己的
 * provider 时，取的是该 provider 的 per-tenant key，而非全局 provider 的 key。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  tenantLlmSettingsQueryByTenant, tenantLlmSettingsCmdUpsert, tenantLlmSettingsCmdDelete,
  type TenantLlmSettingsRow,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';
import { FieldEncryption } from './encryption.js';
import { resolveLlmApiKey } from './llm-credential-store.js';

/** 有效 provider 枚举（与 config.intelligence.provider / LLMProviderName 对齐）。 */
const VALID_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'anthropic', 'ollama', 'mock']);

/** 全局 LLM 配置中本模块需要的子集（避免直接依赖 AppConfig 整块）。 */
export interface GlobalLlmConfig {
  readonly provider: string;
  readonly model: string;
  readonly embeddingModel: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fallbacks?: readonly LlmFallbackSpec[];
}

export interface LlmFallbackSpec {
  readonly provider: string;
  readonly model: string;
  readonly embeddingModel?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** ModelRouter 构造该用的「有效」LLM 配置（全局 ∪ 租户偏好）。 */
export interface EffectiveLlmConfig {
  readonly provider: string;
  readonly model: string;
  readonly embeddingModel: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fallbacks?: readonly LlmFallbackSpec[];
}

export class TenantLlmSettingsStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /** 取本租户偏好；无则 undefined（调用方回退全局）。 */
  get(): TenantLlmSettingsRow | undefined {
    return this.tx.queryOne(tenantLlmSettingsQueryByTenant(this.tenantId)) ?? undefined;
  }

  /**
   * 设置本租户 active provider（及可选 model/embedding/baseUrl 覆盖；空串/undefined → NULL 沿用全局）。
   * 校验 provider 枚举——非法 provider 抛错（避免落库无法路由的脏值）。
   */
  upsert(input: {
    activeProvider: string;
    model?: string | null;
    embeddingModel?: string | null;
    baseUrl?: string | null;
    updatedBy?: string | null;
    now: number;
  }): void {
    const provider = input.activeProvider.trim();
    if (!VALID_PROVIDERS.has(provider)) {
      throw new Error(`非法 active_provider: ${input.activeProvider}（须为 openai/anthropic/ollama/mock）`);
    }
    this.tx.execute(tenantLlmSettingsCmdUpsert({
      tenantId: this.tenantId,
      activeProvider: provider,
      model: normalizeOptional(input.model),
      embeddingModel: normalizeOptional(input.embeddingModel),
      baseUrl: normalizeOptional(input.baseUrl),
      updatedBy: input.updatedBy ?? null,
      now: input.now,
    }));
  }

  /** 删除偏好（恢复全局默认 / GDPR）。 */
  delete(): void {
    this.tx.execute(tenantLlmSettingsCmdDelete(this.tenantId));
  }
}

/** 空串视为「不覆盖」（→ NULL），保留有意义的非空值。 */
function normalizeOptional(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 解析某租户构造 ModelRouter 该用的有效 LLM 配置（全局 config ∪ 租户偏好）。
 *
 * 无偏好 row → 直接返回全局配置（行为不变）。有偏好 → 用 active_provider，model/embedding/baseUrl
 * 仅覆盖非空项；apiKey 按**有效 provider** 解析 BYOK key（缺失回退全局 key）。fallbacks 始终用
 * 全局（降级链是平台级策略，非租户配置项）。
 *
 * fail-closed 语义随 resolveLlmApiKey：有 BYOK row 但解密失败 → 抛错（不静默用平台 key）。
 * 启动期调用方若需对坏 row 优雅降级，应用 resolveTenantLlmConfigAtStartup。
 */
export function resolveTenantLlmConfig(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  global: GlobalLlmConfig,
  encryption: FieldEncryption | undefined,
): EffectiveLlmConfig {
  const settings = new TenantLlmSettingsStore(tx, tenantId).get();

  /* 无偏好：完全回退全局（含按全局 provider 解析的 BYOK key，保持既有 BYOK 行为）。 */
  if (!settings) {
    return {
      provider: global.provider,
      model: global.model,
      embeddingModel: global.embeddingModel,
      apiKey: resolveLlmApiKey(tx, tenantId, global.provider, encryption, global.apiKey),
      baseUrl: global.baseUrl,
      fallbacks: global.fallbacks,
    };
  }

  /* 有偏好：active provider + 非空覆盖；apiKey 按有效 provider 解析 BYOK key。 */
  const provider = settings.active_provider;
  return {
    provider,
    model: settings.model ?? global.model,
    embeddingModel: settings.embedding_model ?? global.embeddingModel,
    apiKey: resolveLlmApiKey(tx, tenantId, provider, encryption, global.apiKey),
    baseUrl: settings.base_url ?? global.baseUrl,
    fallbacks: global.fallbacks,
  };
}

/**
 * resolveTenantLlmConfig 的**启动期安全变体**：解密坏 row 时回退全局，不抛错——避免一个坏的
 * 默认租户偏好/凭据阻断 app 启动。请求期仍用严格的 resolveTenantLlmConfig（fail-closed）。
 */
export function resolveTenantLlmConfigAtStartup(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  global: GlobalLlmConfig,
  encryption: FieldEncryption | undefined,
): EffectiveLlmConfig {
  try {
    return resolveTenantLlmConfig(tx, tenantId, global, encryption);
  } catch {
    /* 坏 row：退回全局配置（不解析 BYOK key），保证 boot 不被阻断。 */
    return {
      provider: global.provider,
      model: global.model,
      embeddingModel: global.embeddingModel,
      apiKey: global.apiKey,
      baseUrl: global.baseUrl,
      fallbacks: global.fallbacks,
    };
  }
}
