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
    /**
     * 自定义端点（OpenAI 兼容网关 / 订阅代理 / 本机 ollama）。空串/省略 → 官方/默认端点。
     * 仅允许 http(s)——挡掉 file:/gopher: 等危险 scheme（SSRF 面收窄）。空串放行（=清除覆盖）。
     * ⚠️ 本地单机（loopback sidecar）信任模型下允许指向 127.0.0.1（ollama 正当用途）；hosted/多租户
     * 部署若开放此端点，须在部署层额外加私网 IP 阻断 / allowlist（见 me.ts 端点注释）。
     */
    baseUrl: z
      .string()
      .max(500)
      .refine(
        (v) => v === '' || /^https?:\/\//i.test(v),
        { message: 'baseUrl 必须是 http(s) 端点' },
      )
      .optional(),
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

/* ── 「学一个主题」——给主题让 LLM 老师自主教，蒸馏成记忆（ADR-0047）─────────────── */

/** 主题长度上限（是主题词/短语，非长文；长文走 perceive 喂料）。 */
export const LEARN_TOPIC_MAX_LEN = 200;

export const CompanionLearnTopicRequestV1Schema = z
  .object({
    /** 要学的主题，如「Java 并发」「唐诗」。 */
    topic: z.string().min(1).max(LEARN_TOPIC_MAX_LEN),
  })
  .strict();

export type CompanionLearnTopicRequestV1 = z.infer<typeof CompanionLearnTopicRequestV1Schema>;

/** 一条学到的记忆（第一人称）。 */
export const LearnedMemoryV1Schema = z
  .object({ id: z.string(), content: z.string() })
  .strict();

export const CompanionLearnTopicResultV1Schema = z
  .object({
    schemaVersion: z.literal('companion-learn-topic-result.v1'),
    topic: z.string(),
    learnedMemoryCount: z.number().int().nonnegative(),
    learnedMemories: z.array(LearnedMemoryV1Schema),
    /** 老师调用是否失败（真语义学习需要老师；失败=没学到，前端诚实提示）。 */
    teacherFailed: z.boolean(),
  })
  .strict();

export type CompanionLearnTopicResultV1 = z.infer<typeof CompanionLearnTopicResultV1Schema>;
