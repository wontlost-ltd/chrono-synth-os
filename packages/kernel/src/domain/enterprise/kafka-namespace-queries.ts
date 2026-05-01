/**
 * Kafka 命名空间 Query kind 常量与参数类型
 */

import type { Query } from '../../ports/query.js';

/* ── Query Kinds ── */

export const KAFKA_QUERY_TENANT_NAMESPACE = 'kafka.tenantNamespace' as const;
export const KAFKA_QUERY_ALL_NAMESPACES = 'kafka.allNamespaces' as const;

/* ── 行类型 ── */

export interface KafkaTenantNamespaceRow {
  readonly tenant_id: string;
  readonly deployment_mode: 'shared_cluster' | 'dedicated_db';
  readonly kafka_namespace: string;
}

/* ── 参数类型 ── */

export interface KafkaTenantNamespaceParams {
  tenantId: string;
}

/* ── Query 工厂 ── */

export function kafkaQueryTenantNamespace(params: KafkaTenantNamespaceParams): Query<KafkaTenantNamespaceRow | null, KafkaTenantNamespaceParams> {
  return { kind: KAFKA_QUERY_TENANT_NAMESPACE, params };
}

export function kafkaQueryAllNamespaces(): Query<readonly KafkaTenantNamespaceRow[], void> {
  return { kind: KAFKA_QUERY_ALL_NAMESPACES, params: undefined as unknown as void };
}
