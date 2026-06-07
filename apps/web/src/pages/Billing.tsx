import { useTranslation } from 'react-i18next';
import { usePlans, useUsage, useCreateCheckout, useCustomerPortal, useAddOns, usePurchaseAddOn } from '../api/queries/billing';
import type { AddOn, Plan } from '../api/queries/billing';
import { PageHeader } from '../components/layout/PageHeader';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function Billing() {
  const { t } = useTranslation();
  useDocumentTitle(t('billing.title'));
  const plans = usePlans();
  const usage = useUsage();
  const portal = useCustomerPortal();
  const addOns = useAddOns();
  const purchase = usePurchaseAddOn();
  const checkout = useCreateCheckout();

  function handleUpgrade(priceId: string) {
    checkout.mutate(
      { priceId, successUrl: window.location.href, cancelUrl: window.location.href },
      { onSuccess: (data) => { window.location.href = data.url; } },
    );
  }

  function handleManage() {
    portal.mutate({ returnUrl: window.location.href }, {
      onSuccess: (data) => { window.location.href = data.url; },
    });
  }

  if (plans.isLoading || usage.isLoading) return <Skeleton variant="card" />;

  if (plans.error || usage.error) {
    const message = (plans.error ?? usage.error)?.message ?? t('common.error');
    return <EmptyState variant="error" message={t('billing.loadError', { message })} />;
  }

  const currentPlan = plans.data?.find(p => p.id === usage.data?.planId);
  const effectiveLimits = usage.data?.effectiveLimits ?? usage.data?.limits;
  const activeAddOnIds = new Set((usage.data?.addOns ?? []).map(a => a.addOnId));

  return (
    <div className="space-y-6">
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />

      <div className="rounded-xl border border-border bg-surface-elevated p-6">
        <h2 className="text-lg font-semibold text-text-primary">{t('billing.currentPlanTitle')}</h2>
        <p className="mt-1 text-2xl font-bold text-primary">{currentPlan?.name ?? t('billing.freePlan')}</p>
        <p className="mt-1 text-sm text-text-secondary">
          {t('billing.statusLabel')}
          <span className="ml-1">
            {usage.data?.status === 'active' ? t('billing.activeStatus') : usage.data?.status ?? t('systemStatus.unknown')}
          </span>
        </p>
        {usage.data?.periodEnd && (
          <p className="text-sm text-text-secondary">
            {t('billing.renewalLabel')}{new Date(usage.data.periodEnd).toLocaleDateString()}
          </p>
        )}
        <button
          onClick={handleManage}
          disabled={portal.isPending}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
        >
          {portal.isPending ? t('billing.redirecting') : t('billing.manageSubscription')}
        </button>
        {portal.error && (
          <p className="mt-2 text-sm text-warning" role="alert">
            {t('billing.portalError', { message: portal.error.message ?? t('common.error') })}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-border bg-surface-elevated p-6">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">{t('billing.usageTitle')}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <UsageMeter
            label={t('billing.simulationsLabel')}
            used={usage.data?.usage?.['simulation'] ?? 0}
            limit={effectiveLimits?.maxSimulations ?? 0}
          />
          <UsageMeter
            label={t('billing.pathsLabel')}
            used={usage.data?.usage?.['paths'] ?? 0}
            limit={effectiveLimits?.maxPaths ?? 0}
          />
          <UsageMeter
            label={t('billing.llmTokensLabel')}
            used={usage.data?.usage?.['llm_tokens'] ?? 0}
            limit={effectiveLimits?.llmTokensPerMonth ?? 0}
          />
        </div>
        {(usage.data?.addOns?.length ?? 0) > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-xs text-text-secondary">{t('billing.activeAddOnsLabel')}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {usage.data?.addOns?.map(a => (
                <span key={a.addOnId} className="rounded bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                  {a.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-surface-elevated p-6">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">{t('billing.addOnsTitle')}</h2>
        {addOns.error ? (
          <p className="text-sm text-warning" role="alert">{t('billing.addOnsError', { message: addOns.error.message ?? t('common.error') })}</p>
        ) : addOns.data && addOns.data.filter(a => a.isActive).length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {addOns.data.filter(a => a.isActive).map(addon => (
              <AddOnCard
                key={addon.id}
                addon={addon}
                owned={activeAddOnIds.has(addon.id)}
                onPurchase={() => purchase.mutate(addon.id)}
                isPurchasing={purchase.isPending}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-secondary">{t('billing.addOnsEmpty')}</p>
        )}
        {purchase.error && (
          <p className="mt-2 text-sm text-warning" role="alert">{purchase.error.message}</p>
        )}
      </div>

      <div className="rounded-xl border border-border bg-surface-elevated p-6">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">{t('billing.availablePlansTitle')}</h2>
        {checkout.error && (
          <p className="mb-3 text-sm text-warning" role="alert">
            {t('billing.upgradeError', { message: checkout.error.message ?? t('common.error') })}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          {plans.data?.map(plan => (
            <PlanCard
              key={plan.id}
              plan={plan}
              isCurrent={plan.id === usage.data?.planId}
              onUpgrade={handleUpgrade}
              isUpgrading={checkout.isPending}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AddOnCard({ addon, owned, onPurchase, isPurchasing }: { addon: AddOn; owned: boolean; onPurchase: () => void; isPurchasing: boolean }) {
  const { t } = useTranslation();
  const resourceLabel = t(`billing.addOnResource.${addon.resource}`, { defaultValue: addon.resource });
  return (
    <div className={`rounded-lg border p-4 ${owned ? 'border-success bg-success/5' : 'border-border'}`}>
      <h3 className="font-semibold text-text-primary">{addon.name}</h3>
      {addon.description && <p className="mt-1 text-xs text-text-secondary">{addon.description}</p>}
      <p className="mt-2 text-sm text-text-primary">+{addon.quotaAmount.toLocaleString()} {resourceLabel}</p>
      {owned ? (
        <span className="mt-2 inline-block rounded bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
          {t('billing.addOnOwned')}
        </span>
      ) : (
        <button
          onClick={onPurchase}
          disabled={isPurchasing}
          className="mt-2 rounded bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary-light disabled:opacity-50"
        >
          {isPurchasing ? t('common.loading') : t('billing.purchaseAddOn')}
        </button>
      )}
    </div>
  );
}

function PlanCard({ plan, isCurrent, onUpgrade, isUpgrading }: { plan: Plan; isCurrent: boolean; onUpgrade: (priceId: string) => void; isUpgrading: boolean }) {
  const { t } = useTranslation();
  const fmt = (v: number) => v === -1 ? t('billing.unlimited') : String(v);
  const canUpgrade = !isCurrent && !!plan.stripePriceId;
  return (
    <div className={`rounded-lg border p-4 ${isCurrent ? 'border-primary bg-primary/5' : 'border-border'}`}>
      <h3 className="font-semibold text-text-primary">{plan.name}</h3>
      <ul className="mt-2 space-y-1 text-sm text-text-secondary">
        <li>{t('billing.simulationsLabel')}: {fmt(plan.limits.maxSimulations)}</li>
        <li>{t('billing.pathsLabel')}: {fmt(plan.limits.maxPaths)}</li>
        <li>{t('billing.llmTokensLabel')}: {plan.limits.llmTokensPerMonth === -1 ? t('billing.unlimited') : plan.limits.llmTokensPerMonth.toLocaleString()}</li>
      </ul>
      {isCurrent ? (
        <span className="mt-2 inline-block rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {t('billing.currentPlanBadge')}
        </span>
      ) : canUpgrade ? (
        <button
          onClick={() => onUpgrade(plan.stripePriceId)}
          disabled={isUpgrading}
          className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
        >
          {isUpgrading ? t('billing.redirecting') : t('billing.upgradePlan')}
        </button>
      ) : null}
    </div>
  );
}

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const { t } = useTranslation();
  const isUnlimited = limit === -1;
  const hasLimit = !isUnlimited && limit > 0;
  const pct = hasLimit ? Math.min((Math.max(used, 0) / limit) * 100, 100) : 0;
  return (
    <div>
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <p className="text-lg font-bold text-text-primary">
        {used.toLocaleString()} / {isUnlimited ? t('billing.unlimited') : limit.toLocaleString()}
      </p>
      {hasLimit && (
        <div
          className="mt-1 h-2 overflow-hidden rounded-full bg-border"
          role="progressbar"
          aria-label={label}
          aria-valuenow={Math.min(used, limit)}
          aria-valuemin={0}
          aria-valuemax={limit}
        >
          <div
            className={`h-full w-full origin-left rounded-full transition-transform duration-200 ease-out motion-reduce:transition-none ${pct > 90 ? 'bg-warning' : 'bg-primary'}`}
            style={{ transform: `scaleX(${Math.min(pct, 100) / 100})` }}
          />
        </div>
      )}
    </div>
  );
}
