/**
 * 记忆图 Query/Command kind 常量与工厂
 */

import type { Query, Command } from '../../ports/query.js';
import type { MemoryNode, MemoryEdge, WorkingMemorySlot } from './memory-types.js';

/* ── Memory Node Queries ── */

export const MEM_QUERY_BY_ID = 'memory.get-by-id' as const;
export const MEM_QUERY_ALL = 'memory.get-all' as const;
export const MEM_QUERY_BATCH = 'memory.get-batch' as const;
export const MEM_QUERY_PAGINATED = 'memory.get-paginated' as const;
export const MEM_QUERY_COUNT = 'memory.count' as const;
export const MEM_QUERY_CONSOLIDATION_CANDIDATES = 'memory.consolidation-candidates' as const;
export const MEM_QUERY_CONSOLIDATED_FROM = 'memory.consolidated-from' as const;
export const MEM_QUERY_LOWEST_SALIENCE = 'memory.lowest-salience' as const;

/* ── Memory Node Commands ── */

export const MEM_CMD_INSERT = 'memory.insert' as const;
export const MEM_CMD_UPSERT = 'memory.upsert' as const;
export const MEM_CMD_UPDATE_ACCESS = 'memory.update-access' as const;
export const MEM_CMD_UPDATE_SALIENCE = 'memory.update-salience' as const;
export const MEM_CMD_UPDATE_SALIENCE_DELTA = 'memory.update-salience-delta' as const;
export const MEM_CMD_DELETE = 'memory.delete' as const;
export const MEM_CMD_DELETE_ALL = 'memory.delete-all' as const;

/* ── Edge Queries ── */

export const MEM_EDGE_QUERY_ALL = 'memory.edge-get-all' as const;
export const MEM_EDGE_QUERY_FOR_NODE = 'memory.edge-get-for-node' as const;
export const MEM_EDGE_QUERY_FOR_NODES = 'memory.edge-get-for-nodes' as const;

/* ── Edge Commands ── */

export const MEM_EDGE_CMD_UPSERT = 'memory.edge-upsert' as const;
export const MEM_EDGE_CMD_DELETE_FOR_NODE = 'memory.edge-delete-for-node' as const;
export const MEM_EDGE_CMD_DELETE_ALL = 'memory.edge-delete-all' as const;

/* ── Working Memory Queries ── */

export const MEM_WM_QUERY_SLOTS = 'memory.wm-slots' as const;
export const MEM_WM_QUERY_BY_ID = 'memory.wm-by-id' as const;
export const MEM_WM_QUERY_COUNT = 'memory.wm-count' as const;
export const MEM_WM_QUERY_LOWEST = 'memory.wm-lowest' as const;
export const MEM_WM_QUERY_ALL_RAW = 'memory.wm-all-raw' as const;

/* ── Working Memory Commands ── */

export const MEM_WM_CMD_INSERT = 'memory.wm-insert' as const;
export const MEM_WM_CMD_UPDATE_SCORE = 'memory.wm-update-score' as const;
export const MEM_WM_CMD_DELETE = 'memory.wm-delete' as const;
export const MEM_WM_CMD_DELETE_ALL = 'memory.wm-delete-all' as const;

/* ── Param Types ── */

export interface MemInsertParams {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly valence: number;
  readonly salience: number;
  readonly createdAt: number;
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  readonly decayLambda: number;
  readonly lastDecayedAt: number;
  readonly consolidatedFrom: string | null;
}

export interface MemUpdateAccessParams {
  readonly id: string;
  readonly salience: number;
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  readonly decayLambda: number;
  readonly lastDecayedAt: number;
}

export interface MemUpdateSalienceParams {
  readonly id: string;
  readonly salience: number;
  readonly lastDecayedAt: number;
}

export interface MemUpdateSalienceDeltaParams {
  readonly id: string;
  readonly delta: number;
}

export interface MemPaginatedParams {
  readonly limit: number;
  readonly offset: number;
}

export interface MemConsolidationCandidatesParams {
  readonly accessThreshold: number;
  readonly minSalience: number;
}

export interface MemPaginatedResult {
  readonly nodes: MemoryNode[];
  readonly total: number;
}

export interface MemEdgeUpsertParams {
  readonly source: string;
  readonly target: string;
  readonly strength: number;
  readonly relation: string;
}

export interface MemWmInsertParams {
  readonly memoryId: string;
  readonly score: number;
  readonly enteredAt: number;
}

/* ── Factory Functions ── */

export function memById(id: string): Query<MemoryNode | null, { id: string }> {
  return { kind: MEM_QUERY_BY_ID, params: { id } };
}

export function memAll(): Query<MemoryNode, void> {
  return { kind: MEM_QUERY_ALL, params: undefined };
}

export function memBatch(ids: string[]): Query<MemoryNode, { ids: string[] }> {
  return { kind: MEM_QUERY_BATCH, params: { ids } };
}

export function memPaginated(limit: number, offset: number): Query<MemPaginatedResult, MemPaginatedParams> {
  return { kind: MEM_QUERY_PAGINATED, params: { limit, offset } };
}

export function memCount(): Query<number, void> {
  return { kind: MEM_QUERY_COUNT, params: undefined };
}

export function memConsolidationCandidates(params: MemConsolidationCandidatesParams): Query<string, MemConsolidationCandidatesParams> {
  return { kind: MEM_QUERY_CONSOLIDATION_CANDIDATES, params };
}

export function memConsolidatedFrom(id: string): Query<string | null, { id: string }> {
  return { kind: MEM_QUERY_CONSOLIDATED_FROM, params: { id } };
}

export function memLowestSalience(limit: number): Query<{ id: string; salience: number }, { limit: number }> {
  return { kind: MEM_QUERY_LOWEST_SALIENCE, params: { limit } };
}

export function memInsertCmd(params: MemInsertParams): Command<MemInsertParams> {
  return { kind: MEM_CMD_INSERT, params };
}

export function memUpsertCmd(params: MemInsertParams): Command<MemInsertParams> {
  return { kind: MEM_CMD_UPSERT, params };
}

export function memUpdateAccessCmd(params: MemUpdateAccessParams): Command<MemUpdateAccessParams> {
  return { kind: MEM_CMD_UPDATE_ACCESS, params };
}

export function memUpdateSalienceCmd(params: MemUpdateSalienceParams): Command<MemUpdateSalienceParams> {
  return { kind: MEM_CMD_UPDATE_SALIENCE, params };
}

export function memUpdateSalienceDeltaCmd(params: MemUpdateSalienceDeltaParams): Command<MemUpdateSalienceDeltaParams> {
  return { kind: MEM_CMD_UPDATE_SALIENCE_DELTA, params };
}

export function memDeleteCmd(id: string): Command<{ id: string }> {
  return { kind: MEM_CMD_DELETE, params: { id } };
}

export function memDeleteAllCmd(): Command<void> {
  return { kind: MEM_CMD_DELETE_ALL, params: undefined };
}

export function memEdgeAll(): Query<MemoryEdge, void> {
  return { kind: MEM_EDGE_QUERY_ALL, params: undefined };
}

export function memEdgesForNode(id: string): Query<MemoryEdge, { id: string }> {
  return { kind: MEM_EDGE_QUERY_FOR_NODE, params: { id } };
}

export function memEdgesForNodes(ids: string[]): Query<MemoryEdge, { ids: string[] }> {
  return { kind: MEM_EDGE_QUERY_FOR_NODES, params: { ids } };
}

export function memEdgeUpsertCmd(params: MemEdgeUpsertParams): Command<MemEdgeUpsertParams> {
  return { kind: MEM_EDGE_CMD_UPSERT, params };
}

export function memEdgeDeleteForNodeCmd(id: string): Command<{ id: string }> {
  return { kind: MEM_EDGE_CMD_DELETE_FOR_NODE, params: { id } };
}

export function memEdgeDeleteAllCmd(): Command<void> {
  return { kind: MEM_EDGE_CMD_DELETE_ALL, params: undefined };
}

export function memWmSlots(): Query<WorkingMemorySlot, void> {
  return { kind: MEM_WM_QUERY_SLOTS, params: undefined };
}

export function memWmById(memoryId: string): Query<WorkingMemorySlot | null, { memoryId: string }> {
  return { kind: MEM_WM_QUERY_BY_ID, params: { memoryId } };
}

export function memWmCount(): Query<number, void> {
  return { kind: MEM_WM_QUERY_COUNT, params: undefined };
}

export function memWmLowest(): Query<WorkingMemorySlot | null, void> {
  return { kind: MEM_WM_QUERY_LOWEST, params: undefined };
}

export function memWmAllRaw(): Query<WorkingMemorySlot, void> {
  return { kind: MEM_WM_QUERY_ALL_RAW, params: undefined };
}

export function memWmInsertCmd(params: MemWmInsertParams): Command<MemWmInsertParams> {
  return { kind: MEM_WM_CMD_INSERT, params };
}

export function memWmUpdateScoreCmd(memoryId: string, score: number): Command<{ memoryId: string; score: number }> {
  return { kind: MEM_WM_CMD_UPDATE_SCORE, params: { memoryId, score } };
}

export function memWmDeleteCmd(memoryId: string): Command<{ memoryId: string }> {
  return { kind: MEM_WM_CMD_DELETE, params: { memoryId } };
}

export function memWmDeleteAllCmd(): Command<void> {
  return { kind: MEM_WM_CMD_DELETE_ALL, params: undefined };
}
