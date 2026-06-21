import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useOrgChart, useOrgGoals, useWorkerPersonaSignal,
  type DigitalWorker, type OrgGoal,
} from '../api/queries/workforce';

/**
 * 数字员工组织治理控制台（E2，只读）。
 *
 * 回答「我的数字员工在干嘛」：输入 org id → 看组织图（每个数字员工的岗位 + 运营人格信号：决策置信度/
 * 负载/是否需关注）+ 目标列表。全部只读（不发起委派/执行；写操作留 E3）。文案走 i18n（t()）。
 */
export default function WorkforceConsole() {
  const { t } = useTranslation();
  useDocumentTitle(t('workforce.title'));
  const [orgId, setOrgId] = useState('');
  const [committedOrgId, setCommittedOrgId] = useState('');

  const chart = useOrgChart(committedOrgId);
  const goals = useOrgGoals(committedOrgId);

  /* positionId → 岗位（title + roleCode），让员工行能显示岗位而非只有名字。 */
  const positionById = new Map((chart.data?.positions ?? []).map(p => [p.id, p]));

  const workerColumns: Column<DigitalWorker>[] = [
    { id: 'name', header: t('workforce.colWorker'), cell: r => <span className="font-medium">{r.displayName}</span> },
    {
      id: 'position', header: t('workforce.colPosition'), cell: r => {
        const pos = positionById.get(r.positionId);
        return pos ? <span className="text-sm">{pos.title}<span className="ml-1 text-xs text-gray-400">{pos.roleCode}</span></span> : <span className="text-xs text-gray-400">—</span>;
      },
    },
    { id: 'status', header: t('workforce.colStatus'), cell: r => <StatusBadge status={r.employmentStatus === 'active' ? 'active' : 'paused'} label={r.employmentStatus} /> },
    { id: 'signal', header: t('workforce.colSignal'), cell: r => <WorkerSignalCell orgId={committedOrgId} workerId={r.id} /> },
  ];

  const goalColumns: Column<OrgGoal>[] = [
    { id: 'title', header: t('workforce.colGoal'), cell: r => <span className="font-medium">{r.title}</span> },
    { id: 'type', header: t('workforce.colType'), cell: r => <span className="text-sm text-gray-500">{r.goalType}</span> },
    { id: 'status', header: t('workforce.colStatus'), cell: r => <StatusBadge status={r.status === 'completed' ? 'completed' : 'active'} label={r.status} /> },
  ];

  return (
    <>
      <PageHeader title={t('workforce.title')} subtitle={t('workforce.subtitle')} />

      <div className="mb-6 flex items-end gap-2">
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-gray-600">{t('workforce.orgIdLabel')}</span>
          <input
            value={orgId}
            onChange={e => setOrgId(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') setCommittedOrgId(orgId.trim()); }}
            placeholder={t('workforce.orgIdPlaceholder')}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          onClick={() => setCommittedOrgId(orgId.trim())}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
        >
          {t('workforce.view')}
        </button>
      </div>

      {!committedOrgId ? (
        <EmptyState title={t('workforce.selectOrgTitle')} message={t('workforce.selectOrgMessage')} />
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('workforce.workersSection')}</h2>
            {chart.error ? (
              <EmptyState variant="error" message={chart.error.message} />
            ) : (
              <DataTable
                rows={chart.data?.workers ?? []}
                columns={workerColumns}
                getRowId={r => r.id}
                loading={chart.isLoading}
                emptyState={<EmptyState title={t('workforce.noWorkersTitle')} message={t('workforce.noWorkersMessage')} />}
              />
            )}
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('workforce.goalsSection')}</h2>
            {goals.error ? (
              <EmptyState variant="error" message={goals.error.message} />
            ) : (
              <DataTable
                rows={goals.data ?? []}
                columns={goalColumns}
                getRowId={r => r.id}
                loading={goals.isLoading}
                emptyState={<EmptyState title={t('workforce.noGoalsTitle')} message={t('workforce.noGoalsMessage')} />}
              />
            )}
          </section>
        </div>
      )}
    </>
  );
}

/** 单元格：拉某 worker 的人格信号，渲染决策置信度 + 负载 + 是否需关注（运营语言，非心情）。 */
function WorkerSignalCell({ orgId, workerId }: { orgId: string; workerId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useWorkerPersonaSignal(orgId, workerId);
  if (isLoading) return <span className="text-xs text-gray-400">{t('workforce.loading')}</span>;
  if (error || !data) return <span className="text-xs text-gray-400">—</span>;

  const confidenceColor =
    data.decisionConfidence === 'high' ? 'text-green-600'
      : data.decisionConfidence === 'low' ? 'text-red-600'
        : 'text-amber-600';

  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <span>
        {t('workforce.decisionConfidence')}：<span className={`font-medium ${confidenceColor}`}>{data.decisionConfidence}</span>
        <span className="ml-2 text-gray-500">{t('workforce.load')} {data.operating.load}</span>
        <span className="ml-2 text-gray-500">{t('workforce.collaboration')} {data.collaborationReach}</span>
      </span>
      {data.shouldReport && <span className="font-medium text-red-600">⚠ {t('workforce.needsAttention')}：{data.confidenceRationale}</span>}
    </div>
  );
}
