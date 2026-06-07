import { BrowserRouter, useRoutes, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './api/queryClient';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NetworkStatus } from './components/ui/NetworkStatus';
import { routes } from './routes';

/** 认证页面不需要 AppShell 布局 */
const AUTH_PATHS = new Set(['/login', '/register']);

function AppRoutes() {
  const element = useRoutes(routes);
  const location = useLocation();

  if (AUTH_PATHS.has(location.pathname)) {
    return <>{element}</>;
  }

  return <AppShell>{element}</AppShell>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
          <AppRoutes />
          <NetworkStatus />
        </ErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
