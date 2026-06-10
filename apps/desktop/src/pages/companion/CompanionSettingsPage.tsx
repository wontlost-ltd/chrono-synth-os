/**
 * ChronoCompanion · 精简设置 (ADR-0046 Phase 2.4a)。
 *
 * 个人版用户不需要企业版那套治理设置，这里只给三件事：看当前 plan、配 API（base URL + token）、登出。
 * 配置仍走既有 http-client 的 localStorage 存储（与 OnboardingPage 一致）。
 */

import { useState } from 'react';
import {
  getApiBaseUrl,
  getApiToken,
  setApiToken,
  setApiCredentials,
  clearAccountScopedCaches,
} from '@/bridge/http-client';
import type { AccountPlan } from '@/plan/account-plan';

const PLAN_LABEL: Record<AccountPlan, string> = {
  companion: '个人版（ChronoCompanion）',
  enterprise: '企业版',
  unconfigured: '未配置',
};

export interface CompanionSettingsPageProps {
  /** 当前解析出的 plan（由 App 传入，用于展示）。 */
  readonly plan: AccountPlan;
}

export function CompanionSettingsPage({ plan }: CompanionSettingsPageProps) {
  const [baseUrl, setBaseUrl] = useState(getApiBaseUrl() ?? '');
  const [token, setToken] = useState(getApiToken() ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    const trimmed = baseUrl.trim();
    if (trimmed) {
      try {
        const u = new URL(trimmed);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          setError('地址必须是 http 或 https');
          return;
        }
      } catch {
        setError('地址格式不正确');
        return;
      }
    }
    /* 事务式写凭据 + 清 plan 缓存，**await 后再 reload**——否则 reload 会中断清缓存的
     * pending promise，换账号后离线时仍可能沿用旧 plan（Codex 复审 Major）。 */
    await setApiCredentials({ baseUrl: trimmed || null, token: token.trim() || null });
    setSaved(true);
    window.location.reload();
  }

  async function handleLogout() {
    /* 登出：清 token；账号绑定缓存（plan + companion growth）无条件作废——无论 token 原值如何，
     * 登出都不该留旧账号的 plan 或成长画像（Codex ② Major：growth 也要随登出清）。 */
    setApiToken(null);
    await clearAccountScopedCaches();
    window.location.reload();
  }

  return (
    <div className="max-w-lg space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-chrono-text-primary">设置</h1>
        <p className="mt-1 text-sm text-chrono-text-muted">
          当前账号类型：<span className="font-medium text-chrono-text-secondary">{PLAN_LABEL[plan]}</span>
        </p>
      </header>

      <section className="space-y-3 rounded-xl border border-chrono-border bg-chrono-elevated p-4">
        <h2 className="text-sm font-semibold text-chrono-text-primary">服务器连接</h2>
        <div className="space-y-1">
          <label htmlFor="companion-base-url" className="text-xs font-medium text-chrono-text-secondary">
            服务器地址
          </label>
          <input
            id="companion-base-url"
            type="url"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setSaved(false);
            }}
            placeholder="https://chrono.example.com"
            className="w-full rounded-lg border border-chrono-border bg-chrono-surface px-3 py-1.5 text-sm text-chrono-text-primary"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="companion-token" className="text-xs font-medium text-chrono-text-secondary">
            访问令牌
          </label>
          <input
            id="companion-token"
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setSaved(false);
            }}
            placeholder="Bearer token"
            className="w-full rounded-lg border border-chrono-border bg-chrono-surface px-3 py-1.5 text-sm text-chrono-text-primary"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-amber-400">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSave}
            className="rounded-lg bg-chrono-primary px-4 py-2 text-sm text-white hover:opacity-90"
          >
            {saved ? '已保存' : '保存'}
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-lg border border-chrono-border px-4 py-2 text-sm text-chrono-text-secondary hover:bg-chrono-surface"
          >
            登出
          </button>
        </div>
      </section>
    </div>
  );
}
