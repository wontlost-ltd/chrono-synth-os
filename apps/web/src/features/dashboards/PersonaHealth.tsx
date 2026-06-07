/**
 * PersonaHealth — single-persona health dashboard (P2.7 — full).
 *
 * 5-panel composition:
 *   1. ValueRadar       (current + d7 + d30)
 *   2. DecisionTrend    (30d daily count)
 *   3. MemoryStack      (30d episodic / semantic / procedural)
 *   4. ToolMix          (7d tool invocation pie)
 *   5. DriftTimeline    (90d drift report scatter, sized by alert level)
 *
 * Behind the `experimental.values_health_dashboard` feature flag —
 * default OFF, opt-in via localStorage flag override or remote provider.
 */

import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/layout/PageHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { useFeatureFlag } from '../../lib/featureFlags';
import { usePersonaHealth } from '../../api/queries/dashboards';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ValueRadar } from './charts/ValueRadar';
import { DecisionTrend } from './charts/DecisionTrend';
import { MemoryStack } from './charts/MemoryStack';
import { ToolMix } from './charts/ToolMix';
import { DriftTimeline } from './charts/DriftTimeline';

export function PersonaHealth() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const personaId = id ?? '';
  useDocumentTitle(t('personaHealth.title'));

  const enabled = useFeatureFlag('experimental.values_health_dashboard', false);
  const query = usePersonaHealth(personaId, enabled);

  if (!enabled) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t('personaHealth.title')}
          subtitle={t('personaHealth.subtitle', { personaId })}
        />
        <EmptyState
          illustration="search"
          title={t('personaHealth.disabled.title')}
          message={t('personaHealth.disabled.message')}
        />
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t('personaHealth.title')}
          subtitle={t('personaHealth.subtitle', { personaId })}
        />
        <Skeleton variant="card" />
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t('personaHealth.title')}
          subtitle={t('personaHealth.subtitle', { personaId })}
        />
        <EmptyState
          variant="error"
          message={t('personaHealth.errors.loadFailed', {
            message: (query.error as Error).message,
          })}
        />
      </div>
    );
  }

  const data = query.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('personaHealth.title')}
        subtitle={t('personaHealth.subtitle', { personaId })}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel headingKey="personaHealth.radar.heading">
          {data && data.values.length > 0 ? (
            <ValueRadar
              data={data.values}
              legendLabels={{
                current: t('personaHealth.radar.legend.current'),
                d7: t('personaHealth.radar.legend.d7'),
                d30: t('personaHealth.radar.legend.d30'),
              }}
            />
          ) : (
            <EmptyState illustration="memories" message={t('personaHealth.radar.empty')} />
          )}
        </Panel>

        <Panel headingKey="personaHealth.decisionTrend.heading">
          {data && data.decisionTrend.length > 0 ? (
            <DecisionTrend data={data.decisionTrend} />
          ) : (
            <EmptyState message={t('personaHealth.decisionTrend.empty')} />
          )}
        </Panel>

        <Panel headingKey="personaHealth.memoryStack.heading">
          {data && data.memoryStack.length > 0 ? (
            <MemoryStack
              data={data.memoryStack}
              legendLabels={{
                episodic: t('personaHealth.memoryStack.legend.episodic'),
                semantic: t('personaHealth.memoryStack.legend.semantic'),
                procedural: t('personaHealth.memoryStack.legend.procedural'),
              }}
            />
          ) : (
            <EmptyState illustration="memories" message={t('personaHealth.memoryStack.empty')} />
          )}
        </Panel>

        <Panel headingKey="personaHealth.toolMix.heading">
          {data && data.toolMix.length > 0 ? (
            <ToolMix data={data.toolMix} />
          ) : (
            <EmptyState illustration="tools" message={t('personaHealth.toolMix.empty')} />
          )}
        </Panel>

        <div className="xl:col-span-2">
          <Panel headingKey="personaHealth.driftTimeline.heading">
            {data && data.driftTimeline.length > 0 ? (
              <DriftTimeline data={data.driftTimeline} />
            ) : (
              <EmptyState illustration="safety" message={t('personaHealth.driftTimeline.empty')} />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Panel({
  headingKey,
  children,
}: {
  headingKey: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby={`panel-${headingKey}`}
      className="rounded-xl border border-border bg-surface-elevated p-4"
    >
      <h2
        id={`panel-${headingKey}`}
        className="mb-3 text-base font-semibold text-text-primary"
      >
        {t(headingKey)}
      </h2>
      {children}
    </section>
  );
}
