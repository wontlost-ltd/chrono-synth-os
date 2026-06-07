import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SSOCallback } from './SSOCallback';

const navigateSpy = vi.fn();
const setSessionSpy = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../store/session', () => ({
  setSession: (value: unknown) => setSessionSpy(value),
}));

vi.mock('../hooks/useDocumentTitle', () => ({
  useDocumentTitle: () => undefined,
}));

function createJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${header}.${body}.signature`;
}

describe('SSOCallback', () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    setSessionSpy.mockReset();
    window.history.replaceState(null, '', '/sso/callback');
    sessionStorage.clear();
  });

  it('accepts backend-issued access tokens without requiring frontend state storage', async () => {
    const accessToken = createJwt({
      sub: 'user_test',
      tenantId: 'tenant_test',
      role: 'admin',
    });
    window.history.replaceState(null, '', `/sso/callback#access_token=${accessToken}`);

    render(
      <MemoryRouter>
        <SSOCallback />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(setSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
        accessToken,
        tenantId: 'tenant_test',
        user: expect.objectContaining({
          userId: 'user_test',
          role: 'admin',
        }),
      }));
    });

    expect(navigateSpy).toHaveBeenCalledWith('/dashboard', { replace: true });
    expect(window.location.hash).toBe('');
  });
});
