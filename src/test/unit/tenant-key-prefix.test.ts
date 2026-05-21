/**
 * P1-R-tenant-iso — TenantKeyPrefix tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  tenantKey, assertTenantKey, stripTenantPrefix, tenantScanPattern, TenantKeyError,
} from '../../multi-tenant/tenant-key-prefix.js';

describe('tenantKey', () => {
  it('builds a colon-separated multi-segment key', () => {
    assert.equal(tenantKey('tenant-a', 'cache', 'value', 'v-1'), 'tenant-a:cache:value:v-1');
  });

  it('refuses tenantId with separator', () => {
    assert.throws(
      () => tenantKey('tenant-a:evil', 'cache'),
      (err: TenantKeyError) => err.code === 'INVALID_TENANT_ID',
    );
  });

  it('refuses tenantId with special chars', () => {
    assert.throws(
      () => tenantKey('tenant.a', 'cache'),
      (err: TenantKeyError) => err.code === 'INVALID_TENANT_ID',
    );
    assert.throws(
      () => tenantKey('tenant/a', 'cache'),
      (err: TenantKeyError) => err.code === 'INVALID_TENANT_ID',
    );
  });

  it('refuses empty tenantId', () => {
    assert.throws(
      () => tenantKey('', 'cache'),
      (err: TenantKeyError) => err.code === 'INVALID_TENANT_ID',
    );
  });

  it('refuses segment containing separator (cross-tenant collision attack)', () => {
    /* Attacker controls a subkey value and tries to embed another
     * tenant's prefix: tenant-a:cache:tenant-b:secret. Without
     * validation, the resulting Redis key collides with tenant-b's
     * cache and may return tenant-b's data. */
    assert.throws(
      () => tenantKey('tenant-a', 'cache', 'tenant-b:secret'),
      (err: TenantKeyError) => err.code === 'INVALID_SUBKEY',
    );
  });

  it('refuses empty segment', () => {
    assert.throws(
      () => tenantKey('tenant-a', 'cache', ''),
      (err: TenantKeyError) => err.code === 'INVALID_SUBKEY',
    );
  });
});

describe('assertTenantKey', () => {
  it('admits keys belonging to the tenant', () => {
    assert.doesNotThrow(() => assertTenantKey('tenant-a', 'tenant-a:cache:x'));
  });

  it('refuses keys from another tenant', () => {
    assert.throws(
      () => assertTenantKey('tenant-a', 'tenant-b:cache:x'),
      TenantKeyError,
    );
  });

  it('refuses keys without a prefix', () => {
    assert.throws(
      () => assertTenantKey('tenant-a', 'cache:x'),
      TenantKeyError,
    );
  });

  it('refuses prefix-match false positives (tenant-a vs tenant-ab)', () => {
    assert.throws(
      () => assertTenantKey('tenant-a', 'tenant-ab:cache:x'),
      TenantKeyError,
    );
  });
});

describe('stripTenantPrefix', () => {
  it('returns the bare subkey when prefix matches', () => {
    assert.equal(stripTenantPrefix('tenant-a', 'tenant-a:cache:x'), 'cache:x');
  });

  it('throws on wrong tenant', () => {
    assert.throws(
      () => stripTenantPrefix('tenant-a', 'tenant-b:cache:x'),
      TenantKeyError,
    );
  });
});

describe('tenantScanPattern', () => {
  it('builds a SCAN pattern for one tenant', () => {
    assert.equal(tenantScanPattern('tenant-a'), 'tenant-a:*');
    assert.equal(tenantScanPattern('tenant-a', 'cache:*'), 'tenant-a:cache:*');
  });

  it('refuses wildcard in tenantId slot', () => {
    assert.throws(
      () => tenantScanPattern('*'),
      (err: TenantKeyError) => err.code === 'INVALID_TENANT_ID',
    );
    /* Without this guard a worker could ask for SCAN '*:cache:x' and
     * iterate every tenant's keys — the cross-tenant read vector. */
  });
});
