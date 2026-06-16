/**
 * per-persona 治理策略配置页（ADR-0048 治理可配化，PR-C）。
 *
 * owner 为单个 persona 覆盖默认治理策略：每 category 的接单路由（自主/人工/禁止）、
 * 单任务自主报酬上限、每日报酬暴露上限、并发上限、AML 聚合阈值。
 *
 * 整体替换语义：保存即提交「完整覆盖对象」（categoryRoutes 是完整路由表，未列出的 category
 * 走 effective 的 defaultCategoryRoute）。空表单字段 = 不覆盖该项 → 沿用默认。
 */

import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { FormField } from '../components/ui/FormField';
import { Skeleton } from '../components/ui/Skeleton';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useGovernancePolicy,
  useSetGovernancePolicy,
  useResetGovernancePolicy,
  type GovernanceOverride,
  type CategoryRouteMode,
  type MarketplaceTaskCategory,
} from '../api/queries/persona-governance';

const CATEGORIES: MarketplaceTaskCategory[] = ['writing', 'coding', 'research', 'operations', 'general'];
const ROUTE_MODES: CategoryRouteMode[] = ['autonomous', 'human_review', 'blocked'];

/** 表单态：数值字段用 string（空串 = 不覆盖）。 */
interface FormState {
  categoryRoutes: Partial<Record<MarketplaceTaskCategory, CategoryRouteMode | ''>>;
  defaultCategoryRoute: CategoryRouteMode | '';
  maxAutonomousReward: string;
  dailyRewardExposureCap: string;
  maxConcurrentTasks: string;
  amlMaxTasksPerPublisherPerWindow: string;
  amlMaxPublisherRewardShare: string;
  amlConcentrationMinTasks: string;
  amlMaxIdenticalRewardRepeats: string;
  unverifiedGrowthBudgetPerWindow: string;
}

function numOrEmpty(v: number | undefined): string {
  return v === undefined ? '' : String(v);
}

function overrideToForm(o: GovernanceOverride | null): FormState {
  return {
    categoryRoutes: { ...(o?.categoryRoutes ?? {}) },
    defaultCategoryRoute: o?.defaultCategoryRoute ?? '',
    maxAutonomousReward: numOrEmpty(o?.maxAutonomousReward),
    dailyRewardExposureCap: numOrEmpty(o?.dailyRewardExposureCap),
    maxConcurrentTasks: numOrEmpty(o?.maxConcurrentTasks),
    amlMaxTasksPerPublisherPerWindow: numOrEmpty(o?.aml?.maxTasksPerPublisherPerWindow),
    amlMaxPublisherRewardShare: numOrEmpty(o?.aml?.maxPublisherRewardShare),
    amlConcentrationMinTasks: numOrEmpty(o?.aml?.concentrationMinTasks),
    amlMaxIdenticalRewardRepeats: numOrEmpty(o?.aml?.maxIdenticalRewardRepeats),
    unverifiedGrowthBudgetPerWindow: numOrEmpty(o?.unverifiedGrowthBudgetPerWindow),
  };
}

/** 表单 → 覆盖对象（空串字段省略；空 categoryRoutes 不传）。 */
function formToOverride(f: FormState): GovernanceOverride {
  const out: GovernanceOverride = {};
  const routes: Partial<Record<MarketplaceTaskCategory, CategoryRouteMode>> = {};
  for (const [cat, mode] of Object.entries(f.categoryRoutes)) {
    if (mode) routes[cat as MarketplaceTaskCategory] = mode;
  }
  if (Object.keys(routes).length > 0) out.categoryRoutes = routes;
  if (f.defaultCategoryRoute) out.defaultCategoryRoute = f.defaultCategoryRoute;
  const setNum = (s: string, set: (n: number) => void) => {
    if (s.trim() !== '') { const n = Number(s); if (Number.isFinite(n)) set(n); }
  };
  setNum(f.maxAutonomousReward, (n) => { out.maxAutonomousReward = n; });
  setNum(f.dailyRewardExposureCap, (n) => { out.dailyRewardExposureCap = n; });
  setNum(f.maxConcurrentTasks, (n) => { out.maxConcurrentTasks = n; });
  const aml: NonNullable<GovernanceOverride['aml']> = {};
  setNum(f.amlMaxTasksPerPublisherPerWindow, (n) => { aml.maxTasksPerPublisherPerWindow = n; });
  setNum(f.amlMaxPublisherRewardShare, (n) => { aml.maxPublisherRewardShare = n; });
  setNum(f.amlConcentrationMinTasks, (n) => { aml.concentrationMinTasks = n; });
  setNum(f.amlMaxIdenticalRewardRepeats, (n) => { aml.maxIdenticalRewardRepeats = n; });
  if (Object.keys(aml).length > 0) out.aml = aml;
  setNum(f.unverifiedGrowthBudgetPerWindow, (n) => { out.unverifiedGrowthBudgetPerWindow = n; });
  return out;
}

const INPUT_CLASS =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none';

export default function PersonaGovernance() {
  const { t } = useTranslation();
  const { personaId = '' } = useParams<{ personaId: string }>();
  useDocumentTitle(t('governance.title'));

  const { data, isLoading, error } = useGovernancePolicy(personaId);
  const setMutation = useSetGovernancePolicy(personaId);
  const resetMutation = useResetGovernancePolicy(personaId);

  const [form, setForm] = useState<FormState | null>(null);
  /* 首次/刷新拿到数据时用 override 初始化表单（仅当本地未编辑过）。 */
  const initialForm = useMemo(() => (data ? overrideToForm(data.override) : null), [data]);
  const effectiveForm = form ?? initialForm;

  if (isLoading) return <div className="p-6"><Skeleton className="h-64 w-full" /></div>;
  if (error || !data || !effectiveForm) {
    return (
      <div className="p-6">
        <PageHeader title={t('governance.title')} subtitle={t('governance.loadError')} />
      </div>
    );
  }

  const f = effectiveForm;
  const update = (patch: Partial<FormState>) => setForm({ ...f, ...patch });

  const onSave = () => {
    setMutation.mutate(formToOverride(f), { onSuccess: (res) => setForm(overrideToForm(res.override)) });
  };
  const onReset = () => {
    resetMutation.mutate(undefined, { onSuccess: () => setForm(overrideToForm(null)) });
  };

  const saveError = setMutation.error instanceof Error ? setMutation.error.message : null;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={t('governance.title')}
        subtitle={t('governance.subtitle', { personaId })}
        actions={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onReset}
              disabled={resetMutation.isPending}
              className="rounded-md border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover disabled:opacity-50"
            >
              {t('governance.reset')}
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={setMutation.isPending}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {setMutation.isPending ? t('governance.saving') : t('governance.save')}
            </button>
          </div>
        }
      />

      {saveError && <p role="alert" className="text-sm text-warning">{t('governance.saveError', { message: saveError })}</p>}
      {data.meta && (
        <p className="text-xs text-text-secondary">
          {t('governance.lastUpdated', { by: data.meta.updatedBy ?? '—', at: new Date(data.meta.updatedAt).toLocaleString() })}
        </p>
      )}

      {/* category 路由表 */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">{t('governance.categoryRoutes')}</h2>
        <p className="text-xs text-text-secondary">{t('governance.categoryRoutesHint')}</p>
        <div className="space-y-2">
          {CATEGORIES.map((cat) => (
            <div key={cat} className="flex items-center gap-3">
              <span className="w-28 text-sm text-text-primary">{t(`governance.category.${cat}`)}</span>
              <select
                className={INPUT_CLASS}
                value={f.categoryRoutes[cat] ?? ''}
                onChange={(e) =>
                  update({ categoryRoutes: { ...f.categoryRoutes, [cat]: e.target.value as CategoryRouteMode | '' } })
                }
              >
                <option value="">{t('governance.routeDefault')}</option>
                {ROUTE_MODES.map((m) => (
                  <option key={m} value={m}>{t(`governance.routeMode.${m}`)}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
        {/* defaultCategoryRoute：未在上表显式设定的 category 走此兜底（仅 routes 模式生效）。 */}
        <div className="flex items-center gap-3 pt-1">
          <span className="w-28 text-sm text-text-secondary">{t('governance.defaultRoute')}</span>
          <select
            className={INPUT_CLASS}
            value={f.defaultCategoryRoute}
            onChange={(e) => update({ defaultCategoryRoute: e.target.value as CategoryRouteMode | '' })}
          >
            <option value="">{t('governance.routeDefault')}</option>
            {ROUTE_MODES.map((m) => (
              <option key={m} value={m}>{t(`governance.routeMode.${m}`)}</option>
            ))}
          </select>
        </div>
      </section>

      {/* 经济上限 */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">{t('governance.economicLimits')}</h2>
        <FormField label={t('governance.maxAutonomousReward')} description={t('governance.maxAutonomousRewardHint')}>
          {(p) => <input {...p} type="number" min="0" className={INPUT_CLASS} value={f.maxAutonomousReward}
            onChange={(e) => update({ maxAutonomousReward: e.target.value })} placeholder={String(data.effective.maxAutonomousReward)} />}
        </FormField>
        <FormField label={t('governance.dailyRewardExposureCap')}>
          {(p) => <input {...p} type="number" min="0" className={INPUT_CLASS} value={f.dailyRewardExposureCap}
            onChange={(e) => update({ dailyRewardExposureCap: e.target.value })} placeholder={String(data.effective.dailyRewardExposureCap)} />}
        </FormField>
        <FormField label={t('governance.maxConcurrentTasks')}>
          {(p) => <input {...p} type="number" min="1" step="1" className={INPUT_CLASS} value={f.maxConcurrentTasks}
            onChange={(e) => update({ maxConcurrentTasks: e.target.value })} placeholder={String(data.effective.maxConcurrentTasks)} />}
        </FormField>
      </section>

      {/* AML 聚合阈值 */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">{t('governance.amlThresholds')}</h2>
        <p className="text-xs text-text-secondary">{t('governance.amlHint')}</p>
        <FormField label={t('governance.amlMaxTasksPerPublisher')}>
          {(p) => <input {...p} type="number" min="1" step="1" className={INPUT_CLASS} value={f.amlMaxTasksPerPublisherPerWindow}
            onChange={(e) => update({ amlMaxTasksPerPublisherPerWindow: e.target.value })} placeholder={String(data.effective.aml.maxTasksPerPublisherPerWindow)} />}
        </FormField>
        <FormField label={t('governance.amlMaxRewardShare')} description={t('governance.amlMaxRewardShareHint')}>
          {(p) => <input {...p} type="number" min="0" max="1" step="0.05" className={INPUT_CLASS} value={f.amlMaxPublisherRewardShare}
            onChange={(e) => update({ amlMaxPublisherRewardShare: e.target.value })} placeholder={String(data.effective.aml.maxPublisherRewardShare)} />}
        </FormField>
        <FormField label={t('governance.amlConcentrationMinTasks')}>
          {(p) => <input {...p} type="number" min="1" step="1" className={INPUT_CLASS} value={f.amlConcentrationMinTasks}
            onChange={(e) => update({ amlConcentrationMinTasks: e.target.value })} placeholder={String(data.effective.aml.concentrationMinTasks)} />}
        </FormField>
        <FormField label={t('governance.amlMaxIdenticalRepeats')}>
          {(p) => <input {...p} type="number" min="1" step="1" className={INPUT_CLASS} value={f.amlMaxIdenticalRewardRepeats}
            onChange={(e) => update({ amlMaxIdenticalRewardRepeats: e.target.value })} placeholder={String(data.effective.aml.maxIdenticalRewardRepeats)} />}
        </FormField>
      </section>

      {/* 不确定性预算（成长治理）。effective 不含此值（属 DistillationPolicy），故无 placeholder。 */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">{t('governance.uncertaintyBudget')}</h2>
        <p className="text-xs text-text-secondary">{t('governance.uncertaintyBudgetHint')}</p>
        <FormField label={t('governance.unverifiedGrowthBudget')}>
          {(p) => <input {...p} type="number" min="0" step="1" className={INPUT_CLASS} value={f.unverifiedGrowthBudgetPerWindow}
            onChange={(e) => update({ unverifiedGrowthBudgetPerWindow: e.target.value })} placeholder={t('governance.unverifiedGrowthBudgetPlaceholder')} />}
        </FormField>
      </section>
    </div>
  );
}
