import { z } from 'zod';

/**
 * Companion「LLM 老师接入配置」契约（ADR-0047「LLM 当老师」C 端）。
 *
 * 让个人/单机用户给自己的数字人接一个 LLM 老师（reflect/perceive 成长期用；运行时 chat 仍零-LLM）。
 * 三种合规接入：openai/anthropic + API key（BYOK）、任意 provider + 自定义 baseUrl（接兼容网关/订阅
 * 代理）、ollama（本机零凭据）。
 *
 * 安全：apiKey 仅在**请求体上行**出现，加密落库后**GET 绝不回传明文**（只回 hasApiKey）。
 */

/** 允许配置的 provider（mock 仅测试用，不开放给 C 端配置）。 */
export const CompanionLlmProviderV1Schema = z.enum(['openai', 'anthropic', 'ollama']);
export type CompanionLlmProviderV1 = z.infer<typeof CompanionLlmProviderV1Schema>;

/** PUT 请求体：设置 LLM 老师。 */
export const CompanionLlmSettingsRequestV1Schema = z
  .object({
    provider: CompanionLlmProviderV1Schema,
    /** 模型名覆盖（空串/省略 → 用该 provider 默认 / 全局）。 */
    model: z.string().max(200).optional(),
    /** 自定义端点（OpenAI 兼容网关 / 订阅代理 / 本机 ollama）。空串/省略 → 官方/默认端点。 */
    baseUrl: z.string().max(500).optional(),
    /**
     * API key。提供非空 → 加密存该 provider 的 key；提供空串 → 撤销该 provider 的 key；
     * 省略（undefined）→ 不动既有 key。绝不回传。
     */
    apiKey: z.string().max(400).optional(),
  })
  .strict();

export type CompanionLlmSettingsRequestV1 = z.infer<typeof CompanionLlmSettingsRequestV1Schema>;

/** GET 响应：当前 LLM 老师配置（脱敏——只回 key 是否存在，不回 key）。 */
export const CompanionLlmSettingsV1Schema = z
  .object({
    schemaVersion: z.literal('companion-llm-settings.v1'),
    /** 当前生效的 provider（用户偏好 → 否则全局默认）。 */
    activeProvider: z.string(),
    /** 模型名覆盖（null=用默认）。 */
    model: z.string().nullable(),
    /** 自定义端点（null=官方/默认）。 */
    baseUrl: z.string().nullable(),
    /** 是否已为 activeProvider 配置 BYOK key（脱敏，绝不回 key 本身）。 */
    hasApiKey: z.boolean(),
    /** 本机是否能安全存 key（凭据加密是否启用）——false 时前端引导改用 ollama/自定义端点。 */
    canStoreApiKey: z.boolean(),
    /** 全局默认 provider（用户未设偏好时的回退老师）。 */
    globalProvider: z.string(),
  })
  .strict();

export type CompanionLlmSettingsV1 = z.infer<typeof CompanionLlmSettingsV1Schema>;
