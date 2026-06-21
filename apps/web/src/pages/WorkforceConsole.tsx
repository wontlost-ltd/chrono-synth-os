import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useOrgChart, useOrgGoals, useWorkerPersonaSignal,
  useGoalTypes, usePendingApprovals, useRunGoal, useDecideApproval,
  type DigitalWorker, type OrgGoal, type OrgApproval,
} from '../api/queries/workforce';

/**
 * 数字员工组织治理控制台（E2 只读 + E3 交互）。
 *
 * 两个 tab：
 *   - 查看（只读）：组织图（员工 + 运营人格信号）+ 目标列表（回答「我的数字员工在干嘛」）；
 *   - 操作（admin）：发起目标 + 待审批 approve/reject（驱动数字员工；后端 requireRole('admin')，非 admin 会 403）。
 * 文案走 i18n（t()）。
 */
export default function WorkforceConsole() {
  const { t } = useTranslation();
  useDocumentTitle(t('workforce.title'));
  const [orgId, setOrgId] = useState('');
  const [committedOrgId, setCommittedOrgId] = useState('');
  const [tab, setTab] = useState<'view' | 'actions'>('view');

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
        <>
          {/* tab 切换：查看（只读）/ 操作（admin）。 */}
          <div className="mb-6 flex gap-2 border-b border-gray-200">
            <TabButton active={tab === 'view'} onClick={() => setTab('view')}>{t('workforce.viewTab')}</TabButton>
            <TabButton active={tab === 'actions'} onClick={() => setTab('actions')}>{t('workforce.actionsTab')}</TabButton>
          </div>

          {tab === 'view' ? (
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
          ) : (
            <div className="space-y-8">
              <p className="text-xs text-gray-400">{t('workforce.adminOnlyHint')}</p>
              <InitiateGoalSection orgId={committedOrgId} />
              <PendingApprovalsSection orgId={committedOrgId} />
            </div>
          )}
        </>
      )}
    </>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${active ? 'border-primary text-primary' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
    >
      {children}
    </button>
  );
}

/** 发起目标表单（E3 动作）：manager + 标题 + 类型 → 后端 runGoal（确定性 stub，无对外副作用）。 */
function InitiateGoalSection({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const goalTypes = useGoalTypes();
  const runGoal = useRunGoal(orgId);
  const [managerWorkerId, setManagerWorkerId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [goalType, setGoalType] = useState('');

  const canSubmit = managerWorkerId.trim() && title.trim() && goalType && !runGoal.isPending;

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold">{t('workforce.initiateGoalSection')}</h2>
      <p className="mb-3 text-xs text-gray-500">{t('workforce.initiateGoalHint')}</p>
      <div className="flex flex-col gap-3 sm:max-w-lg">
        <input
          value={managerWorkerId} onChange={e => setManagerWorkerId(e.target.value)}
          placeholder={t('workforce.managerWorkerIdLabel')}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          value={title} onChange={e => setTitle(e.target.value)}
          placeholder={t('workforce.goalTitleLabel')}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          value={description} onChange={e => setDescription(e.target.value)}
          placeholder={t('workforce.goalDescLabel')}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <select
          value={goalType} onChange={e => setGoalType(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">{t('workforce.goalTypeLabel')}</option>
          {(goalTypes.data ?? []).map(gt => <option key={gt.goalType} value={gt.goalType}>{gt.goalType}</option>)}
        </select>
        <button
          disabled={!canSubmit}
          onClick={() => runGoal.mutate({ managerWorkerId: managerWorkerId.trim(), title: title.trim(), description: description.trim(), goalType })}
          className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
        >
          {runGoal.isPending ? t('workforce.running') : t('workforce.runGoal')}
        </button>
        {runGoal.isError && <span className="text-sm text-red-600">{t('workforce.actionFailedWithMessage', { message: (runGoal.error as Error).message })}</span>}
        {runGoal.isSuccess && (
          <span className="text-sm text-green-600">
            {runGoal.data.pendingRealExecution > 0
              ? t('workforce.goalStartedWithPending', { count: runGoal.data.taskCount, pending: runGoal.data.pendingRealExecution })
              : t('workforce.goalStartedWithCount', { count: runGoal.data.taskCount })}
          </span>
        )}
      </div>
    </section>
  );
}

/** 待审批表格 + approve/reject（E3 动作）：你的批准记为法律责任主体。 */
function PendingApprovalsSection({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const pending = usePendingApprovals(orgId);
  const decide = useDecideApproval(orgId);

  const riskColor = (r: string) => r === 'high' ? 'text-red-600' : r === 'medium' ? 'text-amber-600' : 'text-gray-500';

  /* 高后果防误点：approve high 风险 + 所有 reject 都二次确认（批准=放行真实执行）。 */
  const onApprove = (r: OrgApproval) => {
    if (r.effectiveRisk === 'high' &&
      !window.confirm(t('workforce.confirmApproveHigh', { subject: `${r.subjectType}/${r.subjectId}`, risk: r.effectiveRisk, reason: r.reason }))) return;
    decide.mutate({ approvalId: r.id, decision: 'approve' });
  };
  const onReject = (r: OrgApproval) => {
    if (!window.confirm(t('workforce.confirmReject'))) return;
    decide.mutate({ approvalId: r.id, decision: 'reject' });
  };

  const columns: Column<OrgApproval>[] = [
    { id: 'risk', header: t('workforce.colRisk'), cell: r => <span className={`font-medium ${riskColor(r.effectiveRisk)}`}>{r.effectiveRisk}</span> },
    { id: 'subject', header: t('workforce.colSubject'), cell: r => <span className="text-xs">{r.subjectType}<span className="ml-1 text-gray-400">{r.subjectId}</span></span> },
    { id: 'requester', header: t('workforce.colRequester'), cell: r => <span className="text-xs text-gray-500">{r.requesterWorkerId}</span> },
    { id: 'reason', header: t('workforce.colReason'), cell: r => <span className="text-xs text-gray-500">{r.reason}</span> },
    {
      id: 'actions', header: t('workforce.colActions'), cell: r => (
        <div className="flex gap-2">
          <button
            disabled={decide.isPending}
            onClick={() => onApprove(r)}
            className="rounded bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >{t('workforce.approve')}</button>
          <button
            disabled={decide.isPending}
            onClick={() => onReject(r)}
            className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >{t('workforce.reject')}</button>
        </div>
      ),
    },
  ];

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold">{t('workforce.pendingApprovalsSection')}</h2>
      <p className="mb-3 text-xs text-gray-500">{t('workforce.pendingApprovalsHint')}</p>
      {pending.error ? (
        <EmptyState variant="error" message={pending.error.message} />
      ) : (
        <DataTable
          rows={pending.data ?? []}
          columns={columns}
          getRowId={r => r.id}
          loading={pending.isLoading}
          emptyState={<EmptyState title={t('workforce.noPendingTitle')} message={t('workforce.noPendingMessage')} />}
        />
      )}
      {decide.isError && <span className="mt-2 block text-sm text-red-600">{t('workforce.actionFailedWithMessage', { message: (decide.error as Error).message })}</span>}
    </section>
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
        {t('workforce.decisionConfidenceLabel')}<span className={`font-medium ${confidenceColor}`}>{data.decisionConfidence}</span>
        <span className="ml-2 text-gray-500">{t('workforce.load')} {data.operating.load}</span>
        <span className="ml-2 text-gray-500">{t('workforce.collaboration')} {data.collaborationReach}</span>
        {data.operating.overdueTaskCount > 0 && <span className="ml-2 font-medium text-red-600">{t('workforce.overdue')} {data.operating.overdueTaskCount}</span>}
        {data.operating.dueSoonTaskCount > 0 && <span className="ml-2 text-amber-600">{t('workforce.dueSoon')} {data.operating.dueSoonTaskCount}</span>}
      </span>
      {data.shouldReport && <span className="font-medium text-red-600">⚠ {t('workforce.needsAttentionLabel')}{data.confidenceRationale}</span>}
    </div>
  );
}
