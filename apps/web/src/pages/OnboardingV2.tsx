/**
 * Onboarding v2 — agent governance 5-step wizard
 *
 * PRD: chrono-synth-os/.claude/gtm/03-onboarding-prd.md
 *
 * 流程：welcome → organization → agent → policy → synthetic → audit-log
 *
 * 设计原则：
 *  - 5 分钟预算：每一步只做一件事，不引入 LLM 调用
 *  - 重载安全：状态从后端 session 读，不依赖 localStorage
 *  - 跳过友好：右上角永远有"跳过"链接，写入 users.onboarded_at
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useOnboardingV2Status,
  useStartOnboardingV2,
  useSubmitOrganizationStep,
  useSubmitAgentStep,
  useSubmitPolicyStep,
  useFireSyntheticInvocation,
  useCompleteOnboardingV2,
  useSkipOnboardingV2,
  type OnboardingPolicyEntry,
  type OnboardingV2Session,
} from '../api/queries/onboarding-v2';

const TOTAL_STEPS = 5;

/* 默认策略：四个常见 LangChain agent demo 工具，对应 PRD § Open Questions #3 */
const DEFAULT_POLICIES: OnboardingPolicyEntry[] = [
  { toolId: 'github.read_issues', scope: 'read', decision: 'allow' },
  { toolId: 'github.write_pr', scope: 'write', decision: 'deny' },
  { toolId: 'email.send', scope: 'execute', decision: 'confirm' },
  { toolId: 'slack.post_message', scope: 'execute', decision: 'confirm' },
];

type DisplayStep = 0 | 1 | 2 | 3 | 4 | 5;
/** 0 = welcome, 1-5 = 实际步骤 */

export function OnboardingV2() {
  const { t } = useTranslation();
  useDocumentTitle(t('onboardingV2.title'));
  const navigate = useNavigate();
  const status = useOnboardingV2Status();
  const start = useStartOnboardingV2();
  const submitOrg = useSubmitOrganizationStep();
  const submitAgent = useSubmitAgentStep();
  const submitPolicy = useSubmitPolicyStep();
  const fireSynthetic = useFireSyntheticInvocation();
  const complete = useCompleteOnboardingV2();
  const skip = useSkipOnboardingV2();

  const [session, setSession] = useState<OnboardingV2Session | null>(null);
  const [displayStep, setDisplayStep] = useState<DisplayStep>(0);
  const [error, setError] = useState<string | null>(null);

  /* 表单本地状态 —— 仅持有未提交的草稿，提交成功后从 session 重新读 */
  const [orgName, setOrgName] = useState('');
  const [agentName, setAgentName] = useState('Customer Support Bot');
  const [provider, setProvider] = useState<'openai' | 'anthropic' | 'skip'>('skip');
  const [apiKey, setApiKey] = useState('');
  const [policies, setPolicies] = useState<OnboardingPolicyEntry[]>(DEFAULT_POLICIES);
  const [invocationIds, setInvocationIds] = useState<string[]>([]);

  /* mount 时拉取后端状态，决定 resume 到哪一步 */
  useEffect(() => {
    if (!status.data) return;
    if (status.data.onboarded) {
      navigate('/dashboard', { replace: true });
      return;
    }
    if (status.data.session) {
      setSession(status.data.session);
      setDisplayStep(status.data.session.currentStep as DisplayStep);
    }
  }, [status.data, navigate]);

  /* welcome 页用户点击 [Start] 后真正建立 session */
  async function handleStart() {
    setError(null);
    try {
      const s = await start.mutateAsync();
      setSession(s);
      setDisplayStep(s.currentStep as DisplayStep);
    } catch (err) {
      setError(getErrorMessage(err, t));
    }
  }

  async function handleSubmitOrg() {
    if (!session) return;
    if (!orgName.trim()) {
      setError(t('onboardingV2.errors.orgNameRequired'));
      return;
    }
    setError(null);
    try {
      const result = await submitOrg.mutateAsync({
        sessionId: session.id,
        organizationName: orgName.trim(),
      });
      setSession(result.session);
      setDisplayStep(2);
    } catch (err) {
      setError(getErrorMessage(err, t));
    }
  }

  async function handleSubmitAgent() {
    if (!session) return;
    if (!agentName.trim()) {
      setError(t('onboardingV2.errors.agentNameRequired'));
      return;
    }
    setError(null);
    try {
      const result = await submitAgent.mutateAsync({
        sessionId: session.id,
        agentName: agentName.trim(),
        llmProvider: provider === 'skip' ? null : provider,
        llmApiKey: provider === 'skip' || !apiKey.trim() ? null : apiKey.trim(),
      });
      setSession(result.session);
      setDisplayStep(3);
    } catch (err) {
      setError(getErrorMessage(err, t));
    }
  }

  async function handleSubmitPolicy() {
    if (!session?.agentId) return;
    setError(null);
    try {
      const result = await submitPolicy.mutateAsync({
        sessionId: session.id,
        agentId: session.agentId,
        policies,
      });
      setSession(result.session);
      setDisplayStep(4);
    } catch (err) {
      setError(getErrorMessage(err, t));
    }
  }

  async function handleFireSynthetic() {
    if (!session?.agentId) return;
    setError(null);
    try {
      const result = await fireSynthetic.mutateAsync({
        sessionId: session.id,
        agentId: session.agentId,
      });
      setSession(result.session);
      setInvocationIds(result.invocationIds);
      /* 自动推进到 step 5（PRD § Step 4 — auto-advance after 1.5s）。
       * 这里给 800ms 让用户感知到事件已落地，但不阻塞太久。 */
      setTimeout(() => setDisplayStep(5), 800);
    } catch (err) {
      setError(getErrorMessage(err, t));
    }
  }

  async function handleComplete() {
    if (!session) return;
    setError(null);
    try {
      await complete.mutateAsync({ sessionId: session.id });
      navigate('/admin/tool-invocations', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, t));
    }
  }

  async function handleSkip() {
    if (!session) {
      /* welcome 页跳过：从未启动 session，直接跳走。后端不知道发生了什么但
       * UI 不应再展示引导。下次登录还是会再次提示——这是有意的，因为没有 session
       * 就没办法写 users.onboarded_at（service 不允许在没有 session 时改 users）。
       * 对应 PRD § Open Question #4：默认尊重用户选择。 */
      navigate('/dashboard', { replace: true });
      return;
    }
    try {
      await skip.mutateAsync({ sessionId: session.id, currentStep: displayStep });
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, t));
    }
  }

  /* 进度条索引：welcome 不计入进度（step 0 是 welcome，0%），1-5 占 0-4 */
  const progressIndex = useMemo(() => Math.max(0, displayStep - 1), [displayStep]);

  if (status.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface px-4">
        <p className="text-sm text-text-secondary">{t('onboardingV2.loading')}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-2xl">
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-primary">ChronoSynth</h1>
            <p className="text-sm text-text-secondary">{t('onboardingV2.subtitle')}</p>
          </div>
          {displayStep < 5 && (
            <button
              type="button"
              onClick={handleSkip}
              className="text-xs text-text-secondary underline-offset-4 hover:underline"
            >
              {t('onboardingV2.skip')}
            </button>
          )}
        </header>

        {displayStep > 0 && (
          <div
            className="mb-6 flex gap-1"
            role="progressbar"
            aria-valuenow={displayStep}
            aria-valuemin={1}
            aria-valuemax={TOTAL_STEPS}
            aria-label={t('onboardingV2.progressLabel', {
              step: displayStep,
              total: TOTAL_STEPS,
            })}
          >
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full ${i <= progressIndex ? 'bg-primary' : 'bg-border'}`}
              />
            ))}
          </div>
        )}

        <div className="rounded-xl border border-border bg-surface-elevated p-6">
          {displayStep === 0 && (
            <StepWelcome onStart={handleStart} pending={start.isPending} t={t} />
          )}
          {displayStep === 1 && (
            <StepOrganization
              value={orgName}
              onChange={setOrgName}
              onSubmit={handleSubmitOrg}
              pending={submitOrg.isPending}
              t={t}
            />
          )}
          {displayStep === 2 && (
            <StepAgent
              agentName={agentName}
              onAgentName={setAgentName}
              provider={provider}
              onProvider={setProvider}
              apiKey={apiKey}
              onApiKey={setApiKey}
              onSubmit={handleSubmitAgent}
              pending={submitAgent.isPending}
              t={t}
            />
          )}
          {displayStep === 3 && (
            <StepPolicy
              policies={policies}
              onChange={setPolicies}
              onSubmit={handleSubmitPolicy}
              pending={submitPolicy.isPending}
              t={t}
            />
          )}
          {displayStep === 4 && (
            <StepSynthetic
              onFire={handleFireSynthetic}
              pending={fireSynthetic.isPending}
              fired={invocationIds.length > 0}
              t={t}
            />
          )}
          {displayStep === 5 && (
            <StepAuditLog
              invocationIds={invocationIds}
              onComplete={handleComplete}
              pending={complete.isPending}
              t={t}
            />
          )}

          {error && (
            <p
              className="mt-4 rounded-md border border-error/40 bg-error/5 px-3 py-2 text-sm text-error"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----- Step components — kept inline for cohesion of the 5-step flow ----- */

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function StepWelcome({ onStart, pending, t }: { onStart: () => void; pending: boolean; t: TFn }) {
  return (
    <>
      <h2 className="mb-2 text-lg font-medium">{t('onboardingV2.welcome.title')}</h2>
      <p className="mb-6 text-sm text-text-secondary">{t('onboardingV2.welcome.description')}</p>
      <ul className="mb-6 list-disc space-y-1 pl-5 text-sm text-text-secondary">
        <li>{t('onboardingV2.welcome.bullet1')}</li>
        <li>{t('onboardingV2.welcome.bullet2')}</li>
        <li>{t('onboardingV2.welcome.bullet3')}</li>
      </ul>
      <button
        type="button"
        onClick={onStart}
        disabled={pending}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? t('onboardingV2.starting') : t('onboardingV2.welcome.start')}
      </button>
    </>
  );
}

function StepOrganization({
  value, onChange, onSubmit, pending, t,
}: { value: string; onChange: (v: string) => void; onSubmit: () => void; pending: boolean; t: TFn }) {
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
    >
      <h2 className="mb-2 text-lg font-medium">{t('onboardingV2.org.title')}</h2>
      <p className="mb-4 text-sm text-text-secondary">{t('onboardingV2.org.description')}</p>
      <label className="mb-2 block text-sm font-medium" htmlFor="org-name">
        {t('onboardingV2.org.nameLabel')}
      </label>
      <input
        id="org-name"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('onboardingV2.org.namePlaceholder')}
        className="mb-6 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        autoFocus
        required
        maxLength={120}
      />
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? t('onboardingV2.saving') : t('onboardingV2.continue')}
      </button>
    </form>
  );
}

function StepAgent({
  agentName, onAgentName, provider, onProvider, apiKey, onApiKey, onSubmit, pending, t,
}: {
  agentName: string; onAgentName: (v: string) => void;
  provider: 'openai' | 'anthropic' | 'skip'; onProvider: (v: 'openai' | 'anthropic' | 'skip') => void;
  apiKey: string; onApiKey: (v: string) => void;
  onSubmit: () => void; pending: boolean; t: TFn;
}) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <h2 className="mb-2 text-lg font-medium">{t('onboardingV2.agent.title')}</h2>
      <p className="mb-4 text-sm text-text-secondary">{t('onboardingV2.agent.description')}</p>

      <label className="mb-2 block text-sm font-medium" htmlFor="agent-name">
        {t('onboardingV2.agent.nameLabel')}
      </label>
      <input
        id="agent-name"
        type="text"
        value={agentName}
        onChange={(e) => onAgentName(e.target.value)}
        className="mb-4 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        autoFocus
        required
        maxLength={120}
      />

      <fieldset className="mb-4">
        <legend className="mb-2 block text-sm font-medium">{t('onboardingV2.agent.providerLabel')}</legend>
        <div className="flex flex-col gap-2 text-sm">
          {(['openai', 'anthropic', 'skip'] as const).map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input
                type="radio"
                name="provider"
                checked={provider === p}
                onChange={() => onProvider(p)}
              />
              <span>{t(`onboardingV2.agent.provider.${p}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {provider !== 'skip' && (
        <>
          <label className="mb-2 block text-sm font-medium" htmlFor="api-key">
            {t('onboardingV2.agent.keyLabel')}
          </label>
          <input
            id="api-key"
            type="password"
            value={apiKey}
            onChange={(e) => onApiKey(e.target.value)}
            placeholder={t('onboardingV2.agent.keyPlaceholder')}
            className="mb-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm font-mono"
            maxLength={512}
          />
          <p className="mb-6 text-xs text-text-secondary">{t('onboardingV2.agent.keyNote')}</p>
        </>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? t('onboardingV2.saving') : t('onboardingV2.continue')}
      </button>
    </form>
  );
}

function StepPolicy({
  policies, onChange, onSubmit, pending, t,
}: {
  policies: OnboardingPolicyEntry[];
  onChange: (next: OnboardingPolicyEntry[]) => void;
  onSubmit: () => void; pending: boolean; t: TFn;
}) {
  function updateAt(i: number, patch: Partial<OnboardingPolicyEntry>) {
    onChange(policies.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <h2 className="mb-2 text-lg font-medium">{t('onboardingV2.policy.title')}</h2>
      <p className="mb-4 text-sm text-text-secondary">{t('onboardingV2.policy.description')}</p>

      <div className="mb-6 space-y-3">
        {policies.map((policy, i) => (
          <div key={policy.toolId} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
            <span className="font-mono text-sm">{policy.toolId}</span>
            <select
              value={policy.scope}
              onChange={(e) => updateAt(i, { scope: e.target.value as OnboardingPolicyEntry['scope'] })}
              className="rounded border border-border bg-surface px-2 py-1 text-xs"
              aria-label={t('onboardingV2.policy.scopeLabel')}
            >
              <option value="read">{t('onboardingV2.policy.scope.read')}</option>
              <option value="write">{t('onboardingV2.policy.scope.write')}</option>
              <option value="execute">{t('onboardingV2.policy.scope.execute')}</option>
            </select>
            <select
              value={policy.decision}
              onChange={(e) => updateAt(i, { decision: e.target.value as OnboardingPolicyEntry['decision'] })}
              className="rounded border border-border bg-surface px-2 py-1 text-xs"
              aria-label={t('onboardingV2.policy.decisionLabel')}
            >
              <option value="allow">{t('onboardingV2.policy.decision.allow')}</option>
              <option value="deny">{t('onboardingV2.policy.decision.deny')}</option>
              <option value="confirm">{t('onboardingV2.policy.decision.confirm')}</option>
            </select>
          </div>
        ))}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? t('onboardingV2.saving') : t('onboardingV2.continue')}
      </button>
    </form>
  );
}

function StepSynthetic({
  onFire, pending, fired, t,
}: { onFire: () => void; pending: boolean; fired: boolean; t: TFn }) {
  return (
    <>
      <h2 className="mb-2 text-lg font-medium">{t('onboardingV2.synthetic.title')}</h2>
      <p className="mb-6 text-sm text-text-secondary">{t('onboardingV2.synthetic.description')}</p>
      <button
        type="button"
        onClick={onFire}
        disabled={pending || fired}
        className="w-full rounded-lg bg-primary px-4 py-3 text-base font-medium text-white disabled:opacity-50"
      >
        {fired
          ? t('onboardingV2.synthetic.fired')
          : pending
            ? t('onboardingV2.synthetic.firing')
            : t('onboardingV2.synthetic.fire')}
      </button>
      <p className="mt-4 text-xs text-text-secondary">{t('onboardingV2.synthetic.note')}</p>
    </>
  );
}

function StepAuditLog({
  invocationIds, onComplete, pending, t,
}: { invocationIds: string[]; onComplete: () => void; pending: boolean; t: TFn }) {
  /* 3 行 invocation 的语义在后端硬编码，前端用同样的顺序展示注解 */
  const rows = [
    { kind: 'success', label: 'github.read_issues', note: t('onboardingV2.audit.note.success') },
    { kind: 'pending', label: 'email.send', note: t('onboardingV2.audit.note.pending') },
    { kind: 'denied', label: 'github.write_pr', note: t('onboardingV2.audit.note.denied') },
  ] as const;

  return (
    <>
      <h2 className="mb-2 text-lg font-medium">{t('onboardingV2.audit.title')}</h2>
      <p className="mb-4 text-sm text-text-secondary">{t('onboardingV2.audit.description')}</p>

      <div className="mb-6 space-y-2">
        {rows.map((row, i) => (
          <div
            key={row.label}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            data-invocation-id={invocationIds[i] ?? ''}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono">{row.label}</span>
              <StatusBadge kind={row.kind} t={t} />
            </div>
            <p className="mt-1 text-xs text-text-secondary">{row.note}</p>
          </div>
        ))}
      </div>

      <p className="mb-6 text-sm text-text-secondary">{t('onboardingV2.audit.summary')}</p>

      <button
        type="button"
        onClick={onComplete}
        disabled={pending}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? t('onboardingV2.saving') : t('onboardingV2.audit.done')}
      </button>
    </>
  );
}

function StatusBadge({ kind, t }: { kind: 'success' | 'pending' | 'denied'; t: TFn }) {
  const color = kind === 'success'
    ? 'border-success/40 bg-success/10 text-success'
    : kind === 'denied'
      ? 'border-error/40 bg-error/10 text-error'
      : 'border-warning/40 bg-warning/10 text-warning';
  return (
    <span className={`rounded border px-2 py-0.5 text-xs ${color}`}>
      {t(`onboardingV2.audit.status.${kind}`)}
    </span>
  );
}

function getErrorMessage(err: unknown, t: TFn): string {
  if (err instanceof Error) return err.message;
  return t('onboardingV2.errors.unknown');
}
