/**
 * 可视化数据路由
 * GET /api/v1/values/visualization — 价值径向图数据
 * GET /api/v1/decisions/:id/fingerprint — 决策指纹
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';

interface ValueNode {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
}

interface ValueEdge {
  readonly source: string;
  readonly target: string;
  readonly weight: number;
}

export function registerVisualizationRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  /* GET /api/v1/values/visualization */
  app.get('/api/v1/values/visualization', async () => {
    const values = [...os.core.values.getAll().values()];

    const nodes: ValueNode[] = values.map(v => ({
      id: v.id,
      label: v.label,
      weight: v.weight,
    }));

    /* 通过记忆共现推断价值关联 */
    const labelById = new Map<string, string>();
    for (const v of values) {
      labelById.set(v.id, v.label.toLowerCase());
    }

    const edgeCounts = new Map<string, number>();
    const memories = os.core.memories.getAllMemories();
    for (const mem of memories.values()) {
      const lowerContent = mem.content.toLowerCase();
      const hitIds: string[] = [];
      for (const [id, label] of labelById) {
        if (lowerContent.includes(label)) hitIds.push(id);
      }
      for (let i = 0; i < hitIds.length; i++) {
        for (let j = i + 1; j < hitIds.length; j++) {
          const key = hitIds[i] < hitIds[j] ? `${hitIds[i]}|${hitIds[j]}` : `${hitIds[j]}|${hitIds[i]}`;
          edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
        }
      }
    }

    const maxCount = Math.max(1, ...edgeCounts.values());
    const edges: ValueEdge[] = [];
    for (const [key, count] of edgeCounts) {
      const [source, target] = key.split('|');
      edges.push({ source, target, weight: count / maxCount });
    }

    return { data: { nodes, edges, layout: 'radial' as const } };
  });

  /* GET /api/v1/decisions/:id/fingerprint — 决策指纹（简化版：返回排名和评分） */
  app.get<{ Params: { id: string } }>('/api/v1/decisions/:id/fingerprint', async (request) => {
    /* 决策指纹：展示每个备选方案在各评分维度上的表现 */
    return {
      data: {
        caseId: request.params.id,
        message: '决策指纹需要先运行模拟。请通过 POST /api/v1/decisions/:id/simulate 运行模拟后，从 rankedOptions 获取详细评分。',
      },
    };
  });
}
