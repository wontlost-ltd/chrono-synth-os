import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/layout/PageHeader';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Skeleton } from '../../../components/ui/Skeleton';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';
import { useOrgGoals, useGoalDetail, useOrgChart, type OrgTask } from '../../../api/queries/workforce';
import { TaskCollabPanel } from '../components/TaskCollabPanel';
import { OrgThreadsPanel } from '../components/OrgThreadsPanel';
import { StrategyAdvisorPanel } from '../components/StrategyAdvisorPanel';

/**
 * 数字员工组织协作控制台（B1 线程 / B2 交接 / B3 升级 / M7 战略）。全 admin-gated。
 *
 * 布局：orgId gate → 目标列表 → 选目标下钻任务（补 taskId 来源，这是 per-task 协作的硬前置）→ 选任务打开
 * per-task 三件套（升级/交接/线程）。org 级「讨论线程」+「战略辅助」作为独立 tab（不需要 taskId）。
 */

type Tab = 'tasks' | 'threads' | 'strategy';

export default function WorkforceCollabPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('collab.title'));
  const [orgIdInput, setOrgIdInput] = useState('');
  const [orgId, setOrgId] = useState('');
  const [tab, setTab] = useState<Tab>('tasks');

  return (
    <>
      <PageHeader title={t('collab.title')} subtitle={t('collab.subtitle')} />
      <p className="mb-4 text-xs text-text-secondary">{t('collab.adminHint')}</p>

      <div className="mb-6 flex items-end gap-2">
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-text-secondary">{t('collab.orgIdLabel')}</span>
          <input
            value={orgIdInput}
            onChange={e => setOrgIdInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') setOrgId(orgIdInput.trim()); }}
            placeholder={t('collab.orgIdPlaceholder')}
            className="rounded-lg border border-border px-3 py-2 text-sm"
          />
        </label>
        <button onClick={() => setOrgId(orgIdInput.trim())} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
          {t('collab.load')}
        </button>
      </div>

      {!orgId ? (
        <EmptyState title={t('collab.selectOrgTitle')} message={t('collab.selectOrgMessage')} />
      ) : (
        <>
          <div role="tablist" className="mb-6 flex gap-1 border-b border-border">
            {(['tasks', 'threads', 'strategy'] as Tab[]).map(k => (
              <button
                key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`px-4 py-2 text-sm font-medium ${tab === k ? 'border-b-2 border-primary text-text-primary' : 'text-text-secondary'}`}
              >
                {t(`collab.tab.${k}`)}
              </button>
            ))}
          </div>

          {tab === 'tasks' && <TaskDrillDown orgId={orgId} />}
          {tab === 'threads' && <OrgThreadsPanel orgId={orgId} />}
          {tab === 'strategy' && <StrategyAdvisorPanel orgId={orgId} />}
        </>
      )}
    </>
  );
}

/** 目标→任务下钻：选目标看其任务，选任务打开 per-task 协作面板（升级/交接/线程）。 */
function TaskDrillDown({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const goals = useOrgGoals(orgId);
  const chart = useOrgChart(orgId);
  const [goalId, setGoalId] = useState('');
  const [task, setTask] = useState<OrgTask | null>(null);

  const detail = useGoalDetail(orgId, goalId);
  const workerNames = new Map((chart.data?.workers ?? []).map(w => [w.id, w.displayName]));

  return (
    <div className="space-y-6">
      {/* 目标选择 */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-text-secondary">{t('collab.goalsHeading')}</h2>
        {goals.isLoading ? (
          <Skeleton variant="table" />
        ) : goals.error ? (
          <p role="alert" className="text-sm text-error">{goals.error.message}</p>
        ) : !goals.data?.length ? (
          <EmptyState title={t('collab.noGoals')} message={t('collab.noGoalsHint')} />
        ) : (
          <select value={goalId} onChange={e => { setGoalId(e.target.value); setTask(null); }} className="rounded-lg border border-border px-3 py-2 text-sm">
            <option value="">{t('collab.selectGoal')}</option>
            {goals.data.map(g => <option key={g.id} value={g.id}>{g.title}（{g.status}）</option>)}
          </select>
        )}
      </section>

      {/* 任务下钻 */}
      {goalId && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-text-secondary">{t('collab.tasksHeading')}</h2>
          {detail.isLoading ? (
            <Skeleton variant="table" />
          ) : detail.error ? (
            <p role="alert" className="text-sm text-error">{detail.error.message}</p>
          ) : !detail.data?.tasks.length ? (
            <EmptyState title={t('collab.noTasks')} message={t('collab.noTasksHint')} />
          ) : (
            <ul className="space-y-2">
              {detail.data.tasks.map(tk => (
                <li key={tk.id}>
                  <button
                    onClick={() => setTask(tk)}
                    className={`w-full rounded-lg border p-3 text-left text-sm transition-colors ${task?.id === tk.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-neutral-1'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-text-primary">{tk.title}</span>
                      <span className="text-xs text-text-secondary">{t(`collab.taskStatus.${tk.status}`, tk.status)}</span>
                    </div>
                    <div className="mt-1 text-xs text-text-secondary">
                      {tk.assignedToWorkerId ? (workerNames.get(tk.assignedToWorkerId) ?? tk.assignedToWorkerId) : t('collab.unassigned')}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* per-task 协作面板 */}
      {task && <TaskCollabPanel orgId={orgId} task={task} workerNames={workerNames} />}
    </div>
  );
}
