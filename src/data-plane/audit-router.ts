import type { IDatabase } from '../storage/database.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export type AuditEventCategory = 'tenant_data' | 'platform_ops';

export interface AuditRoutingRule {
  eventTypePrefix: string;
  category: AuditEventCategory;
}

export const AUDIT_ROUTING_RULES: readonly AuditRoutingRule[] = [
  { eventTypePrefix: 'identity.', category: 'tenant_data' },
  { eventTypePrefix: 'persona.', category: 'tenant_data' },
  { eventTypePrefix: 'memory.', category: 'tenant_data' },
  { eventTypePrefix: 'task.', category: 'tenant_data' },
  { eventTypePrefix: 'knowledge.', category: 'tenant_data' },
  { eventTypePrefix: 'policy.', category: 'tenant_data' },
  { eventTypePrefix: 'export.', category: 'tenant_data' },
  { eventTypePrefix: 'import.', category: 'tenant_data' },
  { eventTypePrefix: 'conflict.', category: 'tenant_data' },
  { eventTypePrefix: 'billing.', category: 'platform_ops' },
  { eventTypePrefix: 'metrics.', category: 'platform_ops' },
  { eventTypePrefix: 'infra.', category: 'platform_ops' },
  { eventTypePrefix: 'ratelimit.', category: 'platform_ops' },
  { eventTypePrefix: 'system.', category: 'platform_ops' },
];

export function categorizeAuditEvent(eventType: string): AuditEventCategory {
  for (const rule of AUDIT_ROUTING_RULES) {
    if (eventType.startsWith(rule.eventTypePrefix)) return rule.category;
  }
  return 'platform_ops';
}

export interface AuditRouter {
  routeTenantAudit(tenantId: string, eventType: string, payload: Record<string, unknown>): void;
  routePlatformOps(eventType: string, payload: Record<string, unknown>): void;
}

export class DbAuditRouter implements AuditRouter {
  constructor(private readonly db: IDatabase) {}

  routeTenantAudit(
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    // Routes to audit_log (tenant_id from v007, action_type/payload_json from v040)
    this.db
      .prepare(
        `INSERT INTO audit_log(id, tenant_id, timestamp, method, path, request_id, status_code, latency_ms, action_type, payload_json)
         VALUES(?, ?, ?, '', '', '', 0, 0, ?, ?)`,
      )
      .run(
        generatePrefixedId('aud'),
        tenantId,
        Date.now(),
        eventType,
        JSON.stringify(payload),
      );
  }

  routePlatformOps(eventType: string, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO platform_ops_log(id, event_type, payload_json, occurred_at)
         VALUES(?, ?, ?, ?)`,
      )
      .run(
        generatePrefixedId('pop'),
        eventType,
        JSON.stringify(payload),
        Date.now(),
      );
  }
}
