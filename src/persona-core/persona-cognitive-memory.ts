import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { PcmemNodeRow, PcmemEdgeRow } from '@chrono/kernel';
import {
  pcmemQueryNodeById, pcmemQueryNodeBySource, pcmemQueryNodeByKnowledge,
  pcmemQueryRecentNodes, pcmemQueryListNodes, pcmemQueryListNodesByKinds,
  pcmemQueryBatchNodes, pcmemQueryCountNodes, pcmemQueryCountEdges,
  pcmemQueryEdgesByFrontier, pcmemQueryAllEdges,
  pcmemQueryWmAllSlots, pcmemQueryWmSlotsOrdered,
  pcmemQueryWmSlotByMem, pcmemQueryWmCount, pcmemQueryWmLowest,
  pcmemCmdInsertNode, pcmemCmdUpsertEdge,
  pcmemCmdWmDeleteSlot, pcmemCmdWmUpdateScore, pcmemCmdWmInsertSlot,
} from '@chrono/kernel';
import { DEFAULT_COGNITION_CONFIG } from '../core/memory-graph.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { FieldEncryption } from '../storage/encryption.js';
import type { MemoryCognitionConfig } from '../types/core-self.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import type {
  PersonaCognitiveEdge,
  PersonaCognitiveMemory,
  PersonaCognitiveMemoryKind,
  PersonaCognitiveState,
  PersonaWorkingMemoryEntry,
} from './types.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mergeConfig(base: MemoryCognitionConfig, override: Partial<MemoryCognitionConfig>): MemoryCognitionConfig {
  return {
    decay: { ...base.decay, ...override.decay, kindFactors: { ...base.decay.kindFactors, ...override.decay?.kindFactors } },
    activation: { ...base.activation, ...override.activation },
    workingMemory: { ...base.workingMemory, ...override.workingMemory },
    consolidation: { ...base.consolidation, ...override.consolidation },
    eviction: { ...base.eviction, ...override.eviction },
  };
}

function toMemory(row: PcmemNodeRow, decryptContent: (value: string) => string): PersonaCognitiveMemory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    forkId: row.fork_id,
    sourceMemoryId: row.source_memory_id,
    knowledgeItemId: row.knowledge_item_id,
    kind: row.kind as PersonaCognitiveMemoryKind,
    content: decryptContent(row.content),
    valence: Number(row.valence),
    salience: Number(row.salience),
    accessCount: Number(row.access_count),
    decayLambda: Number(row.decay_lambda),
    lastAccessedAt: Number(row.last_accessed_at),
    lastDecayedAt: Number(row.last_decayed_at),
    consolidatedFrom: row.consolidated_from,
    createdAt: Number(row.created_at),
  };
}

function toEdge(row: PcmemEdgeRow): PersonaCognitiveEdge {
  return {
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    source: row.source,
    target: row.target,
    strength: Number(row.strength),
    relation: row.relation,
  };
}

export interface ProjectPersonaCognitiveMemoryInput {
  tenantId: string;
  personaId: string;
  forkId?: string | null;
  sourceMemoryId?: string | null;
  knowledgeItemId?: string | null;
  kind: PersonaCognitiveMemoryKind;
  content: string;
  valence?: number;
  salience?: number;
}

export class PersonaCognitiveMemoryGraph {
  private readonly config: MemoryCognitionConfig;
  private readonly encryption?: FieldEncryption;

  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    config?: Partial<MemoryCognitionConfig>,
    encryption?: FieldEncryption,
  ) {
    registerCoreSelfExecutors();
    this.config = config ? mergeConfig(DEFAULT_COGNITION_CONFIG, config) : DEFAULT_COGNITION_CONFIG;
    this.encryption = encryption?.isEnabled ? encryption : undefined;
  }

  private encryptContent(content: string): string {
    return this.encryption ? this.encryption.encrypt(content) : content;
  }

  private decryptContent(content: string): string {
    if (!this.encryption) return content;
    try {
      return this.encryption.decrypt(content);
    } catch {
      return content;
    }
  }

  projectMemory(input: ProjectPersonaCognitiveMemoryInput): PersonaCognitiveMemory {
    const existing = this.findExistingProjection(input);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const valence = clamp(input.valence ?? 0, -1, 1);
    const salience = clamp(input.salience ?? 0.5, 0, 1);
    const id = generatePrefixedId('pmnode');
    const decayLambda = this.computeLambda(input.kind, valence, 0);

    this.tx.execute(pcmemCmdInsertNode({
      id,
      tenantId: input.tenantId,
      personaId: input.personaId,
      forkId: input.forkId ?? null,
      sourceMemoryId: input.sourceMemoryId ?? null,
      knowledgeItemId: input.knowledgeItemId ?? null,
      kind: input.kind,
      content: this.encryptContent(input.content),
      valence,
      salience,
      decayLambda,
      now,
    }));

    this.linkRecentContext(input.tenantId, input.personaId, id, input.kind, input.forkId ?? null);
    this.admitToWorkingMemory(input.tenantId, input.personaId, id);

    return this.getMemory(input.tenantId, input.personaId, id)!;
  }

  getMemory(tenantId: string, personaId: string, memoryId: string): PersonaCognitiveMemory | null {
    const row = this.tx.queryOne(pcmemQueryNodeById({ tenantId, personaId, memoryId }));
    return row ? toMemory(row, this.decryptContent.bind(this)) : null;
  }

  getRelatedMemories(tenantId: string, personaId: string, memoryId: string, depth = 2): PersonaCognitiveMemory[] {
    const boundedDepth = Math.max(1, Math.min(5, depth));
    const visited = new Set<string>([memoryId]);
    let frontier = [memoryId];
    const related: PersonaCognitiveMemory[] = [];

    for (let layer = 0; layer < boundedDepth; layer++) {
      if (frontier.length === 0) break;
      const edges = this.tx.queryMany(pcmemQueryEdgesByFrontier({ tenantId, personaId, frontier }));

      const neighborIds: string[] = [];
      for (const edge of edges) {
        const neighborId = frontier.includes(edge.source) ? edge.target : edge.source;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        neighborIds.push(neighborId);
      }

      const nextFrontier: string[] = [];
      for (const memory of this.getMemoryBatch(tenantId, personaId, neighborIds)) {
        related.push(memory);
        nextFrontier.push(memory.id);
      }
      frontier = nextFrontier;
    }

    return related;
  }

  buildState(tenantId: string, personaId: string): PersonaCognitiveState {
    const workingMemory = this.refreshAndLoadWorkingMemory(tenantId, personaId);
    return {
      totalMemories: this.countMemories(tenantId, personaId),
      totalEdges: this.countEdges(tenantId, personaId),
      workingMemory,
      recentExperiences: this.listMemories(tenantId, personaId, { kinds: ['episodic'], limit: 8 }),
      semanticKnowledge: this.listMemories(tenantId, personaId, { kinds: ['semantic'], limit: 8 }),
      proceduralMemory: this.listMemories(tenantId, personaId, { kinds: ['procedural'], limit: 8 }),
    };
  }

  private findExistingProjection(input: ProjectPersonaCognitiveMemoryInput): PersonaCognitiveMemory | null {
    if (input.sourceMemoryId) {
      const row = this.tx.queryOne(pcmemQueryNodeBySource({
        tenantId: input.tenantId, personaId: input.personaId, sourceMemoryId: input.sourceMemoryId,
      }));
      if (row) return toMemory(row, this.decryptContent.bind(this));
    }

    if (input.knowledgeItemId) {
      const row = this.tx.queryOne(pcmemQueryNodeByKnowledge({
        tenantId: input.tenantId, personaId: input.personaId, knowledgeItemId: input.knowledgeItemId,
      }));
      if (row) return toMemory(row, this.decryptContent.bind(this));
    }

    return null;
  }

  private linkRecentContext(
    tenantId: string,
    personaId: string,
    memoryId: string,
    kind: PersonaCognitiveMemoryKind,
    forkId: string | null,
  ): void {
    const rows = this.tx.queryMany(pcmemQueryRecentNodes({ tenantId, personaId, excludeId: memoryId }));

    for (const row of rows) {
      const sameKind = row.kind === kind;
      const sameFork = Boolean(forkId && row.fork_id && forkId === row.fork_id);
      const strength = clamp((sameKind ? 0.32 : 0.18) + (sameFork ? 0.22 : 0) + (row.source_memory_id ? 0.05 : 0), 0.05, 0.9);
      const relation = sameFork ? 'fork_context' : sameKind ? 'memory_affinity' : 'chronology';
      this.tx.execute(pcmemCmdUpsertEdge({ tenantId, personaId, source: memoryId, target: row.id, strength, relation }));
    }
  }

  private listMemories(
    tenantId: string,
    personaId: string,
    options: { kinds?: PersonaCognitiveMemoryKind[]; limit: number },
  ): PersonaCognitiveMemory[] {
    if (!options.kinds?.length) {
      const rows = this.tx.queryMany(pcmemQueryListNodes({ tenantId, personaId, limit: options.limit }));
      return rows.map((row) => toMemory(row, this.decryptContent.bind(this)));
    }

    const rows = this.tx.queryMany(pcmemQueryListNodesByKinds({
      tenantId, personaId, kinds: options.kinds, limit: options.limit,
    }));
    return rows.map((row) => toMemory(row, this.decryptContent.bind(this)));
  }

  private getMemoryBatch(tenantId: string, personaId: string, memoryIds: string[]): PersonaCognitiveMemory[] {
    if (memoryIds.length === 0) return [];
    const rows = this.tx.queryMany(pcmemQueryBatchNodes({ tenantId, personaId, ids: memoryIds }));
    const byId = new Map(rows.map((row) => [row.id, toMemory(row, this.decryptContent.bind(this))]));
    return memoryIds.map((id) => byId.get(id)).filter((value): value is PersonaCognitiveMemory => Boolean(value));
  }

  private refreshAndLoadWorkingMemory(tenantId: string, personaId: string): PersonaWorkingMemoryEntry[] {
    this.tx.transaction(() => {
      const slots = this.tx.queryMany(pcmemQueryWmAllSlots({ tenantId, personaId }));

      const memoryIds = slots.map((slot) => slot.memory_id);
      const memories = new Map(this.getMemoryBatch(tenantId, personaId, memoryIds).map((memory) => [memory.id, memory]));

      for (const slot of slots) {
        const memory = memories.get(slot.memory_id);
        if (!memory) {
          this.tx.execute(pcmemCmdWmDeleteSlot({ tenantId, personaId, memoryId: slot.memory_id }));
          continue;
        }

        const nextScore = this.computeWorkingMemoryScore(memory);
        this.tx.execute(pcmemCmdWmUpdateScore({ tenantId, personaId, memoryId: slot.memory_id, score: nextScore }));
      }
    });

    const slots = this.tx.queryMany(pcmemQueryWmSlotsOrdered({ tenantId, personaId }));
    const memories = new Map(
      this.getMemoryBatch(tenantId, personaId, slots.map((slot) => slot.memory_id)).map((memory) => [memory.id, memory]),
    );

    return slots.map((slot) => ({
      slot: {
        memoryId: slot.memory_id,
        score: Number(slot.score),
        enteredAt: Number(slot.entered_at),
      },
      memory: memories.get(slot.memory_id) ?? null,
    }));
  }

  private admitToWorkingMemory(tenantId: string, personaId: string, memoryId: string): void {
    const memory = this.getMemory(tenantId, personaId, memoryId);
    if (!memory) return;

    const score = this.computeWorkingMemoryScore(memory);
    const capacity = this.config.workingMemory.capacity;

    const existing = this.tx.queryOne(pcmemQueryWmSlotByMem({ tenantId, personaId, memoryId }));
    if (existing) {
      this.tx.execute(pcmemCmdWmUpdateScore({ tenantId, personaId, memoryId, score }));
      return;
    }

    const count = this.tx.queryOne(pcmemQueryWmCount({ tenantId, personaId }))?.count ?? 0;

    if (count < capacity) {
      this.tx.execute(pcmemCmdWmInsertSlot({ tenantId, personaId, memoryId, score, enteredAt: Date.now() }));
      return;
    }

    const lowest = this.tx.queryOne(pcmemQueryWmLowest({ tenantId, personaId }));
    if (!lowest || score <= Number(lowest.score)) return;

    this.tx.execute(pcmemCmdWmDeleteSlot({ tenantId, personaId, memoryId: lowest.memory_id }));
    this.tx.execute(pcmemCmdWmInsertSlot({ tenantId, personaId, memoryId, score, enteredAt: Date.now() }));
  }

  private countMemories(tenantId: string, personaId: string): number {
    return this.tx.queryOne(pcmemQueryCountNodes({ tenantId, personaId }))?.count ?? 0;
  }

  private countEdges(tenantId: string, personaId: string): number {
    return this.tx.queryOne(pcmemQueryCountEdges({ tenantId, personaId }))?.count ?? 0;
  }

  private computeLambda(kind: PersonaCognitiveMemoryKind, valence: number, accessCount: number): number {
    const { baseLambda, valenceWeight, accessBoost, kindFactors } = this.config.decay;
    const kindFactor = kindFactors[kind] ?? 1;
    const raw = baseLambda * (1 - valenceWeight * Math.abs(valence)) * kindFactor / (1 + accessBoost * accessCount);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  private computeWorkingMemoryScore(memory: PersonaCognitiveMemory): number {
    const recencyFactor = Math.exp(-this.config.workingMemory.recencyDecay * (Date.now() - memory.lastAccessedAt));
    const accessFactor = 1 + Math.log(1 + memory.accessCount);
    return memory.salience * recencyFactor * accessFactor;
  }

  getEdges(tenantId: string, personaId: string): PersonaCognitiveEdge[] {
    const rows = this.tx.queryMany(pcmemQueryAllEdges({ tenantId, personaId }));
    return rows.map(toEdge);
  }
}
