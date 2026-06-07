/**
 * ChronoCompanion C 端记忆列表契约 — `GET /api/v1/companion/me/memories`（roadmap Phase 2.1）。
 *
 * 与 /me 的 recentMemories 共用单条形状 CompanionMemoryV1（同一内核数据），但这里是**分页浏览
 * 全部记忆**（/me 只给最近 N 条概览）。复用企业版 MemoryFacade.listMemories，C 端只保留陪伴所需
 * 字段——隐藏 unverified / sourceKind 等治理内部状态。
 */

import { z } from 'zod';
import { CompanionMemoryV1Schema } from './me.js';

/** 分页元信息（与后端 parsePagination/listMemories 输出对齐）。 */
export const CompanionPaginationV1Schema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
}).strict();

export const CompanionMemoryListV1Schema = z.object({
  schemaVersion: z.literal('companion-memory-list.v1'),
  items: z.array(CompanionMemoryV1Schema),
  pagination: CompanionPaginationV1Schema,
}).strict();

export type CompanionPaginationV1 = z.infer<typeof CompanionPaginationV1Schema>;
export type CompanionMemoryListV1 = z.infer<typeof CompanionMemoryListV1Schema>;
