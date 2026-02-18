/**
 * 人生模拟可视化 API 路由
 * 5 个聚合端点：overview / paths / branches / stress-comparison / milestones
 */

import type { FastifyInstance } from 'fastify';
import type { LifeSimulationService } from '../../simulation/life-simulation-service.js';
import type { YearState, BranchResult } from '../../types/life-simulation.js';
import { NotFoundError, StateError, ErrorCode } from '../../errors/index.js';
import { VisualizationQuerySchema } from '../schemas/visualization-schemas.js';
import {
  parseMetrics,
  resolutionStep,
  pickMetrics,
  downsampleTimeline,
  computeStats,
  extractMilestones,
  computePivotYear,
  METRIC_META,
  type MetricKey,
  type Resolution,
} from '../../simulation/visualization-helpers.js';

function safeJsonParse(json: string | null | undefined, fallback: unknown = null): unknown {
  if (!json) return fallback;
  try { return JSON.parse(json); }
  catch { return fallback; }
}

/** 为请求的指标构建元数据列表 */
function buildMetricMeta(metrics: MetricKey[]) {
  return metrics.map(k => METRIC_META.get(k)).filter(Boolean);
}

export function registerLifeSimVizRoutes(
  app: FastifyInstance,
  service: LifeSimulationService,
): void {

  /* ── 端点 1: 仪表盘概览 ── */
  app.get<{ Params: { id: string } }>(
    '/api/v1/simulations/:id/visualization/overview',
    async (request) => {
      const { id } = request.params;
      const tenantId = request.tenantId;
      const record = service.getStatus(id, tenantId);
      if (!record) {
        throw new NotFoundError(`模拟 ${id} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      }
      if (record.status !== 'completed') {
        throw new StateError('模拟尚未完成', ErrorCode.STATE_INVALID_TRANSITION);
      }
      if (!record.summaryJson) {
        throw new StateError('模拟摘要缺失', ErrorCode.STATE_INVALID_TRANSITION);
      }

      const summary = safeJsonParse(record.summaryJson, {}) as Record<string, unknown>;
      return {
        data: {
          simulationId: record.id,
          status: 'completed' as const,
          recommendedPathId: summary.recommendedPathId,
          retrospective: summary.retrospective,
          paths: summary.paths,
          meta: {
            horizonYears: (safeJsonParse(record.configJson, {}) as Record<string, unknown>).horizonYears,
            baseSimulationId: record.baseSimulationId,
            completedAt: record.completedAt,
          },
        },
      };
    },
  );

  /* ── 端点 2: 多路径时间序列对比 ── */
  app.get<{ Params: { id: string }; Querystring: { metrics?: string; resolution?: string } }>(
    '/api/v1/simulations/:id/visualization/paths',
    async (request) => {
      const { id } = request.params;
      const tenantId = request.tenantId;
      const record = service.getStatus(id, tenantId);
      if (!record) {
        throw new NotFoundError(`模拟 ${id} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      }
      if (record.status !== 'completed') {
        throw new StateError('模拟尚未完成', ErrorCode.STATE_INVALID_TRANSITION);
      }

      const q = VisualizationQuerySchema.parse(request.query);
      const metrics = parseMetrics(q.metrics);
      const step = resolutionStep(q.resolution as Resolution);
      const pathRecords = service.getPathsBySimulation(id);

      const series = pathRecords.map(pr => {
        const timeline: YearState[] = (safeJsonParse(pr.timelineJson, []) as YearState[]);
        const points = downsampleTimeline(timeline, metrics, step);
        const stats = computeStats(points, metrics);
        return { pathId: pr.pathId, label: pr.label, points, stats };
      });

      return {
        data: {
          simulationId: id,
          metrics,
          metricMeta: buildMetricMeta(metrics),
          resolution: q.resolution as Resolution,
          series,
        },
      };
    },
  );

  /* ── 端点 3: 分支概率结构 ── */
  app.get<{ Params: { id: string; pathId: string }; Querystring: { metrics?: string; resolution?: string } }>(
    '/api/v1/simulations/:id/visualization/branches/:pathId',
    async (request) => {
      const { id, pathId } = request.params;
      const tenantId = request.tenantId;

      const simRecord = service.getStatus(id, tenantId);
      if (!simRecord) {
        throw new NotFoundError(`模拟 ${id} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      }
      if (simRecord.status !== 'completed') {
        throw new StateError('模拟尚未完成', ErrorCode.STATE_INVALID_TRANSITION);
      }

      const pathRecord = service.getPathDetail(id, pathId, tenantId);
      if (!pathRecord) {
        throw new NotFoundError(`路径 ${pathId} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      }

      const q = VisualizationQuerySchema.parse(request.query);
      const metrics = parseMetrics(q.metrics);
      const step = resolutionStep(q.resolution as Resolution);

      const config = safeJsonParse(simRecord.configJson, {}) as Record<string, unknown>;
      const horizonYears: number = (config.horizonYears as number) ?? 10;
      const mainTimeline: YearState[] = (safeJsonParse(pathRecord.timelineJson, []) as YearState[]);
      const branchResults: BranchResult[] = (safeJsonParse(pathRecord.branchesJson, []) as BranchResult[]);

      const maxBranchLength = branchResults.reduce((max, br) => Math.max(max, br.timeline.length), 0);
      const pivotYear = maxBranchLength > 0
        ? Math.min(computePivotYear(horizonYears, maxBranchLength), mainTimeline.length || horizonYears)
        : horizonYears;

      const baseTimeline = downsampleTimeline(mainTimeline.slice(0, pivotYear), metrics, step);

      const branches = branchResults.map(br => ({
        label: br.label,
        probability: br.probability,
        compositeScore: br.compositeScore,
        points: downsampleTimeline(br.timeline, metrics, step),
      }));

      /* 构建 graph 结构 */
      const nodes: Array<{ id: string; label: string; year: number; kind: 'root' | 'pivot' | 'branch_end' }> = [
        { id: 'root', label: pathRecord.label, year: 1, kind: 'root' },
        { id: 'pivot', label: `分支点 Y${pivotYear}`, year: pivotYear, kind: 'pivot' },
      ];
      const edges: Array<{ source: string; target: string; value: number; probability?: number }> = [
        { source: 'root', target: 'pivot', value: 1 },
      ];
      branchResults.forEach((br, i) => {
        const nodeId = `branch_${i}`;
        nodes.push({ id: nodeId, label: br.label, year: horizonYears, kind: 'branch_end' });
        edges.push({ source: 'pivot', target: nodeId, value: br.probability, probability: br.probability });
      });

      return {
        data: {
          simulationId: id,
          pathId,
          label: pathRecord.label,
          horizonYears,
          pivotYear,
          baseTimeline,
          branches,
          graph: { nodes, edges },
        },
      };
    },
  );

  /* ── 端点 4: 压力测试变体差分 ── */
  app.get<{ Params: { id: string } }>(
    '/api/v1/simulations/:id/visualization/stress-comparison',
    async (request) => {
      const { id } = request.params;
      const tenantId = request.tenantId;

      const baseRecord = service.getStatus(id, tenantId);
      if (!baseRecord) {
        throw new NotFoundError(`模拟 ${id} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      }
      if (baseRecord.status !== 'completed') {
        throw new StateError('模拟尚未完成', ErrorCode.STATE_INVALID_TRANSITION);
      }
      if (!baseRecord.summaryJson) {
        throw new StateError('模拟摘要缺失', ErrorCode.STATE_INVALID_TRANSITION);
      }

      const baseSummary = safeJsonParse(baseRecord.summaryJson, { paths: [] }) as Record<string, unknown>;
      const variantRecords = service.getVariants(id, tenantId);

      const basePathMap = new Map<string, { compositeScore: number; regretProbability: number }>();
      for (const p of (baseSummary.paths as Array<{ pathId: string; compositeScore: number; regretProbability: number }>)) {
        basePathMap.set(p.pathId, p);
      }

      const variants = variantRecords
        .filter(v => v.status === 'completed' && v.summaryJson)
        .map(v => {
          const vSummary = safeJsonParse(v.summaryJson, { paths: [], recommendedPathId: null }) as Record<string, unknown>;

          const deltas = (vSummary.paths as Array<{ pathId: string; compositeScore: number; regretProbability: number }>)
            .map(vp => {
              const bp = basePathMap.get(vp.pathId);
              return {
                pathId: vp.pathId,
                compositeScoreDelta: bp ? vp.compositeScore - bp.compositeScore : 0,
                regretProbabilityDelta: bp ? vp.regretProbability - bp.regretProbability : 0,
              };
            });

          return {
            simulationId: v.id,
            status: v.status,
            summary: { recommendedPathId: vSummary.recommendedPathId, paths: vSummary.paths },
            deltas,
          };
        });

      return {
        data: {
          baseSimulationId: id,
          baseSummary: { recommendedPathId: baseSummary.recommendedPathId, paths: baseSummary.paths },
          variants,
        },
      };
    },
  );

  /* ── 端点 5: 里程碑聚合 ── */
  app.get<{ Params: { id: string }; Querystring: { metrics?: string; resolution?: string } }>(
    '/api/v1/simulations/:id/visualization/milestones',
    async (request) => {
      const { id } = request.params;
      const tenantId = request.tenantId;

      const record = service.getStatus(id, tenantId);
      if (!record) {
        throw new NotFoundError(`模拟 ${id} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      }
      if (record.status !== 'completed') {
        throw new StateError('模拟尚未完成', ErrorCode.STATE_INVALID_TRANSITION);
      }

      const q = VisualizationQuerySchema.parse(request.query);
      const metrics = parseMetrics(q.metrics);
      const pathRecords = service.getPathsBySimulation(id);

      const milestones = pathRecords.map(pr => {
        const timeline: YearState[] = (safeJsonParse(pr.timelineJson, []) as YearState[]);
        const events = extractMilestones(timeline, metrics);

        const startSnapshot: Partial<Record<MetricKey, number>> = timeline.length > 0
          ? pickMetrics(timeline[0], metrics)
          : {};
        const endSnapshot: Partial<Record<MetricKey, number>> = timeline.length > 0
          ? pickMetrics(timeline[timeline.length - 1], metrics)
          : {};

        return {
          pathId: pr.pathId,
          label: pr.label,
          events,
          summary: { startSnapshot, endSnapshot },
        };
      });

      return {
        data: {
          simulationId: id,
          metrics,
          metricMeta: buildMetricMeta(metrics),
          milestones,
        },
      };
    },
  );
}
