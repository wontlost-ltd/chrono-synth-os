/**
 * ChronoCompanion 路由表（ADR-0046 Phase 2.4a）。
 *
 * 个人版精简四页：/（我的数字人）、/chat（跟 TA 聊聊，零-LLM 对话）、/growth（成长）、
 * /settings（精简设置）。除对话经内嵌 sidecar HTTP 外，其余渲染**本地**数据。
 */

import { Navigate, Route, Routes } from 'react-router-dom';
import { CompanionLayout } from '@/layout/CompanionLayout';
import { CompanionHomePage } from '@/pages/companion/CompanionHomePage';
import { CompanionChatPage } from '@/pages/companion/CompanionChatPage';
import { CompanionLearningPage } from '@/pages/companion/CompanionLearningPage';
import { CompanionGrowthPage } from '@/pages/companion/CompanionGrowthPage';
import { CompanionSettingsPage } from '@/pages/companion/CompanionSettingsPage';
import type { AccountPlan } from '@/plan/account-plan';

export interface CompanionRoutesProps {
  /** 当前 plan，透传给设置页展示。 */
  readonly plan: AccountPlan;
}

export function CompanionRoutes({ plan }: CompanionRoutesProps) {
  return (
    <CompanionLayout>
      <Routes>
        <Route path="/" element={<CompanionHomePage />} />
        <Route path="/chat" element={<CompanionChatPage />} />
        <Route path="/learn" element={<CompanionLearningPage />} />
        <Route path="/growth" element={<CompanionGrowthPage />} />
        <Route path="/settings" element={<CompanionSettingsPage plan={plan} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </CompanionLayout>
  );
}
