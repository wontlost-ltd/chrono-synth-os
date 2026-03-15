import { DEFAULT_COGNITION_CONFIG } from '../core/memory-graph.js';
import type { IDatabase } from '../storage/database.js';
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

interface PersonaMemoryNodeRow {
  id: string;
  tenant_id: string;
  persona_id: string;
  fork_id: string | null;
  source_memory_id: string | null;
  knowledge_item_id: string | null;
  kind: PersonaCognitiveMemoryKind;
  content: string;
  valence: number;
  salience: number;
  access_count: number;
  decay_lambda: number;
  last_accessed_at: number;
  last_decayed_at: number;
  consolidated_from: string | null;
  created_at: number;
}

interface PersonaMemoryEdgeRow {
  tenant_id: string;
  persona_id: string;
  source: string;
  target: string;
  strength: number;
  relation: string;
}

interface PersonaWorkingMemoryRow {
  tenant_id: string;
  persona_id: string;
  memory_id: string;
  score: number;
  entered_at: number;
}

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

function toMemory(row: PersonaMemoryNodeRow, decryptContent: (value: string) => string): PersonaCognitiveMemory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personaId: row.persona_id,
    forkId: row.fork_id,
    sourceMemoryId: row.source_memory_id,
    knowledgeItemId: row.knowledge_item_id,
    kind: row.kind,
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

function toEdge(row: PersonaMemoryEdgeRow): PersonaCognitiveEdge {
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
    private readonly db: IDatabase,
    config?: Partial<MemoryCognitionConfig>,
    encryption?: FieldEncryption,
  ) {
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

    this.db.prepare<void>(
      `INSERT INTO persona_memory_nodes (
        id, tenant_id, persona_id, fork_id, source_memory_id, knowledge_item_id,
        kind, content, valence, salience, access_count, decay_lambda,
        last_accessed_at, last_decayed_at, consolidated_from, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      input.tenantId,
      input.personaId,
      input.forkId ?? null,
      input.sourceMemoryId ?? null,
      input.knowledgeItemId ?? null,
      input.kind,
      this.encryptContent(input.content),
      valence,
      salience,
      decayLambda,
      now,
      now,
      now,
    );

    this.linkRecentContext(input.tenantId, input.personaId, id, input.kind, input.forkId ?? null);
    this.admitToWorkingMemory(input.tenantId, input.personaId, id);

    return this.getMemory(input.tenantId, input.personaId, id)!;
  }

  getMemory(tenantId: string, personaId: string, memoryId: string): PersonaCognitiveMemory | null {
    const row = this.db.prepare<PersonaMemoryNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ? AND id = ?
       LIMIT 1`,
    ).get(tenantId, personaId, memoryId);
    return row ? toMemory(row, this.decryptContent.bind(this)) : null;
  }

  getRelatedMemories(tenantId: string, personaId: string, memoryId: string, depth = 2): PersonaCognitiveMemory[] {
    const boundedDepth = Math.max(1, Math.min(5, depth));
    const visited = new Set<string>([memoryId]);
    let frontier = [memoryId];
    const related: PersonaCognitiveMemory[] = [];

    for (let layer = 0; layer < boundedDepth; layer++) {
      if (frontier.length === 0) break;
      const placeholders = frontier.map(() => '?').join(',');
      const edges = this.db.prepare<PersonaMemoryEdgeRow>(
        `SELECT * FROM persona_memory_edges
         WHERE tenant_id = ? AND persona_id = ?
           AND (source IN (${placeholders}) OR target IN (${placeholders}))`,
      ).all(tenantId, personaId, ...frontier, ...frontier);

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
      const row = this.db.prepare<PersonaMemoryNodeRow>(
        `SELECT * FROM persona_memory_nodes
         WHERE tenant_id = ? AND persona_id = ? AND source_memory_id = ?
         LIMIT 1`,
      ).get(input.tenantId, input.personaId, input.sourceMemoryId);
      if (row) return toMemory(row, this.decryptContent.bind(this));
    }

    if (input.knowledgeItemId) {
      const row = this.db.prepare<PersonaMemoryNodeRow>(
        `SELECT * FROM persona_memory_nodes
         WHERE tenant_id = ? AND persona_id = ? AND knowledge_item_id = ?
         LIMIT 1`,
      ).get(input.tenantId, input.personaId, input.knowledgeItemId);
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
    const rows = this.db.prepare<PersonaMemoryNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ? AND id != ?
       ORDER BY created_at DESC
       LIMIT 4`,
    ).all(tenantId, personaId, memoryId);

    for (const row of rows) {
      const sameKind = row.kind === kind;
      const sameFork = Boolean(forkId && row.fork_id && forkId === row.fork_id);
      const strength = clamp((sameKind ? 0.32 : 0.18) + (sameFork ? 0.22 : 0) + (row.source_memory_id ? 0.05 : 0), 0.05, 0.9);
      const relation = sameFork ? 'fork_context' : sameKind ? 'memory_affinity' : 'chronology';
      this.db.prepare<void>(
        `INSERT INTO persona_memory_edges (tenant_id, persona_id, source, target, strength, relation)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, target) DO UPDATE SET strength = excluded.strength, relation = excluded.relation`,
      ).run(tenantId, personaId, memoryId, row.id, strength, relation);
    }
  }

  private listMemories(
    tenantId: string,
    personaId: string,
    options: { kinds?: PersonaCognitiveMemoryKind[]; limit: number },
  ): PersonaCognitiveMemory[] {
    if (!options.kinds?.length) {
      const rows = this.db.prepare<PersonaMemoryNodeRow>(
        `SELECT * FROM persona_memory_nodes
         WHERE tenant_id = ? AND persona_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      ).all(tenantId, personaId, options.limit);
      return rows.map((row) => toMemory(row, this.decryptContent.bind(this)));
    }

    const placeholders = options.kinds.map(() => '?').join(',');
    const rows = this.db.prepare<PersonaMemoryNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ? AND kind IN (${placeholders})
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(tenantId, personaId, ...options.kinds, options.limit);
    return rows.map((row) => toMemory(row, this.decryptContent.bind(this)));
  }

  private getMemoryBatch(tenantId: string, personaId: string, memoryIds: string[]): PersonaCognitiveMemory[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => '?').join(',');
    const rows = this.db.prepare<PersonaMemoryNodeRow>(
      `SELECT * FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ? AND id IN (${placeholders})`,
    ).all(tenantId, personaId, ...memoryIds);
    const byId = new Map(rows.map((row) => [row.id, toMemory(row, this.decryptContent.bind(this))]));
    return memoryIds.map((id) => byId.get(id)).filter((value): value is PersonaCognitiveMemory => Boolean(value));
  }

  private refreshAndLoadWorkingMemory(tenantId: string, personaId: string): PersonaWorkingMemoryEntry[] {
    this.db.transaction(() => {
      const slots = this.db.prepare<PersonaWorkingMemoryRow>(
        `SELECT * FROM persona_working_memory
         WHERE tenant_id = ? AND persona_id = ?`,
      ).all(tenantId, personaId);

      const memoryIds = slots.map((slot) => slot.memory_id);
      const memories = new Map(this.getMemoryBatch(tenantId, personaId, memoryIds).map((memory) => [memory.id, memory]));

      for (const slot of slots) {
        const memory = memories.get(slot.memory_id);
        if (!memory) {
          this.db.prepare<void>(
            `DELETE FROM persona_working_memory
             WHERE tenant_id = ? AND persona_id = ? AND memory_id = ?`,
          ).run(tenantId, personaId, slot.memory_id);
          continue;
        }

        const nextScore = this.computeWorkingMemoryScore(memory);
        this.db.prepare<void>(
          `UPDATE persona_working_memory
           SET score = ?
           WHERE tenant_id = ? AND persona_id = ? AND memory_id = ?`,
        ).run(nextScore, tenantId, personaId, slot.memory_id);
      }
    });

    const slots = this.db.prepare<PersonaWorkingMemoryRow>(
      `SELECT * FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY score DESC`,
    ).all(tenantId, personaId);
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

    const existing = this.db.prepare<PersonaWorkingMemoryRow>(
      `SELECT * FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ? AND memory_id = ?`,
    ).get(tenantId, personaId, memoryId);
    if (existing) {
      this.db.prepare<void>(
        `UPDATE persona_working_memory
         SET score = ?
         WHERE tenant_id = ? AND persona_id = ? AND memory_id = ?`,
      ).run(score, tenantId, personaId, memoryId);
      return;
    }

    const count = this.db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ?`,
    ).get(tenantId, personaId)?.count ?? 0;

    if (count < capacity) {
      this.db.prepare<void>(
        `INSERT INTO persona_working_memory (tenant_id, persona_id, memory_id, score, entered_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(tenantId, personaId, memoryId, score, Date.now());
      return;
    }

    const lowest = this.db.prepare<PersonaWorkingMemoryRow>(
      `SELECT * FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ?
       ORDER BY score ASC
       LIMIT 1`,
    ).get(tenantId, personaId);
    if (!lowest || score <= Number(lowest.score)) return;

    this.db.prepare<void>(
      `DELETE FROM persona_working_memory
       WHERE tenant_id = ? AND persona_id = ? AND memory_id = ?`,
    ).run(tenantId, personaId, lowest.memory_id);
    this.db.prepare<void>(
      `INSERT INTO persona_working_memory (tenant_id, persona_id, memory_id, score, entered_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(tenantId, personaId, memoryId, score, Date.now());
  }

  private countMemories(tenantId: string, personaId: string): number {
    return this.db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM persona_memory_nodes
       WHERE tenant_id = ? AND persona_id = ?`,
    ).get(tenantId, personaId)?.count ?? 0;
  }

  private countEdges(tenantId: string, personaId: string): number {
    return this.db.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM persona_memory_edges
       WHERE tenant_id = ? AND persona_id = ?`,
    ).get(tenantId, personaId)?.count ?? 0;
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
    return this.db.prepare<PersonaMemoryEdgeRow>(
      `SELECT * FROM persona_memory_edges
       WHERE tenant_id = ? AND persona_id = ?`,
    ).all(tenantId, personaId).map(toEdge);
  }
}
