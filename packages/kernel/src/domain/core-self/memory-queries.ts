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

/* ── Param Types（ADR-0056 K5b：memory 按 (tenant, persona) 隔离；tenant_id 由宿主 rewriter 注入，
 * persona_id 必须显式线程到 executor。working_memory 表本身没有 persona_id，仍通过 personaId 限定所属节点范围。） ── */

export interface MemByIdParams {
  readonly id: string;
  readonly personaId: string;
}

export interface MemAllParams {
  readonly personaId: string;
}

export interface MemBatchParams {
  readonly ids: string[];
  readonly personaId: string;
}

export interface MemInsertParams {
  readonly id: string;
  readonly personaId: string;
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
  readonly personaId: string;
  readonly salience: number;
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  readonly decayLambda: number;
  readonly lastDecayedAt: number;
}

export interface MemUpdateSalienceParams {
  readonly id: string;
  readonly personaId: string;
  readonly salience: number;
  readonly lastDecayedAt: number;
}

export interface MemUpdateSalienceDeltaParams {
  readonly id: string;
  readonly personaId: string;
  readonly delta: number;
}

export interface MemPaginatedParams {
  readonly personaId: string;
  readonly limit: number;
  readonly offset: number;
}

export interface MemCountParams {
  readonly personaId: string;
}

export interface MemConsolidationCandidatesParams {
  readonly personaId: string;
  readonly accessThreshold: number;
  readonly minSalience: number;
}

export interface MemConsolidatedFromParams {
  readonly id: string;
  readonly personaId: string;
}

export interface MemLowestSalienceParams {
  readonly limit: number;
  readonly personaId: string;
}

export interface MemPaginatedResult {
  readonly nodes: MemoryNode[];
  readonly total: number;
}

export interface MemEdgeUpsertParams {
  readonly personaId: string;
  readonly source: string;
  readonly target: string;
  readonly strength: number;
  readonly relation: string;
}

export interface MemEdgeAllParams {
  readonly personaId: string;
}

export interface MemEdgeForNodeParams {
  readonly id: string;
  readonly personaId: string;
}

export interface MemEdgeForNodesParams {
  readonly ids: string[];
  readonly personaId: string;
}

export interface MemEdgeDeleteForNodeParams {
  readonly id: string;
  readonly personaId: string;
}

export interface MemEdgeDeleteAllParams {
  readonly personaId: string;
}

export interface MemWmInsertParams {
  readonly personaId: string;
  readonly memoryId: string;
  readonly score: number;
  readonly enteredAt: number;
}

export interface MemWmByIdParams {
  readonly memoryId: string;
  readonly personaId: string;
}

export interface MemWmAllParams {
  readonly personaId: string;
}

export interface MemWmUpdateScoreParams {
  readonly memoryId: string;
  readonly personaId: string;
  readonly score: number;
}

export interface MemWmDeleteParams {
  readonly memoryId: string;
  readonly personaId: string;
}

export interface MemWmDeleteAllParams {
  readonly personaId: string;
}

/* ── Factory Functions ── */

export function memById(id: string, personaId = 'default'): Query<MemoryNode | null, MemByIdParams> {
  return { kind: MEM_QUERY_BY_ID, params: { id, personaId } };
}

export function memAll(personaId = 'default'): Query<MemoryNode, MemAllParams> {
  return { kind: MEM_QUERY_ALL, params: { personaId } };
}

export function memBatch(ids: string[], personaId = 'default'): Query<MemoryNode, MemBatchParams> {
  return { kind: MEM_QUERY_BATCH, params: { ids, personaId } };
}

export function memPaginated(limit: number, offset: number, personaId = 'default'): Query<MemPaginatedResult, MemPaginatedParams> {
  return { kind: MEM_QUERY_PAGINATED, params: { limit, offset, personaId } };
}

export function memCount(personaId = 'default'): Query<number, MemCountParams> {
  return { kind: MEM_QUERY_COUNT, params: { personaId } };
}

export function memConsolidationCandidates(params: MemConsolidationCandidatesParams): Query<string, MemConsolidationCandidatesParams> {
  return { kind: MEM_QUERY_CONSOLIDATION_CANDIDATES, params };
}

export function memConsolidatedFrom(id: string, personaId = 'default'): Query<string | null, MemConsolidatedFromParams> {
  return { kind: MEM_QUERY_CONSOLIDATED_FROM, params: { id, personaId } };
}

export function memLowestSalience(limit: number, personaId = 'default'): Query<{ id: string; salience: number }, MemLowestSalienceParams> {
  return { kind: MEM_QUERY_LOWEST_SALIENCE, params: { limit, personaId } };
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

export function memDeleteCmd(id: string, personaId = 'default'): Command<MemByIdParams> {
  return { kind: MEM_CMD_DELETE, params: { id, personaId } };
}

export function memDeleteAllCmd(personaId = 'default'): Command<MemAllParams> {
  return { kind: MEM_CMD_DELETE_ALL, params: { personaId } };
}

export function memEdgeAll(personaId = 'default'): Query<MemoryEdge, MemEdgeAllParams> {
  return { kind: MEM_EDGE_QUERY_ALL, params: { personaId } };
}

export function memEdgesForNode(id: string, personaId = 'default'): Query<MemoryEdge, MemEdgeForNodeParams> {
  return { kind: MEM_EDGE_QUERY_FOR_NODE, params: { id, personaId } };
}

export function memEdgesForNodes(ids: string[], personaId = 'default'): Query<MemoryEdge, MemEdgeForNodesParams> {
  return { kind: MEM_EDGE_QUERY_FOR_NODES, params: { ids, personaId } };
}

export function memEdgeUpsertCmd(params: MemEdgeUpsertParams): Command<MemEdgeUpsertParams> {
  return { kind: MEM_EDGE_CMD_UPSERT, params };
}

export function memEdgeDeleteForNodeCmd(id: string, personaId = 'default'): Command<MemEdgeDeleteForNodeParams> {
  return { kind: MEM_EDGE_CMD_DELETE_FOR_NODE, params: { id, personaId } };
}

export function memEdgeDeleteAllCmd(personaId = 'default'): Command<MemEdgeDeleteAllParams> {
  return { kind: MEM_EDGE_CMD_DELETE_ALL, params: { personaId } };
}

export function memWmSlots(personaId = 'default'): Query<WorkingMemorySlot, MemWmAllParams> {
  return { kind: MEM_WM_QUERY_SLOTS, params: { personaId } };
}

export function memWmById(memoryId: string, personaId = 'default'): Query<WorkingMemorySlot | null, MemWmByIdParams> {
  return { kind: MEM_WM_QUERY_BY_ID, params: { memoryId, personaId } };
}

export function memWmCount(personaId = 'default'): Query<number, MemWmAllParams> {
  return { kind: MEM_WM_QUERY_COUNT, params: { personaId } };
}

export function memWmLowest(personaId = 'default'): Query<WorkingMemorySlot | null, MemWmAllParams> {
  return { kind: MEM_WM_QUERY_LOWEST, params: { personaId } };
}

export function memWmAllRaw(personaId = 'default'): Query<WorkingMemorySlot, MemWmAllParams> {
  return { kind: MEM_WM_QUERY_ALL_RAW, params: { personaId } };
}

export function memWmInsertCmd(params: MemWmInsertParams): Command<MemWmInsertParams> {
  return { kind: MEM_WM_CMD_INSERT, params };
}

export function memWmUpdateScoreCmd(memoryId: string, score: number, personaId = 'default'): Command<MemWmUpdateScoreParams> {
  return { kind: MEM_WM_CMD_UPDATE_SCORE, params: { memoryId, score, personaId } };
}

export function memWmDeleteCmd(memoryId: string, personaId = 'default'): Command<MemWmDeleteParams> {
  return { kind: MEM_WM_CMD_DELETE, params: { memoryId, personaId } };
}

export function memWmDeleteAllCmd(personaId = 'default'): Command<MemWmDeleteAllParams> {
  return { kind: MEM_WM_CMD_DELETE_ALL, params: { personaId } };
}
