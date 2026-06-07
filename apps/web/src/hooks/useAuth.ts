import { useSession } from '../store/session';

/** 认证状态 hook */
export function useAuth() {
  const session = useSession();
  const isAuthenticated = !!(session.accessToken || session.apiKey);
  return {
    isAuthenticated,
    user: session.user,
    tenantId: session.tenantId,
    role: session.user?.role ?? 'viewer',
  };
}
