import { ErrorCode, ValidationError } from '../errors/index.js';
import type { IDatabase } from '../storage/database.js';

const KAFKA_NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,118}[a-z0-9])?$/;

interface TenantKafkaNamespaceRow {
  tenant_id: string;
  deployment_mode: 'shared_cluster' | 'dedicated_db';
  kafka_namespace: string;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function defaultKafkaNamespaceForTenant(tenantId: string): string {
  const normalized = tenantId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 100);
  const suffix = normalized.length > 0 ? normalized : 'default';
  return `tenant-${suffix}`.slice(0, 120);
}

export function normalizeKafkaNamespace(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function assertValidKafkaNamespace(value: string | null): void {
  if (!value) return;
  if (!KAFKA_NAMESPACE_PATTERN.test(value)) {
    throw new ValidationError(
      'kafkaNamespace 格式无效，必须为小写字母/数字，并仅包含 . _ -',
      ErrorCode.VALIDATION_FORMAT,
    );
  }
}

export function buildTenantKafkaTopic(baseTopic: string, kafkaNamespace: string | null | undefined): string {
  const normalized = normalizeKafkaNamespace(kafkaNamespace);
  return normalized ? `${normalized}.${baseTopic}` : baseTopic;
}

export function buildTenantKafkaTopicPattern(baseTopic: string): RegExp {
  return new RegExp(`^(?:[a-z0-9._-]+\\.)?${escapeRegex(baseTopic)}$`);
}

function deriveKafkaNamespace(row: TenantKafkaNamespaceRow | undefined, tenantId: string): string | null {
  if (!row) return null;
  const explicit = normalizeKafkaNamespace(row.kafka_namespace);
  if (explicit) return explicit;
  if (row.deployment_mode === 'dedicated_db') {
    return defaultKafkaNamespaceForTenant(tenantId);
  }
  return null;
}

export function resolveTenantKafkaTopic(db: IDatabase, tenantId: string, baseTopic: string): string {
  const row = db.prepare<TenantKafkaNamespaceRow>(
    `SELECT tenant_id, deployment_mode, kafka_namespace
     FROM tenant_enterprise_profiles
     WHERE tenant_id = ?
     LIMIT 1`,
  ).get(tenantId);
  return buildTenantKafkaTopic(baseTopic, deriveKafkaNamespace(row, tenantId));
}

export function listTenantKafkaTopics(db: IDatabase, baseTopic: string): string[] {
  const rows = db.prepare<TenantKafkaNamespaceRow>(
    `SELECT tenant_id, deployment_mode, kafka_namespace
     FROM tenant_enterprise_profiles`,
  ).all();
  const topics = new Set<string>([baseTopic]);
  for (const row of rows) {
    topics.add(buildTenantKafkaTopic(baseTopic, deriveKafkaNamespace(row, row.tenant_id)));
  }
  return [...topics];
}
