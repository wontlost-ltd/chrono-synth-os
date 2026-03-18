/**
 * 人格认知记忆 Query/Command kind 常量与参数类型
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query Kinds ── */

export const PCMEM_QUERY_NODE_BY_ID = 'cognitiveMemory.nodeById' as const;
export const PCMEM_QUERY_NODE_BY_SOURCE = 'cognitiveMemory.nodeBySource' as const;
export const PCMEM_QUERY_NODE_BY_KNOWLEDGE = 'cognitiveMemory.nodeByKnowledge' as const;
export const PCMEM_QUERY_RECENT_NODES = 'cognitiveMemory.recentNodes' as const;
export const PCMEM_QUERY_LIST_NODES = 'cognitiveMemory.listNodes' as const;
export const PCMEM_QUERY_LIST_NODES_BY_KINDS = 'cognitiveMemory.listNodesByKinds' as const;
export const PCMEM_QUERY_BATCH_NODES = 'cognitiveMemory.batchNodes' as const;
export const PCMEM_QUERY_COUNT_NODES = 'cognitiveMemory.countNodes' as const;
export const PCMEM_QUERY_COUNT_EDGES = 'cognitiveMemory.countEdges' as const;
export const PCMEM_QUERY_EDGES_BY_FRONTIER = 'cognitiveMemory.edgesByFrontier' as const;
export const PCMEM_QUERY_ALL_EDGES = 'cognitiveMemory.allEdges' as const;
export const PCMEM_QUERY_WM_ALL_SLOTS = 'cognitiveMemory.wmAllSlots' as const;
export const PCMEM_QUERY_WM_SLOTS_ORDERED = 'cognitiveMemory.wmSlotsOrdered' as const;
export const PCMEM_QUERY_WM_SLOT_BY_MEM = 'cognitiveMemory.wmSlotByMem' as const;
export const PCMEM_QUERY_WM_COUNT = 'cognitiveMemory.wmCount' as const;
export const PCMEM_QUERY_WM_LOWEST = 'cognitiveMemory.wmLowest' as const;

/* ── Command Kinds ── */

export const PCMEM_CMD_INSERT_NODE = 'cognitiveMemory.insertNode' as const;
export const PCMEM_CMD_UPSERT_EDGE = 'cognitiveMemory.upsertEdge' as const;
export const PCMEM_CMD_WM_DELETE_SLOT = 'cognitiveMemory.wmDeleteSlot' as const;
export const PCMEM_CMD_WM_UPDATE_SCORE = 'cognitiveMemory.wmUpdateScore' as const;
export const PCMEM_CMD_WM_INSERT_SLOT = 'cognitiveMemory.wmInsertSlot' as const;

/* ── 行类型 ── */

export interface PcmemNodeRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly fork_id: string | null;
  readonly source_memory_id: string | null;
  readonly knowledge_item_id: string | null;
  readonly kind: string;
  readonly content: string;
  readonly valence: number;
  readonly salience: number;
  readonly access_count: number;
  readonly decay_lambda: number;
  readonly last_accessed_at: number;
  readonly last_decayed_at: number;
  readonly consolidated_from: string | null;
  readonly created_at: number;
}

export interface PcmemEdgeRow {
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly source: string;
  readonly target: string;
  readonly strength: number;
  readonly relation: string;
}

export interface PcmemWmRow {
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly memory_id: string;
  readonly score: number;
  readonly entered_at: number;
}

export interface PcmemCountRow {
  readonly count: number;
}

/* ── 参数类型 ── */

export interface PcmemTenantPersonaParams {
  tenantId: string;
  personaId: string;
}

export interface PcmemNodeByIdParams {
  tenantId: string;
  personaId: string;
  memoryId: string;
}

export interface PcmemNodeBySourceParams {
  tenantId: string;
  personaId: string;
  sourceMemoryId: string;
}

export interface PcmemNodeByKnowledgeParams {
  tenantId: string;
  personaId: string;
  knowledgeItemId: string;
}

export interface PcmemRecentNodesParams {
  tenantId: string;
  personaId: string;
  excludeId: string;
}

export interface PcmemListNodesParams {
  tenantId: string;
  personaId: string;
  limit: number;
}

export interface PcmemListNodesByKindsParams {
  tenantId: string;
  personaId: string;
  kinds: string[];
  limit: number;
}

export interface PcmemBatchNodesParams {
  tenantId: string;
  personaId: string;
  ids: string[];
}

export interface PcmemEdgesByFrontierParams {
  tenantId: string;
  personaId: string;
  frontier: string[];
}

export interface PcmemInsertNodeParams {
  id: string;
  tenantId: string;
  personaId: string;
  forkId: string | null;
  sourceMemoryId: string | null;
  knowledgeItemId: string | null;
  kind: string;
  content: string;
  valence: number;
  salience: number;
  decayLambda: number;
  now: number;
}

export interface PcmemUpsertEdgeParams {
  tenantId: string;
  personaId: string;
  source: string;
  target: string;
  strength: number;
  relation: string;
}

export interface PcmemWmSlotParams {
  tenantId: string;
  personaId: string;
  memoryId: string;
}

export interface PcmemWmUpdateScoreParams {
  tenantId: string;
  personaId: string;
  memoryId: string;
  score: number;
}

export interface PcmemWmInsertSlotParams {
  tenantId: string;
  personaId: string;
  memoryId: string;
  score: number;
  enteredAt: number;
}

/* ── Query 工厂 ── */

export function pcmemQueryNodeById(params: PcmemNodeByIdParams): Query<PcmemNodeRow | null, PcmemNodeByIdParams> {
  return { kind: PCMEM_QUERY_NODE_BY_ID, params };
}

export function pcmemQueryNodeBySource(params: PcmemNodeBySourceParams): Query<PcmemNodeRow | null, PcmemNodeBySourceParams> {
  return { kind: PCMEM_QUERY_NODE_BY_SOURCE, params };
}

export function pcmemQueryNodeByKnowledge(params: PcmemNodeByKnowledgeParams): Query<PcmemNodeRow | null, PcmemNodeByKnowledgeParams> {
  return { kind: PCMEM_QUERY_NODE_BY_KNOWLEDGE, params };
}

export function pcmemQueryRecentNodes(params: PcmemRecentNodesParams): Query<readonly PcmemNodeRow[], PcmemRecentNodesParams> {
  return { kind: PCMEM_QUERY_RECENT_NODES, params };
}

export function pcmemQueryListNodes(params: PcmemListNodesParams): Query<readonly PcmemNodeRow[], PcmemListNodesParams> {
  return { kind: PCMEM_QUERY_LIST_NODES, params };
}

export function pcmemQueryListNodesByKinds(params: PcmemListNodesByKindsParams): Query<readonly PcmemNodeRow[], PcmemListNodesByKindsParams> {
  return { kind: PCMEM_QUERY_LIST_NODES_BY_KINDS, params };
}

export function pcmemQueryBatchNodes(params: PcmemBatchNodesParams): Query<readonly PcmemNodeRow[], PcmemBatchNodesParams> {
  return { kind: PCMEM_QUERY_BATCH_NODES, params };
}

export function pcmemQueryCountNodes(params: PcmemTenantPersonaParams): Query<PcmemCountRow | null, PcmemTenantPersonaParams> {
  return { kind: PCMEM_QUERY_COUNT_NODES, params };
}

export function pcmemQueryCountEdges(params: PcmemTenantPersonaParams): Query<PcmemCountRow | null, PcmemTenantPersonaParams> {
  return { kind: PCMEM_QUERY_COUNT_EDGES, params };
}

export function pcmemQueryEdgesByFrontier(params: PcmemEdgesByFrontierParams): Query<readonly PcmemEdgeRow[], PcmemEdgesByFrontierParams> {
  return { kind: PCMEM_QUERY_EDGES_BY_FRONTIER, params };
}

export function pcmemQueryAllEdges(params: PcmemTenantPersonaParams): Query<readonly PcmemEdgeRow[], PcmemTenantPersonaParams> {
  return { kind: PCMEM_QUERY_ALL_EDGES, params };
}

export function pcmemQueryWmAllSlots(params: PcmemTenantPersonaParams): Query<readonly PcmemWmRow[], PcmemTenantPersonaParams> {
  return { kind: PCMEM_QUERY_WM_ALL_SLOTS, params };
}

export function pcmemQueryWmSlotsOrdered(params: PcmemTenantPersonaParams): Query<readonly PcmemWmRow[], PcmemTenantPersonaParams> {
  return { kind: PCMEM_QUERY_WM_SLOTS_ORDERED, params };
}

export function pcmemQueryWmSlotByMem(params: PcmemWmSlotParams): Query<PcmemWmRow | null, PcmemWmSlotParams> {
  return { kind: PCMEM_QUERY_WM_SLOT_BY_MEM, params };
}

export function pcmemQueryWmCount(params: PcmemTenantPersonaParams): Query<PcmemCountRow | null, PcmemTenantPersonaParams> {
  return { kind: PCMEM_QUERY_WM_COUNT, params };
}

export function pcmemQueryWmLowest(params: PcmemTenantPersonaParams): Query<PcmemWmRow | null, PcmemTenantPersonaParams> {
  return { kind: PCMEM_QUERY_WM_LOWEST, params };
}

/* ── Command 工厂 ── */

export function pcmemCmdInsertNode(params: PcmemInsertNodeParams): Command<PcmemInsertNodeParams> {
  return { kind: PCMEM_CMD_INSERT_NODE, params };
}

export function pcmemCmdUpsertEdge(params: PcmemUpsertEdgeParams): Command<PcmemUpsertEdgeParams> {
  return { kind: PCMEM_CMD_UPSERT_EDGE, params };
}

export function pcmemCmdWmDeleteSlot(params: PcmemWmSlotParams): Command<PcmemWmSlotParams> {
  return { kind: PCMEM_CMD_WM_DELETE_SLOT, params };
}

export function pcmemCmdWmUpdateScore(params: PcmemWmUpdateScoreParams): Command<PcmemWmUpdateScoreParams> {
  return { kind: PCMEM_CMD_WM_UPDATE_SCORE, params };
}

export function pcmemCmdWmInsertSlot(params: PcmemWmInsertSlotParams): Command<PcmemWmInsertSlotParams> {
  return { kind: PCMEM_CMD_WM_INSERT_SLOT, params };
}
