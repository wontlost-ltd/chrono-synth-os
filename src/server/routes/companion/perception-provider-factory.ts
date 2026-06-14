/**
 * 按租户 BYOK 选「感官老师」provider 的共享工厂（一次性 perceive 与流式 perceive 复用同一逻辑）。
 *
 * 论点：LLM 只在摄取阶段当老师。选择规则：
 *   - 无 config（测试/无 BYOK）→ 确定性 MockPerceptionProvider。
 *   - provider=mock → MockPerceptionProvider。
 *   - ollama 无需 key / 云 provider 有 apiKey → LLM teacher（ModelRouter）。
 *   - 云 provider 无 key → 退回确定性 mock（租户没配 LLM，仍能用确定性感知）。
 *   - 云 provider 坏 key（BYOK 解密失败）→ resolveTenantLlmConfig fail-closed 抛错 → 转 ValidationError
 *     （不静默降级，与 #97-99 fail-closed 安全语义一致）。
 */

import type { AppConfig } from '../../../config/schema.js';
import type { IDatabase } from '../../../storage/database.js';
import type { LLMProviderName } from '@chrono/kernel';
import { ValidationError } from '../../../errors/index.js';
import { MockPerceptionProvider } from '../../../perception/sources/mock-perception-provider.js';
import { LlmPerceptionProvider } from '../../../perception/sources/llm-perception-provider.js';
import type { PerceptionProvider } from '../../../perception/perception-provider.js';
import { ModelRouter } from '../../../intelligence/model-router.js';
import { resolveTenantLlmConfig } from '../../../storage/tenant-llm-settings-store.js';
import type { tryByokEncryption } from '../../../storage/llm-credential-store.js';

/** BYOK 加密器（tryByokEncryption 的返回类型，缺省 undefined）。 */
type ByokEncryption = ReturnType<typeof tryByokEncryption>;

export function selectPerceptionProvider(
  tenantId: string,
  db: IDatabase,
  config: AppConfig | undefined,
  llmEncryption: ByokEncryption | undefined,
  injectedProvider?: PerceptionProvider,
): PerceptionProvider {
  if (injectedProvider) return injectedProvider;
  if (!config) return new MockPerceptionProvider();
  let effective;
  try {
    effective = resolveTenantLlmConfig(db, tenantId, config.intelligence, llmEncryption);
  } catch {
    throw new ValidationError('LLM 配置不可用，请检查 BYOK 设置');
  }
  if (effective.provider === 'mock') return new MockPerceptionProvider();
  if (effective.provider !== 'ollama' && !effective.apiKey) return new MockPerceptionProvider();
  const llm = new ModelRouter({
    provider: effective.provider as LLMProviderName,
    model: effective.model,
    embeddingModel: effective.embeddingModel,
    apiKey: effective.apiKey,
    baseUrl: effective.baseUrl,
    maxTokens: config.intelligence.maxTokens,
    temperature: config.intelligence.temperature,
    tenantId,
  });
  return new LlmPerceptionProvider(llm);
}
