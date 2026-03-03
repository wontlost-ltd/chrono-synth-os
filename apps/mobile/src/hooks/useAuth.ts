/**
 * 移动端认证 hook
 */

import { useState, useCallback } from 'react';
import { apiFetch, setSession, clearSession } from '../api/client';

interface User {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ user: null, isAuthenticated: false });

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiFetch<{ userId: string; email: string; tenantId: string; role: string; accessToken: string }>(
      '/api/v1/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
    );
    setSession({ accessToken: data.accessToken, tenantId: data.tenantId });
    setState({ user: { userId: data.userId, email: data.email, tenantId: data.tenantId, role: data.role }, isAuthenticated: true });
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setState({ user: null, isAuthenticated: false });
  }, []);

  return { ...state, login, logout };
}
