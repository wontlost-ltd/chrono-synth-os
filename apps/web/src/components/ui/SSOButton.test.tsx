import { describe, expect, it, vi } from 'vitest';
import { buildOidcLoginUrl } from './SSOButton';

vi.mock('../../config', () => ({
  API_BASE_URL: 'http://test-api',
}));

describe('buildOidcLoginUrl', () => {
  it('builds a tenant-aware OIDC login URL', () => {
    expect(buildOidcLoginUrl('tenant_enterprise')).toBe(
      'http://test-api/api/v1/auth/oidc/login?redirect_uri=%2Fsso%2Fcallback&tenant_id=tenant_enterprise',
    );
  });

  it('supports a custom redirect path', () => {
    expect(buildOidcLoginUrl('tenant_enterprise', '/dashboard')).toBe(
      'http://test-api/api/v1/auth/oidc/login?redirect_uri=%2Fdashboard&tenant_id=tenant_enterprise',
    );
  });
});
