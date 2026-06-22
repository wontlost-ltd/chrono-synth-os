/**
 * 数字员工组织可视化（企业控制台，只读）。
 *
 * 一次拉取 /visualization 聚合，画四块：
 *   ① 组织树（SVG 分层布局：按汇报深度分层，节点上色据负载/原型；无重型图库依赖）
 *   ② 目标 → 任务流（每目标任务状态分布堆叠条 + 卡点）
 *   ③ worker 信号仪表（负载/健康/人格置信度卡片）
 *   ④ ADR-0057 学习闭环（已学能力 / 进行中学习 / 挂起处置 gap/degraded/timeout 徽章）
 *
 * 确定性：聚合数据后端已确定性排序；前端布局纯函数（同数据同图）。
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useWorkforceViz,
  type OrgTreeNode, type OrgTreeEdge, type GoalFlowItem, type WorkerSignalItem, type LearningLoopItem,
} from '../api/queries/workforce';

/* 负载 → 节点配色（确定性）。 */
const LOAD_COLOR: Record<string, string> = { idle: '#9ca3af', normal: '#3b82f6', heavy: '#f97316' };
/* 任务状态 → 堆叠条配色。 */
const STATUS_COLOR: Record<string, string> = {
  draft: '#d1d5db', delegated: '#93c5fd', in_progress: '#60a5fa', submitted: '#34d399',
  approved: '#10b981', rejected: '#f87171', blocked: '#fb923c',
};
/* 处置 → 徽章配色。 */
const DISPOSITION_COLOR: Record<string, string> = { gap: '#fb923c', degraded: '#fbbf24', timeout: '#f87171' };

export default function WorkforceVisualization() {
  const { t } = useTranslation();
  useDocumentTitle(t('workforceViz.title'));
  const [orgId, setOrgId] = useState('');
  const [committedOrgId, setCommittedOrgId] = useState('');
  const viz = useWorkforceViz(committedOrgId);

  return (
    <div>
      <PageHeader title={t('workforceViz.title')} subtitle={t('workforceViz.subtitle')} />

      <div className="mb-6 flex items-end gap-2">
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-gray-600">{t('workforceViz.orgIdLabel')}</span>
          <input
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setCommittedOrgId(orgId.trim()); }}
            placeholder="org-1"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          onClick={() => setCommittedOrgId(orgId.trim())}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
        >
          {t('workforceViz.load')}
        </button>
      </div>

      {!committedOrgId ? (
        <EmptyState title={t('workforceViz.selectOrgTitle')} message={t('workforceViz.selectOrgMessage')} />
      ) : viz.error ? (
        <EmptyState variant="error" message={viz.error.message} />
      ) : viz.isLoading ? (
        <p className="text-sm text-gray-400">{t('workforceViz.loading')}</p>
      ) : !viz.data || viz.data.orgTree.nodes.length === 0 ? (
        <EmptyState title={t('workforceViz.noDataTitle')} message={t('workforceViz.noDataMessage')} />
      ) : (
        <div className="space-y-10">
          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('workforceViz.orgTreeSection')}</h2>
            <OrgTree nodes={viz.data.orgTree.nodes} edges={viz.data.orgTree.edges} />
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('workforceViz.goalFlowSection')}</h2>
            <GoalFlow goals={viz.data.goalFlow} t={t} />
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('workforceViz.signalsSection')}</h2>
            <SignalGrid signals={viz.data.signals} t={t} />
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold">{t('workforceViz.learningSection')}</h2>
            <LearningLoop items={viz.data.learningLoop} t={t} />
          </section>
        </div>
      )}
    </div>
  );
}

/* ── ① 组织树：按汇报深度分层布局（确定性纯函数）── */
function OrgTree({ nodes, edges }: { nodes: OrgTreeNode[]; edges: OrgTreeEdge[] }) {
  const layout = useMemo(() => computeTreeLayout(nodes, edges), [nodes, edges]);
  if (layout.positioned.length === 0) return null;
  const NODE_W = 150; const NODE_H = 56; const GAP_X = 30; const GAP_Y = 70;
  const width = layout.maxCol * (NODE_W + GAP_X) + GAP_X;
  const height = (layout.maxDepth + 1) * (NODE_H + GAP_Y) + GAP_Y;
  const posOf = new Map(layout.positioned.map((p) => [p.node.workerId, p]));

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white p-4">
      <svg width={width} height={height} role="img" aria-label="org-tree">
        {/* 汇报边 */}
        {edges.map((e) => {
          const a = posOf.get(e.from); const b = posOf.get(e.to);
          if (!a || !b) return null;
          const x1 = a.col * (NODE_W + GAP_X) + GAP_X + NODE_W / 2;
          const y1 = a.depth * (NODE_H + GAP_Y) + GAP_Y + NODE_H;
          const x2 = b.col * (NODE_W + GAP_X) + GAP_X + NODE_W / 2;
          const y2 = b.depth * (NODE_H + GAP_Y) + GAP_Y;
          return <path key={`${e.from}-${e.to}`} d={`M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`} stroke={e.edgeType === 'solid' ? '#9ca3af' : '#d1d5db'} strokeDasharray={e.edgeType === 'solid' ? undefined : '4'} fill="none" />;
        })}
        {/* 节点 */}
        {layout.positioned.map((p) => {
          const x = p.col * (NODE_W + GAP_X) + GAP_X;
          const y = p.depth * (NODE_H + GAP_Y) + GAP_Y;
          const color = LOAD_COLOR[p.node.load] ?? '#9ca3af';
          return (
            <g key={p.node.workerId}>
              <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={8} fill="#fff" stroke={color} strokeWidth={p.node.needsAttention ? 3 : 1.5} />
              {p.node.needsAttention && <circle cx={x + NODE_W - 10} cy={y + 10} r={4} fill="#ef4444" />}
              <text x={x + 10} y={y + 22} fontSize={13} fontWeight={600} fill="#111827">{truncate(p.node.displayName, 16)}</text>
              <text x={x + 10} y={y + 40} fontSize={11} fill="#6b7280">{p.node.roleCode || p.node.title}</text>
              <text x={x + NODE_W - 10} y={y + 40} fontSize={10} textAnchor="end" fill={color}>{p.node.activeTaskCount}★</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ── ② 目标流：状态分布堆叠条 ── */
function GoalFlow({ goals, t }: { goals: GoalFlowItem[]; t: (k: string) => string }) {
  if (goals.length === 0) return <EmptyState title={t('workforceViz.noGoalsTitle')} message={t('workforceViz.noGoalsMessage')} />;
  return (
    <div className="space-y-3">
      {goals.map((g) => {
        const total = Math.max(1, g.taskCount);
        return (
          <div key={g.goalId} className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">{g.title}</span>
              <span className="text-xs text-gray-400">{g.status} · {g.taskCount} {t('workforceViz.tasks')}{g.blockedCount > 0 ? ` · ⛔ ${g.blockedCount}` : ''}</span>
            </div>
            <div className="flex h-4 overflow-hidden rounded">
              {Object.entries(g.tasksByStatus).filter(([, n]) => n > 0).map(([status, n]) => (
                <div key={status} style={{ width: `${(n / total) * 100}%`, backgroundColor: STATUS_COLOR[status] ?? '#d1d5db' }} title={`${status}: ${n}`} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── ③ 信号仪表：worker 卡片（负载/健康/人格置信度）── */
function SignalGrid({ signals, t }: { signals: WorkerSignalItem[]; t: (k: string) => string }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {signals.map((s) => {
        const op = s.operating;
        const load = op?.load ?? 'idle';
        return (
          <div key={s.workerId} className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">{s.displayName}</span>
              <span className="rounded px-2 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: LOAD_COLOR[load] }}>{t(`workforceViz.load_${load}`)}</span>
            </div>
            {op ? (
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-gray-600">
                <dt>{t('workforceViz.active')}</dt><dd className="text-right">{op.activeTaskCount}</dd>
                <dt>{t('workforceViz.blocked')}</dt><dd className="text-right">{op.blockedTaskCount}</dd>
                <dt>{t('workforceViz.overdue')}</dt><dd className="text-right">{op.overdueTaskCount}</dd>
                <dt>{t('workforceViz.highRisk')}</dt><dd className="text-right">{op.highRiskTaskCount}</dd>
              </dl>
            ) : <p className="text-xs text-gray-400">—</p>}
            {s.persona && (
              <p className="mt-2 text-xs text-gray-500">
                {t('workforceViz.confidence')}: <span className="font-medium">{s.persona.decisionConfidence}</span>
                {' · '}{t('workforceViz.collab')}: {s.persona.collaborationReach}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── ④ 学习闭环：已学/在学/挂起处置徽章 ── */
function LearningLoop({ items, t }: { items: LearningLoopItem[]; t: (k: string) => string }) {
  const anyActivity = items.some((i) => i.learnedCapabilities.length > 0 || i.activeLearning.length > 0 || i.blockedTasks.length > 0);
  if (!anyActivity) return <EmptyState title={t('workforceViz.noLearningTitle')} message={t('workforceViz.noLearningMessage')} />;
  return (
    <div className="space-y-3">
      {items.filter((i) => i.learnedCapabilities.length > 0 || i.activeLearning.length > 0 || i.blockedTasks.length > 0).map((i) => (
        <div key={i.workerId} className="rounded-lg border border-gray-200 bg-white p-3">
          <div className="mb-2 font-medium">{i.displayName}</div>
          <div className="space-y-2 text-xs">
            {i.learnedCapabilities.length > 0 && (
              <div>
                <span className="mr-2 text-gray-500">{t('workforceViz.learned')}:</span>
                {i.learnedCapabilities.map((c) => (
                  <span key={c.capability} className="mr-1 inline-block rounded bg-emerald-100 px-2 py-0.5 text-emerald-700">{c.capability} ({Math.round(c.examScore * 100)})</span>
                ))}
              </div>
            )}
            {i.activeLearning.length > 0 && (
              <div>
                <span className="mr-2 text-gray-500">{t('workforceViz.learning')}:</span>
                {i.activeLearning.map((a) => (
                  <span key={a.capability} className="mr-1 inline-block rounded bg-blue-100 px-2 py-0.5 text-blue-700">{a.capability} · {a.status}</span>
                ))}
              </div>
            )}
            {i.blockedTasks.length > 0 && (
              <div>
                <span className="mr-2 text-gray-500">{t('workforceViz.blockedTasks')}:</span>
                {i.blockedTasks.map((b) => (
                  <span key={b.taskId} className="mr-1 inline-block rounded px-2 py-0.5 text-white" style={{ backgroundColor: DISPOSITION_COLOR[b.disposition] }}>
                    {b.title} · {t(`workforceViz.disp_${b.disposition}`)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── 布局/工具（纯函数，确定性）── */
interface PositionedNode { node: OrgTreeNode; depth: number; col: number; }
interface TreeLayout { positioned: PositionedNode[]; maxDepth: number; maxCol: number; }

/** 按汇报深度分层：root（无 manager）depth=0，其下属 depth+1；同层按节点顺序排列列。 */
function computeTreeLayout(nodes: OrgTreeNode[], edges: OrgTreeEdge[]): TreeLayout {
  /* report -> manager 映射（solid 优先，取首条）。 */
  const managerOf = new Map<string, string>();
  for (const e of edges) {
    if (!managerOf.has(e.to)) managerOf.set(e.to, e.from);
  }
  /* 计算每节点深度（向上追溯到 root；防环：上限 nodes.length）。 */
  const depthOf = new Map<string, number>();
  const idSet = new Set(nodes.map((n) => n.workerId));
  for (const n of nodes) {
    let d = 0; let cur = n.workerId; const seen = new Set<string>();
    while (managerOf.has(cur) && idSet.has(managerOf.get(cur)!) && !seen.has(cur) && d < nodes.length) {
      seen.add(cur); cur = managerOf.get(cur)!; d++;
    }
    depthOf.set(n.workerId, d);
  }
  /* 每层按 nodes 原序（后端已确定性排序）分配列。 */
  const colByDepth = new Map<number, number>();
  const positioned: PositionedNode[] = nodes.map((node) => {
    const depth = depthOf.get(node.workerId) ?? 0;
    const col = colByDepth.get(depth) ?? 0;
    colByDepth.set(depth, col + 1);
    return { node, depth, col };
  });
  const maxDepth = positioned.reduce((m, p) => Math.max(m, p.depth), 0);
  const maxCol = Math.max(1, ...Array.from(colByDepth.values()));
  return { positioned, maxDepth, maxCol };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
