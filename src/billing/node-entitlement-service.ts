import type { EntitlementContract, EntitlementResult, Entitlement, TenantScope, PlanLimits } from '@chrono/kernel';
import type { UowOrDb } from '../storage/uow-helpers.js';
import { EntitlementService } from './entitlement-service.js';
import { RESOURCE_TO_LIMIT } from '@chrono/kernel';

export class NodeEntitlementService implements EntitlementContract {
  private readonly inner: EntitlementService;

  constructor(uowOrDb: UowOrDb) {
    this.inner = new EntitlementService(uowOrDb);
  }

  async check(scope: TenantScope, resource: string): Promise<EntitlementResult> {
    const limits = this.inner.computeEffectiveLimits(scope.tenantId);
    const limit = limits[resource] ?? -1;
    if (limit === -1) {
      return { allowed: true };
    }
    // Without a usage counter here we allow if limit > 0
    return { allowed: limit > 0, limit };
  }

  async listActive(scope: TenantScope): Promise<readonly Entitlement[]> {
    const limits = this.inner.computeEffectiveLimits(scope.tenantId);
    return Object.entries(limits).map(([resource, limit]) => ({
      resource,
      limit,
      used: 0,
    }));
  }

  async effectiveLimits(scope: TenantScope): Promise<PlanLimits> {
    const limits = this.inner.computeEffectiveLimits(scope.tenantId);
    // Build PlanLimits from EffectiveLimits using the RESOURCE_TO_LIMIT reverse map
    const fieldToResource = new Map<string, string>();
    for (const [resource, field] of RESOURCE_TO_LIMIT) {
      fieldToResource.set(field, resource);
    }
    return {
      maxSimulations: limits[fieldToResource.get('maxSimulations') ?? 'simulation'] ?? -1,
      maxPaths: limits['paths'] ?? -1,
      llmTokensPerMonth: limits[fieldToResource.get('llmTokensPerMonth') ?? 'llm_tokens'] ?? -1,
      rateLimitPerMinute: limits['rate_limit'] ?? 100,
      maxAvatars: limits['avatars'] ?? -1,
      maxMemoryNodes: limits[fieldToResource.get('maxMemoryNodes') ?? 'memory_nodes'] ?? -1,
      /* Phase-1 业务度量；entitlement 系统对这些资源以 add-on 形式覆盖时由
       * computeEffectiveLimits 提供，否则回退到默认 -1（无限制） */
      maxPersonas: limits['personas'] ?? -1,
      conversationMessagesPerMonth: limits['conversation_message'] ?? -1,
      knowledgeStorageGb: limits['knowledge_storage_gb'] ?? -1,
      bulkImportItemsPerMonth: limits['bulk_knowledge_import_item'] ?? -1,
    };
  }
}
