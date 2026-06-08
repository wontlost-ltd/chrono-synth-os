/**
 * 企业版路由表（ADR-0046 Phase 2.4a）。
 *
 * 从 App.tsx 抽出来，让「按 plan 切换 router」清晰可测：enterprise plan 渲染这张表
 * （行为与抽出前一致），companion plan 渲染 CompanionRoutes。
 */

import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/layout/Layout';
import { AgentOauthGooglePage } from '@/pages/AgentOauthGooglePage';
import { AgentPendingConfirmationsPage } from '@/pages/AgentPendingConfirmationsPage';
import { ConflictsPage } from '@/pages/ConflictsPage';
import { PersonaListPage } from '@/pages/PersonaListPage';
import { SafetyDriftPage } from '@/pages/SafetyDriftPage';
import { SettingsPage } from '@/pages/SettingsPage';

export function EnterpriseRoutes() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<PersonaListPage />} />
        <Route path="/conflicts" element={<ConflictsPage />} />
        <Route path="/safety/drift" element={<SafetyDriftPage />} />
        <Route path="/agent/oauth/google" element={<AgentOauthGooglePage />} />
        <Route path="/agent/confirmations" element={<AgentPendingConfirmationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
