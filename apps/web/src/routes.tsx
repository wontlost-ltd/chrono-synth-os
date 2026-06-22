import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Skeleton } from './components/ui/Skeleton';
import { AuthGuard } from './components/layout/AuthGuard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAuth } from './hooks/useAuth';

const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Register = lazy(() => import('./pages/Register').then(m => ({ default: m.Register })));
const Onboarding = lazy(() => import('./pages/Onboarding').then(m => ({ default: m.Onboarding })));
const OnboardingV2 = lazy(() => import('./pages/OnboardingV2').then(m => ({ default: m.OnboardingV2 })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Simulations = lazy(() => import('./pages/Simulations').then(m => ({ default: m.Simulations })));
const SimulationWizard = lazy(() => import('./pages/SimulationWizard').then(m => ({ default: m.SimulationWizard })));
const PathComparison = lazy(() => import('./pages/PathComparison').then(m => ({ default: m.PathComparison })));
const BranchExplorer = lazy(() => import('./pages/BranchExplorer').then(m => ({ default: m.BranchExplorer })));
const StressTest = lazy(() => import('./pages/StressTest').then(m => ({ default: m.StressTest })));
const Milestones = lazy(() => import('./pages/Milestones').then(m => ({ default: m.Milestones })));
const ValuesManager = lazy(() => import('./pages/ValuesManager').then(m => ({ default: m.ValuesManager })));
const SystemStatus = lazy(() => import('./pages/SystemStatus').then(m => ({ default: m.SystemStatus })));
const Billing = lazy(() => import('./pages/Billing').then(m => ({ default: m.Billing })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const SSOCallback = lazy(() => import('./pages/SSOCallback').then(m => ({ default: m.SSOCallback })));
const AdminConfig = lazy(() => import('./pages/AdminConfig').then(m => ({ default: m.AdminConfig })));
const EnterpriseConsole = lazy(() => import('./pages/EnterpriseConsole').then(m => ({ default: m.EnterpriseConsole })));
const SafetyDriftReport = lazy(() => import('./pages/SafetyDriftReport').then(m => ({ default: m.SafetyDriftReport })));
const AdminToolPermissions = lazy(() => import('./pages/AdminToolPermissions').then(m => ({ default: m.AdminToolPermissions })));
const AdminAgencyAuthorizations = lazy(() => import('./pages/AdminAgencyAuthorizations').then(m => ({ default: m.AdminAgencyAuthorizations })));
const AdminToolInvocations = lazy(() => import('./pages/AdminToolInvocations').then(m => ({ default: m.AdminToolInvocations })));
const AgentOauthGoogle = lazy(() => import('./pages/AgentOauthGoogle').then(m => ({ default: m.AgentOauthGoogle })));
const AgentPendingConfirmations = lazy(() => import('./pages/AgentPendingConfirmations').then(m => ({ default: m.AgentPendingConfirmations })));

/* 新功能页面 */
const AvatarListPage = lazy(() => import('./features/avatars/pages/AvatarListPage'));
const AvatarDetailPage = lazy(() => import('./features/avatars/pages/AvatarDetailPage'));
const KnowledgeSourceListPage = lazy(() => import('./features/knowledge/pages/KnowledgeSourceListPage'));
const KnowledgeSourceCreatePage = lazy(() => import('./features/knowledge/pages/KnowledgeSourceCreatePage'));
const KnowledgeSourceDetailPage = lazy(() => import('./features/knowledge/pages/KnowledgeSourceDetailPage'));
const AutorunConfigPage = lazy(() => import('./features/autorun/pages/AutorunConfigPage'));
const AutorunRunsPage = lazy(() => import('./features/autorun/pages/AutorunRunsPage'));
const PersonaListPage = lazy(() => import('./features/personas/pages/PersonaListPage'));
const PersonaCorePage = lazy(() => import('./features/persona-core/pages/PersonaCorePage'));
const PersonaGovernance = lazy(() => import('./pages/PersonaGovernance'));
const MarketplacePage = lazy(() => import('./features/marketplace/pages/MarketplacePage'));
const ConflictInboxPage = lazy(() => import('./features/conflicts/ConflictInboxPage').then(m => ({ default: m.ConflictInboxPage })));
const NotFound = lazy(() => import('./pages/NotFound').then(m => ({ default: m.NotFound })));
const Forbidden = lazy(() => import('./pages/Forbidden').then(m => ({ default: m.Forbidden })));
const PersonaHealthPage = lazy(() =>
  import('./features/dashboards/PersonaHealth').then((m) => ({ default: m.PersonaHealth })),
);
const GrowthPage = lazy(() => import('./pages/GrowthPage'));
const WorkforceConsole = lazy(() => import('./pages/WorkforceConsole'));
const WorkforceVisualization = lazy(() => import('./pages/WorkforceVisualization'));

function LazyPage({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<Skeleton variant="chart" />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  return <AuthGuard><LazyPage>{children}</LazyPage></AuthGuard>;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();
  if (role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

export const routes: RouteObject[] = [
  { path: '/', element: <Navigate to="/dashboard" replace /> },
  { path: '/login', element: <LazyPage><Login /></LazyPage> },
  { path: '/register', element: <LazyPage><Register /></LazyPage> },
  { path: '/onboarding', element: <Protected><Onboarding /></Protected> },
  { path: '/onboarding/v2', element: <Protected><OnboardingV2 /></Protected> },
  { path: '/dashboard', element: <Protected><Dashboard /></Protected> },
  { path: '/simulations', element: <Protected><Simulations /></Protected> },
  { path: '/simulations/new', element: <Protected><SimulationWizard /></Protected> },
  { path: '/simulations/:id', element: <Navigate to="paths" replace /> },
  { path: '/simulations/:id/paths', element: <Protected><PathComparison /></Protected> },
  { path: '/simulations/:id/branches', element: <Protected><BranchExplorer /></Protected> },
  { path: '/simulations/:id/stress', element: <Protected><StressTest /></Protected> },
  { path: '/simulations/:id/milestones', element: <Protected><Milestones /></Protected> },
  { path: '/values', element: <Protected><ValuesManager /></Protected> },
  { path: '/system', element: <Protected><SystemStatus /></Protected> },
  { path: '/billing', element: <Protected><Billing /></Protected> },
  { path: '/settings', element: <Protected><Settings /></Protected> },
  { path: '/enterprise', element: <Protected><AdminOnly><EnterpriseConsole /></AdminOnly></Protected> },
  { path: '/workforce', element: <Protected><AdminOnly><WorkforceConsole /></AdminOnly></Protected> },
  { path: '/workforce/viz', element: <Protected><AdminOnly><WorkforceVisualization /></AdminOnly></Protected> },
  { path: '/admin/config', element: <Protected><AdminOnly><AdminConfig /></AdminOnly></Protected> },
  { path: '/admin/safety/drift', element: <Protected><AdminOnly><SafetyDriftReport /></AdminOnly></Protected> },
  { path: '/admin/tool-permissions', element: <Protected><AdminOnly><AdminToolPermissions /></AdminOnly></Protected> },
  { path: '/admin/agency-authorizations', element: <Protected><AdminOnly><AdminAgencyAuthorizations /></AdminOnly></Protected> },
  { path: '/admin/tool-invocations', element: <Protected><AdminOnly><AdminToolInvocations /></AdminOnly></Protected> },
  { path: '/agent/oauth/google', element: <Protected><AgentOauthGoogle /></Protected> },
  { path: '/agent/confirmations', element: <Protected><AgentPendingConfirmations /></Protected> },
  { path: '/sso/callback', element: <LazyPage><SSOCallback /></LazyPage> },
  /* per-persona 治理策略配置（owner-only，路由内 assertOwner 二次校验） */
  { path: '/persona/:personaId/governance', element: <Protected><PersonaGovernance /></Protected> },
  /* 分身管理 */
  { path: '/avatars', element: <Protected><AvatarListPage /></Protected> },
  { path: '/avatars/:id', element: <Protected><AvatarDetailPage /></Protected> },
  { path: '/avatars/:id/autorun', element: <Protected><AutorunConfigPage /></Protected> },
  { path: '/avatars/:id/autorun/runs', element: <Protected><AutorunRunsPage /></Protected> },
  /* 知识源管理 */
  { path: '/knowledge-sources', element: <Protected><KnowledgeSourceListPage /></Protected> },
  { path: '/knowledge-sources/create', element: <Protected><KnowledgeSourceCreatePage /></Protected> },
  { path: '/knowledge-sources/:id', element: <Protected><KnowledgeSourceDetailPage /></Protected> },
  /* 人格管理 */
  { path: '/personas', element: <Protected><PersonaListPage /></Protected> },
  { path: '/persona-core', element: <Protected><PersonaCorePage /></Protected> },
  { path: '/personas/:id/health', element: <Protected><PersonaHealthPage /></Protected> },
  { path: '/growth', element: <Protected><GrowthPage /></Protected> },
  { path: '/marketplace', element: <Protected><MarketplacePage /></Protected> },
  { path: '/conflicts', element: <Protected><ConflictInboxPage /></Protected> },
  /* P3.9 — branded error pages instead of silent redirects */
  { path: '/403', element: <LazyPage><Forbidden /></LazyPage> },
  { path: '/404', element: <LazyPage><NotFound /></LazyPage> },
  { path: '*', element: <LazyPage><NotFound /></LazyPage> },
];
