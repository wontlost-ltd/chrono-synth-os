/**
 * TenantKeyPrefix — uniform tenant scoping for non-DB stores
 * (Redis cache, object storage, queues, search indices).
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.7 P1-R-tenant-iso
 *
 * Why a wrapper, not a contract:
 *   Workers that touch cache / queue keys forget the tenant prefix
 *   surprisingly often — the value compiles, the test passes (single-
 *   tenant fixture), and the bug surfaces in production as cross-tenant
 *   cache hits. Wrapping the key construction makes the prefix
 *   structural; you can't get a Redis key without supplying a tenantId.
 *
 *   The wrapper also normalises the separator (':') and validates
 *   tenantId shape (no separators, no leading dots) so a malicious
 *   tenantId cannot collide with another tenant's namespace.
 */

const SEPARATOR = ':';
const VALID_TENANT_ID = /^[a-zA-Z0-9_-]+$/;

export class TenantKeyError extends Error {
  constructor(readonly code: 'INVALID_TENANT_ID' | 'INVALID_SUBKEY', message: string) {
    super(message);
    this.name = 'TenantKeyError';
  }
}

/**
 * Validate + prefix a multi-segment key with tenantId.
 *
 * Example:
 *   tenantKey('tenant-a', 'cache', 'value', 'v-1')
 *   → 'tenant-a:cache:value:v-1'
 *
 * Throws TenantKeyError on:
 *   - tenantId containing the separator or special chars (cross-tenant
 *     collision attack)
 *   - any segment empty or containing the separator
 */
export function tenantKey(tenantId: string, ...segments: string[]): string {
  if (!VALID_TENANT_ID.test(tenantId)) {
    throw new TenantKeyError(
      'INVALID_TENANT_ID',
      `tenantId="${tenantId}" must match ${VALID_TENANT_ID.source}`,
    );
  }
  for (const s of segments) {
    if (!s || s.includes(SEPARATOR)) {
      throw new TenantKeyError(
        'INVALID_SUBKEY',
        `subkey segment "${s}" is empty or contains the separator "${SEPARATOR}"`,
      );
    }
  }
  return [tenantId, ...segments].join(SEPARATOR);
}

/**
 * Validate that a key returned from a downstream store actually belongs
 * to the expected tenant. Use this when reading keys back via a SCAN /
 * KEYS pattern to defend against tenant-id-spoofing bugs in the store
 * itself.
 */
export function assertTenantKey(tenantId: string, key: string): void {
  if (!key.startsWith(`${tenantId}${SEPARATOR}`)) {
    throw new TenantKeyError(
      'INVALID_TENANT_ID',
      `key "${key}" does not start with expected tenant prefix "${tenantId}:"`,
    );
  }
}

/**
 * Strip the tenant prefix so callers can work with the bare subkey
 * (e.g. listing the cache entries of one tenant). Throws if the key
 * doesn't belong to the tenant.
 */
export function stripTenantPrefix(tenantId: string, key: string): string {
  assertTenantKey(tenantId, key);
  return key.slice(tenantId.length + SEPARATOR.length);
}

/**
 * Build a SCAN pattern for one tenant. Use this with `redis.scan` etc.
 * to enumerate just that tenant's keys.
 */
export function tenantScanPattern(tenantId: string, suffix: string = '*'): string {
  /* Validate tenantId so a wildcard '*' for the tenant slot can't
   * sneak in and read every tenant's keys. */
  if (!VALID_TENANT_ID.test(tenantId)) {
    throw new TenantKeyError('INVALID_TENANT_ID', `tenantId="${tenantId}" rejected`);
  }
  return `${tenantId}${SEPARATOR}${suffix}`;
}
