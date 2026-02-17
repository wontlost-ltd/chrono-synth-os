/**
 * 可视化端点查询参数 Zod Schema
 */

import { z } from 'zod';

export const VisualizationQuerySchema = z.object({
  metrics: z.string().optional(),
  resolution: z.enum(['year', '2y', '5y']).default('year'),
});
