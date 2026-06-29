/**
 * 组织工单市场（ADR-0058）——组织作为接单方竞标工单市场，发布者确认委派，组织执行并结算入金库。
 *
 * 三个视角（同页 tab）：
 *   ① 组织视角：领取 open 工单（apply）、看「我的申请/我的指派」、启动执行(start)、提交(submit)；
 *   ② 发布者视角：看某工单的申请者、确认委派给某组织(confirm-assign)、验收结算(accept)；
 *   ③ 验资标记：工单展示发布者是否已验资（本轮只标记不阻塞）。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { Button } from '../components/ui/Button';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useMarketplaceTasks, useApplyToTask, useAssignTask, useTaskApplicants } from '../api/queries/marketplace';
import { usePersonaCoreList } from '../api/queries/personaCore';
import {
  useOrgBidApplications, useOrgBidAssignments, useOrgBidApplicants,
  useOrgBidApply, useOrgBidConfirmAssign, useOrgBidStart, useOrgBidSubmit, useOrgBidAccept,
  useGoalTypes, useOrgChart,
} from '../api/queries/workforce';

export default function OrgMarketplace() {
  const { t } = useTranslation();
  useDocumentTitle(t('orgMarket.title'));
  const [orgId, setOrgId] = useState('');
  const [committedOrgId, setCommittedOrgId] = useState('');

  return (
    <div>
      <PageHeader title={t('orgMarket.title')} subtitle={t('orgMarket.subtitle')} />

      <div className="mb-6 flex items-end gap-2">
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-gray-600">{t('orgMarket.orgIdLabel')}</span>
          <input
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setCommittedOrgId(orgId.trim()); }}
            placeholder="chrono-digital-org"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <Button onClick={() => setCommittedOrgId(orgId.trim())}>
          {t('orgMarket.load')}
        </Button>
      </div>

      {!committedOrgId ? (
        <EmptyState title={t('orgMarket.selectOrgTitle')} message={t('orgMarket.selectOrgMessage')} />
      ) : (
        <div className="space-y-10">
          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('orgMarket.openTasksSection')}</h2>
            <OpenTasks orgId={committedOrgId} t={t} />
          </section>
          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('orgMarket.myApplicationsSection')}</h2>
            <MyApplications orgId={committedOrgId} t={t} />
          </section>
          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('orgMarket.myAssignmentsSection')}</h2>
            <MyAssignments orgId={committedOrgId} t={t} />
          </section>
          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('orgMarket.publisherSection')}</h2>
            <PublisherView orgId={committedOrgId} t={t} />
          </section>
        </div>
      )}
    </div>
  );
}

type T = (k: string) => string;
const card = 'rounded-lg border border-gray-200 bg-white p-3 text-sm';
const badge = (color: string) => ({ backgroundColor: color, color: '#fff', borderRadius: 6, padding: '1px 8px', fontSize: 12 });
const STATUS_COLOR: Record<string, string> = {
  open: '#3b82f6', accepted: '#f59e0b', completed: '#10b981', cancelled: '#9ca3af',
  submitted: '#34d399', assigned: '#f59e0b', in_progress: '#60a5fa', rejected: '#f87171',
};

/* ① 接单视角：可领的 open 工单。两种接单方——组织领取 / 数字人格申请（ADR-0058 双边）。 */
function OpenTasks({ orgId, t }: { orgId: string; t: T }) {
  const tasks = useMarketplaceTasks('open');
  if (tasks.isLoading) return <p className="text-sm text-gray-400">{t('orgMarket.loading')}</p>;
  const list = tasks.data ?? [];
  if (list.length === 0) return <EmptyState message={t('orgMarket.noOpenTasks')} />;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {list.map((task) => <OpenTaskCard key={task.id} task={task} orgId={orgId} t={t} />)}
    </div>
  );
}

function OpenTaskCard({ task, orgId, t }: { task: { id: string; title: string; description: string; status: string; reward: number; currency: string; publisherVerified?: boolean }; orgId: string; t: T }) {
  const orgApply = useOrgBidApply(orgId);
  const personaApply = useApplyToTask(task.id);
  const personas = usePersonaCoreList();
  const [personaId, setPersonaId] = useState('');
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <span className="font-medium">{task.title}</span>
        <span style={badge(STATUS_COLOR[task.status] ?? '#9ca3af')}>{task.status}</span>
      </div>
      <p className="mt-1 text-gray-600">{task.description}</p>
      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
        <span>{t('orgMarket.reward')}: {task.reward} {task.currency}</span>
        <PublisherVerifiedBadge verified={task.publisherVerified} t={t} />
      </div>
      {/* 组织领取 */}
      <Button size="sm" className="mt-2" onClick={() => orgApply.mutate({ taskId: task.id })} disabled={orgApply.isPending}>
        {t('orgMarket.claimAsOrg')}
      </Button>
      {orgApply.isError && <p className="mt-1 text-xs text-red-500">{orgApply.error.message}</p>}
      {/* 数字人格申请 */}
      <div className="mt-2 flex items-center gap-2">
        <select value={personaId} onChange={(e) => setPersonaId(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-xs">
          <option value="">{t('orgMarket.selectPersona')}</option>
          {(personas.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
        <Button
          size="sm"
          onClick={() => personaApply.mutate({ personaId })}
          disabled={!personaId || personaApply.isPending}
        >
          {t('orgMarket.claimAsPersona')}
        </Button>
      </div>
      {personaApply.isError && <p className="mt-1 text-xs text-red-500">{personaApply.error.message}</p>}
    </div>
  );
}

function PublisherVerifiedBadge({ verified, t }: { verified?: boolean; t: T }) {
  return verified
    ? <span style={badge('#10b981')}>{t('orgMarket.verified')}</span>
    : <span style={badge('#9ca3af')}>{t('orgMarket.unverified')}</span>;
}

/* 组织视角：我的申请（领取的工单）。 */
function MyApplications({ orgId, t }: { orgId: string; t: T }) {
  const apps = useOrgBidApplications(orgId);
  if (apps.isLoading) return <p className="text-sm text-gray-400">{t('orgMarket.loading')}</p>;
  const list = apps.data ?? [];
  if (list.length === 0) return <EmptyState message={t('orgMarket.noApplications')} />;
  return (
    <div className="space-y-2">
      {list.map((a) => (
        <div key={a.id} className={`${card} flex items-center justify-between`}>
          <span className="font-mono text-xs">{a.taskId}</span>
          <span style={badge(STATUS_COLOR[a.status] ?? '#9ca3af')}>{a.status}</span>
        </div>
      ))}
    </div>
  );
}

/* 组织视角：委派给我的工单（指派）+ 启动/提交动作。 */
function MyAssignments({ orgId, t }: { orgId: string; t: T }) {
  const assigns = useOrgBidAssignments(orgId);
  const goalTypes = useGoalTypes();
  const chart = useOrgChart(orgId);
  const start = useOrgBidStart(orgId);
  const submit = useOrgBidSubmit(orgId);
  const [goalType, setGoalType] = useState('');
  const [managerId, setManagerId] = useState('');

  if (assigns.isLoading) return <p className="text-sm text-gray-400">{t('orgMarket.loading')}</p>;
  const list = assigns.data ?? [];
  if (list.length === 0) return <EmptyState message={t('orgMarket.noAssignments')} />;
  const managers = (chart.data?.workers ?? []).filter((w) => w.employmentStatus === 'active');

  return (
    <div className="space-y-3">
      {list.map((a) => (
        <div key={a.id} className={card}>
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs">{a.taskId}</span>
            <span style={badge(STATUS_COLOR[a.status] ?? '#9ca3af')}>{a.status}</span>
          </div>
          {a.status === 'assigned' && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <select value={managerId} onChange={(e) => setManagerId(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-xs">
                <option value="">{t('orgMarket.selectManager')}</option>
                {managers.map((w) => <option key={w.id} value={w.id}>{w.displayName}</option>)}
              </select>
              <select value={goalType} onChange={(e) => setGoalType(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-xs">
                <option value="">{t('orgMarket.selectGoalType')}</option>
                {(goalTypes.data ?? []).map((g) => <option key={g.goalType} value={g.goalType}>{g.goalType}</option>)}
              </select>
              <Button size="sm" onClick={() => start.mutate({ taskId: a.taskId, managerWorkerId: managerId, goalType })} disabled={!managerId || !goalType || start.isPending}>
                {t('orgMarket.start')}
              </Button>
            </div>
          )}
          {a.status === 'in_progress' && (
            <Button variant="success" size="sm" onClick={() => submit.mutate({ taskId: a.taskId })} disabled={submit.isPending} className="mt-2">
              {t('orgMarket.submit')}
            </Button>
          )}
          {start.isError && <p className="mt-1 text-xs text-red-500">{start.error.message}</p>}
          {submit.isError && <p className="mt-1 text-xs text-red-500">{submit.error.message}</p>}
        </div>
      ))}
    </div>
  );
}

/* ② 发布者视角：选一个工单，看「组织申请者 + 数字人格申请者」，确认委派给任一（org 或 persona）/ 验收结算。 */
function PublisherView({ orgId, t }: { orgId: string; t: T }) {
  const [taskId, setTaskId] = useState('');
  const [committedTaskId, setCommittedTaskId] = useState('');
  const orgApplicants = useOrgBidApplicants(orgId, committedTaskId);
  const personaApplicants = useTaskApplicants(committedTaskId);
  const confirmAssignOrg = useOrgBidConfirmAssign(orgId);
  const assignPersona = useAssignTask(committedTaskId);
  const accept = useOrgBidAccept(orgId);

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-gray-600">{t('orgMarket.taskIdLabel')}</span>
          <input value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder="mkt_…" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <Button onClick={() => setCommittedTaskId(taskId.trim())}>
          {t('orgMarket.viewApplicants')}
        </Button>
        <Button variant="success" onClick={() => accept.mutate({ taskId: committedTaskId })} disabled={!committedTaskId || accept.isPending}>
          {t('orgMarket.acceptSettle')}
        </Button>
      </div>
      {accept.isSuccess && accept.data.settlement && (
        <p className="text-xs text-green-600">{t('orgMarket.settled')}: {accept.data.settlement.orgAmountMinor} ({t('orgMarket.walletBalance')}: {accept.data.walletBalance})</p>
      )}
      {accept.isError && <p className="text-xs text-red-500">{accept.error.message}</p>}
      {committedTaskId && (
        <div className="space-y-4">
          {/* 组织申请者 */}
          <div>
            <h3 className="mb-1 text-sm font-medium text-gray-700">{t('orgMarket.orgApplicants')}</h3>
            {(orgApplicants.data ?? []).length === 0 ? (
              <p className="text-xs text-gray-400">{t('orgMarket.noOrgApplicants')}</p>
            ) : (
              <div className="space-y-2">
                {(orgApplicants.data ?? []).map((a) => (
                  <div key={a.id} className={`${card} flex items-center justify-between`}>
                    <span>🏢 {a.orgId} · {t('orgMarket.score')}: {a.rankingScore}</span>
                    <div className="flex items-center gap-2">
                      <span style={badge(STATUS_COLOR[a.status] ?? '#9ca3af')}>{a.status}</span>
                      {a.status === 'submitted' && (
                        <Button size="sm" onClick={() => confirmAssignOrg.mutate({ taskId: committedTaskId, orgId: a.orgId })} disabled={confirmAssignOrg.isPending}>
                          {t('orgMarket.assignToOrg')}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {confirmAssignOrg.isError && <p className="text-xs text-red-500">{confirmAssignOrg.error.message}</p>}
          </div>
          {/* 数字人格申请者 */}
          <div>
            <h3 className="mb-1 text-sm font-medium text-gray-700">{t('orgMarket.personaApplicants')}</h3>
            {(personaApplicants.data ?? []).length === 0 ? (
              <p className="text-xs text-gray-400">{t('orgMarket.noPersonaApplicants')}</p>
            ) : (
              <div className="space-y-2">
                {(personaApplicants.data ?? []).map((a) => (
                  <div key={a.id} className={`${card} flex items-center justify-between`}>
                    <span>🧠 {a.personaName ?? a.personaId} · {t('orgMarket.score')}: {a.rankingScore}</span>
                    <div className="flex items-center gap-2">
                      <span style={badge(STATUS_COLOR[a.status] ?? '#9ca3af')}>{a.status}</span>
                      {a.status === 'submitted' && (
                        <Button size="sm" onClick={() => assignPersona.mutate({ personaId: a.personaId })} disabled={assignPersona.isPending}>
                          {t('orgMarket.assignToPersona')}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {assignPersona.isError && <p className="text-xs text-red-500">{assignPersona.error.message}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
