import { useState } from 'react';
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
 * 负载/是否需关注）+ 目标列表。全部只读（不发起委派/执行；写操作留 E3）。
 */
export default function WorkforceConsole() {
  useDocumentTitle('数字员工组织');
  const [orgId, setOrgId] = useState('');
  const [committedOrgId, setCommittedOrgId] = useState('');

  const chart = useOrgChart(committedOrgId);
  const goals = useOrgGoals(committedOrgId);

  /* positionId → 岗位（title + roleCode），让员工行能显示岗位而非只有名字。 */
  const positionById = new Map((chart.data?.positions ?? []).map(p => [p.id, p]));

  const workerColumns: Column<DigitalWorker>[] = [
    { id: 'name', header: '数字员工', cell: r => <span className="font-medium">{r.displayName}</span> },
    {
      id: 'position', header: '岗位', cell: r => {
        const pos = positionById.get(r.positionId);
        return pos ? <span className="text-sm">{pos.title}<span className="ml-1 text-xs text-gray-400">{pos.roleCode}</span></span> : <span className="text-xs text-gray-400">—</span>;
      },
    },
    { id: 'status', header: '状态', cell: r => <StatusBadge status={r.employmentStatus === 'active' ? 'active' : 'paused'} label={r.employmentStatus} /> },
    { id: 'signal', header: '运营人格信号', cell: r => <WorkerSignalCell orgId={committedOrgId} workerId={r.id} /> },
  ];

  const goalColumns: Column<OrgGoal>[] = [
    { id: 'title', header: '目标', cell: r => <span className="font-medium">{r.title}</span> },
    { id: 'type', header: '类型', cell: r => <span className="text-sm text-gray-500">{r.goalType}</span> },
    { id: 'status', header: '状态', cell: r => <StatusBadge status={r.status === 'completed' ? 'completed' : 'active'} label={r.status} /> },
  ];

  return (
    <>
      <PageHeader title="数字员工组织" subtitle="查看你的数字员工在干嘛：组织结构、运营信号、目标进展（只读）" />

      <div className="mb-6 flex items-end gap-2">
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-gray-600">组织 ID</span>
          <input
            value={orgId}
            onChange={e => setOrgId(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') setCommittedOrgId(orgId.trim()); }}
            placeholder="输入组织 ID"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          onClick={() => setCommittedOrgId(orgId.trim())}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
        >
          查看
        </button>
      </div>

      {!committedOrgId ? (
        <EmptyState title="选择一个组织" message="输入组织 ID 查看其数字员工组织" />
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-lg font-semibold">数字员工</h2>
            {chart.error ? (
              <EmptyState variant="error" message={chart.error.message} />
            ) : (
              <DataTable
                rows={chart.data?.workers ?? []}
                columns={workerColumns}
                getRowId={r => r.id}
                loading={chart.isLoading}
                emptyState={<EmptyState title="无数字员工" message="该组织还没有数字员工" />}
              />
            )}
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold">目标</h2>
            {goals.error ? (
              <EmptyState variant="error" message={goals.error.message} />
            ) : (
              <DataTable
                rows={goals.data ?? []}
                columns={goalColumns}
                getRowId={r => r.id}
                loading={goals.isLoading}
                emptyState={<EmptyState title="无目标" message="该组织还没有目标" />}
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
  const { data, isLoading, error } = useWorkerPersonaSignal(orgId, workerId);
  if (isLoading) return <span className="text-xs text-gray-400">加载中…</span>;
  if (error || !data) return <span className="text-xs text-gray-400">—</span>;

  const confidenceColor =
    data.decisionConfidence === 'high' ? 'text-green-600'
      : data.decisionConfidence === 'low' ? 'text-red-600'
        : 'text-amber-600';

  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <span>
        决策置信度：<span className={`font-medium ${confidenceColor}`}>{data.decisionConfidence}</span>
        <span className="ml-2 text-gray-500">负载 {data.operating.load}</span>
        <span className="ml-2 text-gray-500">协作 {data.collaborationReach}</span>
      </span>
      {data.shouldReport && <span className="font-medium text-red-600">⚠ 需关注：{data.confidenceRationale}</span>}
    </div>
  );
}
