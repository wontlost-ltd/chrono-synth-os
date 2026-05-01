/**
 * Kafka 命名空间 SQL 执行器
 */

import { registerQuery } from '../legacy-sync-bridge.js';
import {
  KAFKA_QUERY_TENANT_NAMESPACE, KAFKA_QUERY_ALL_NAMESPACES,
} from '@chrono/kernel';
import type {
  KafkaTenantNamespaceRow, KafkaTenantNamespaceParams,
} from '@chrono/kernel';

export function registerKafkaNamespaceExecutors(): void {
  registerQuery<KafkaTenantNamespaceRow | null, KafkaTenantNamespaceParams>(KAFKA_QUERY_TENANT_NAMESPACE, (db, p) => {
    return db.prepare<KafkaTenantNamespaceRow>(
      `SELECT tenant_id, deployment_mode, kafka_namespace
       FROM tenant_enterprise_profiles
       WHERE tenant_id = ?
       LIMIT 1`,
    ).get(p.tenantId) ?? null;
  });

  registerQuery<readonly KafkaTenantNamespaceRow[], void>(KAFKA_QUERY_ALL_NAMESPACES, (db) => {
    return db.prepare<KafkaTenantNamespaceRow>(
      `SELECT tenant_id, deployment_mode, kafka_namespace
       FROM tenant_enterprise_profiles`,
    ).all();
  });
}
