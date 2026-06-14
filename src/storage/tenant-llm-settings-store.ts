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

/**
 * 各 provider 的默认 chat/embedding 模型。
 * 用途：租户切到**异于全局**的 provider 但未显式配 model 时——全局 model 是为全局 provider
 * 准备的模型名（如 anthropic 的 claude-sonnet），不能盲目发给另一个 provider（openai 没这个模型）。
 * 此时用该 provider 的默认模型。同 provider 则继续沿用全局 model（尊重运维配置）。
 *
 * 注：anthropic 不支持 embedding（ModelRouter dispatchEmbedOnce 抛错）；其 embedding 默认沿用
 * openai 系列模型名仅作占位——anthropic 主 provider 的 embedding 实际由 fallback 或全局路径承担。
 */
const PROVIDER_DEFAULT_MODELS: Readonly<Record<string, { chat: string; embedding: string }>> = {
  openai: { chat: 'gpt-4o', embedding: 'text-embedding-3-small' },
  anthropic: { chat: 'claude-sonnet-4-5-20250929', embedding: 'text-embedding-3-small' },
  ollama: { chat: 'llama3', embedding: 'nomic-embed-text' },
  mock: { chat: 'mock', embedding: 'mock' },
};

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
 * 无偏好 row → 完全回退全局（按全局 provider 解析 BYOK key，保持既有 BYOK 行为）。
 *
 * 有偏好时，**区分有效 provider 是否等于全局 provider**（Codex #129 复审修：跨 provider 时所有
 * 「全局值」都不可盲目沿用——全局 key/model/baseUrl 是为全局 provider 准备的）：
 *   - 同 provider：继承全局 model/embeddingModel/baseUrl，apiKey 按该 provider 解析 BYOK key
 *     缺失回退全局 key（合法——同 provider 的全局 key 就是给它的）。
 *   - 跨 provider：model/embeddingModel 用租户显式覆盖 → 否则用**该 provider 默认**（绝不沿用全局
 *     provider 的模型名）；baseUrl 用租户覆盖 → 否则 undefined（绝不沿用全局 provider 的端点）；
 *     apiKey 只用该 provider 的 BYOK key，**无则 undefined**——绝不借全局 provider 的平台 key
 *     （否则把 A provider 的平台 key 当 B provider key 用：功能必错 + 平台 key 可能外送到租户
 *     可控 base_url，是安全面）。
 *
 * fallbacks 始终用全局（降级链是平台级策略，非租户配置项）。⚠️ **语义披露**：fallback 档用
 * 平台凭据——若租户主 provider 因可用性失败而降级，该次降级走平台 key。本特性是「优先用租户
 * key」而非「所有流量必须用租户 key」；后者需后续做 per-tenant fallback opt-out（已登记）。
 *
 * fail-closed 语义随 resolveLlmApiKey：有效 provider 有 BYOK row 但解密失败 → 抛错（不静默用平台
 * key）。启动期调用方若需对坏 row 优雅降级，应用 resolveTenantLlmConfigAtStartup。
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

  const provider = settings.active_provider;
  const sameAsGlobal = provider === global.provider;
  const defaults = PROVIDER_DEFAULT_MODELS[provider] ?? PROVIDER_DEFAULT_MODELS.mock;

  /* 有效 endpoint：租户覆盖 → 否则同 provider 沿用全局端点 / 跨 provider undefined。 */
  const effectiveBaseUrl = settings.base_url ?? (sameAsGlobal ? global.baseUrl : undefined);

  /* 平台 key 仅当「同 provider **且 endpoint 仍是全局平台端点**」时才作合法 fallback。
   * 安全门（收口审查）：若租户把 base_url 覆盖成自定义 endpoint（≠全局），即便同 provider 也
   * **绝不**把平台 key 外送到租户可控端点——只用该租户自己的 BYOK key（无则 undefined）。
   * 跨 provider 一律不借平台 key（既有逻辑）。 */
  const endpointIsGlobalPlatform = effectiveBaseUrl === global.baseUrl;
  const keyFallback = (sameAsGlobal && endpointIsGlobalPlatform) ? global.apiKey : undefined;

  return {
    provider,
    /* 跨 provider 不沿用全局 model/embeddingModel（那是全局 provider 的模型名），用该 provider 默认。 */
    model: settings.model ?? (sameAsGlobal ? global.model : defaults.chat),
    embeddingModel: settings.embedding_model ?? (sameAsGlobal ? global.embeddingModel : defaults.embedding),
    apiKey: resolveLlmApiKey(tx, tenantId, provider, encryption, keyFallback),
    baseUrl: effectiveBaseUrl,
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
