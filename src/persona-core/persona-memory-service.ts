/**
 * Persona memory service.
 *
 * Extracted from `PersonaCoreService` as Step 16 of the §8 GA backlog —
 * the "拆分第一刀" (first cut) of the 3482-line god-object. The other
 * domains (marketplace, governance) stay inside `PersonaCoreService`
 * for now and will follow the same pattern.
 *
 * What lives here:
 *   - Public API for memory CRUD + search + graph queries:
 *       addMemory, listPersonaMemories, searchPersonaMemories,
 *       getPersonaGraphSummary, queryPersonaGraph
 *   - `insertMemory` + `projectKnowledgeItem` exposed so that
 *     non-memory callers (e.g. `PersonaCoreService.addKnowledge`)
 *     continue to reach the same insertion path. Without this, the
 *     facade would have to re-implement the memory write path —
 *     defeating the purpose of the extraction.
 *
 * What stays in `PersonaCoreService`:
 *   - The persona-existence + lifecycle guards (`getPersonaDetail`,
 *     `isTerminalStatus`, `forkBelongsToPersona`). The memory service
 *     receives them as injected lookups so it stays a pure data
 *     transform layer.
 *   - Growth/reputation writes that `addKnowledge` triggers — those
 *     are persona-level, not memory-level.
 *
 * Contract guarantee: every public method here returns exactly what
 * the corresponding method on `PersonaCoreService` returned before
 * the split. Existing API consumers + tests don't see the split.
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { FieldEncryption } from '../storage/encryption.js';
import {
  pcoreCmdInsertMemory,
  pcoreQueryMemoryEdges,
  pcoreQueryMemoryKindCounts,
  pcoreQueryMemoryNodeIds,
  pcoreQueryMemoryRelationCounts,
  pcoreQueryPersonaMemories,
  type PcoreMemoryRow,
} from '@chrono/kernel';
import { PersonaCognitiveMemoryGraph } from './persona-cognitive-memory.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { realClock, type Clock } from '../utils/clock.js';
import type {
  AddPersonaMemoryInput,
  PersonaCognitiveMemoryKind,
  PersonaCoreDetail,
  PersonaGraphQueryInput,
  PersonaGraphQueryResult,
  PersonaGraphSummary,
  PersonaMemory,
  PersonaMemorySearchResult,
  PersonaMemorySensitivity,
  PersonaCore,
} from './types.js';
import { clamp, round, safeJsonParse, normalizeMemorySensitivity } from './persona-core-utils.js';

/**
 * The lookups + collaborators the memory service needs but can't
 * own. `PersonaCoreService` constructs this object once at startup
 * and passes it through.
 *
 * Why not pass the whole `PersonaCoreService`? Two reasons:
 *   - Circular dependency: the memory service is constructed by the
 *     core service; if it took the core service back as a parameter
 *     either constructor would need late binding.
 *   - Surface clarity: documenting "I need exactly THESE 3 things"
 *     forces future refactors (e.g. extracting marketplace) to be
 *     equally explicit about cross-domain dependencies.
 */
export interface PersonaMemoryContext {
  /** Resolve a persona for read-with-permission. Returns `null` when
   *  the persona doesn't exist OR the caller isn't its owner. */
  getPersonaDetail(tenantId: string, ownerUserId: string, personaId: string): PersonaCoreDetail | null;
  /** True when the persona is in a terminal state (deceased / sealed)
   *  that should refuse new memory writes. */
  isTerminalStatus(status: PersonaCore['status']): boolean;
  /** True when the fork id (if provided to addMemory) actually
   *  belongs to the named persona. Used to gate fork-scoped memories. */
  forkBelongsToPersona(tenantId: string, personaId: string, forkId: string): boolean;
}

export class PersonaMemoryService {
  /**
   * Optional per-tenant encryption supplier. Accepts both shapes used
   * by `PersonaCoreService` historically — a static field-encryption
   * instance + a resolver function — and applies the same precedence
   * (resolver wins when it returns an enabled instance, otherwise the
   * static fallback). Encryption resolution is a single source of
   * truth here so future additions on the facade can't drift from
   * what the sub-service uses. */
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly ctx: PersonaMemoryContext,
    private readonly staticEncryption?: FieldEncryption,
    private readonly encryptionResolver?: (tenantId: string) => FieldEncryption | undefined,
    /*
     * 时钟抽象（确定性）：必须与 facade 注入同源，否则本子服务创建的认知内核会用默认
     * realClock，导致 projectKnowledgeItem/buildState 写入的时间戳与 facade 口径分裂、
     * 破坏认知内核确定性自洽。默认 realClock 保持向后兼容。
     */
    private readonly clock: Clock = realClock,
  ) {}

  /* ── Public API ─────────────────────────────────────────────── */

  addMemory(input: AddPersonaMemoryInput): PersonaMemory | null {
    const persona = this.ctx.getPersonaDetail(input.tenantId, input.ownerUserId, input.personaId);
    if (!persona || this.ctx.isTerminalStatus(persona.status)) return null;
    if (input.forkId && !this.ctx.forkBelongsToPersona(input.tenantId, input.personaId, input.forkId)) return null;

    return this.insertMemory({
      tenantId: input.tenantId,
      personaId: input.personaId,
      forkId: input.forkId,
      kind: input.kind,
      sensitivity: input.sensitivity,
      summary: input.summary,
      content: input.content ?? {},
      importance: clamp(input.importance ?? 0.5, 0, 1),
    });
  }

  listPersonaMemories(
    tenantId: string,
    ownerUserId: string,
    personaId: string,
    options?: {
      kind?: PersonaMemory['kind'];
      limit?: number;
      cursor?: number;
    },
  ): PersonaMemory[] | null {
    const persona = this.ctx.getPersonaDetail(tenantId, ownerUserId, personaId);
    if (!persona) return null;

    const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
    const rows = this.tx.queryMany(pcoreQueryPersonaMemories({
      tenantId,
      personaId,
      kind: options?.kind,
      cursor: options?.cursor,
      limit,
    }));
    return rows.map((row) => this.memoryFromRow(row));
  }

  searchPersonaMemories(
    tenantId: string,
    ownerUserId: string,
    personaId: string,
    query: string,
    limit = 5,
  ): PersonaMemorySearchResult[] | null {
    const memories = this.listPersonaMemories(tenantId, ownerUserId, personaId, { limit: 200 });
    if (!memories) return null;

    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

    return memories
      .map((memory) => {
        const searchable = `${memory.summary} ${JSON.stringify(memory.content)}`.toLowerCase();
        const hitCount = tokens.reduce((count, token) => count + (searchable.includes(token) ? 1 : 0), 0);
        const score = tokens.length === 0 ? 0 : round((hitCount / tokens.length) * 0.8 + memory.importance * 0.2, 4);
        return {
          memoryId: memory.id,
          score,
          contentText: memory.summary,
          createdAt: memory.createdAt,
        } satisfies PersonaMemorySearchResult;
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(50, limit)));
  }

  getPersonaGraphSummary(tenantId: string, ownerUserId: string, personaId: string): PersonaGraphSummary | null {
    const persona = this.ctx.getPersonaDetail(tenantId, ownerUserId, personaId);
    if (!persona) return null;

    const state = this.getCognitive(tenantId).buildState(tenantId, personaId);
    const kindRows = this.tx.queryMany(pcoreQueryMemoryKindCounts({ tenantId, personaId }));
    const relationRows = this.tx.queryMany(pcoreQueryMemoryRelationCounts({ tenantId, personaId }));

    const memoryKindCounts: Record<PersonaCognitiveMemoryKind, number> = {
      episodic: 0,
      semantic: 0,
      procedural: 0,
    };
    for (const row of kindRows) {
      memoryKindCounts[row.kind as PersonaCognitiveMemoryKind] = Number(row.count);
    }

    return {
      totalNodes: state.totalMemories,
      totalEdges: state.totalEdges,
      workingMemorySize: state.workingMemory.length,
      memoryKindCounts,
      relationCounts: Object.fromEntries(relationRows.map((row) => [row.relation, Number(row.count)])),
    };
  }

  queryPersonaGraph(
    tenantId: string,
    ownerUserId: string,
    personaId: string,
    input: PersonaGraphQueryInput,
  ): PersonaGraphQueryResult | null {
    const persona = this.ctx.getPersonaDetail(tenantId, ownerUserId, personaId);
    if (!persona) return null;

    const limit = Math.max(1, Math.min(50, input.limit ?? 12));
    const nodeRows = this.tx.queryMany(pcoreQueryMemoryNodeIds({
      tenantId,
      personaId,
      memoryId: input.memoryId,
      kind: input.kind,
      limit,
    }));
    const nodes = nodeRows
      .map((row) => this.getCognitive(tenantId).getMemory(tenantId, personaId, row.id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    if (nodes.length === 0) {
      return { nodes: [], edges: [] };
    }

    const edges = this.tx.queryMany(pcoreQueryMemoryEdges({
      tenantId,
      personaId,
      nodeIds: nodes.map((node) => node.id),
      relation: input.relation,
    })).map((row) => ({
      tenantId: row.tenant_id,
      personaId: row.persona_id,
      source: row.source,
      target: row.target,
      strength: Number(row.strength),
      relation: row.relation,
    }));

    return { nodes, edges };
  }

  /* ── Internal API (called by PersonaCoreService for cross-domain
   *    operations like addKnowledge that touch memory + reputation +
   *    growth in the same transaction) ──────────────────────────── */

  /** Insert a memory row + optionally project into the cognitive
   *  graph. `skipCognitiveProjection` is used by `addKnowledge` where
   *  the caller does its own knowledge-item projection. */
  insertMemory(input: {
    tenantId: string;
    personaId: string;
    forkId?: string;
    kind: PersonaMemory['kind'];
    sensitivity?: PersonaMemorySensitivity;
    summary: string;
    content: Record<string, unknown>;
    importance: number;
    skipCognitiveProjection?: boolean;
  }): PersonaMemory {
    const now = this.clock.now();
    const memoryId = generatePrefixedId('pmem');
    const sensitivity = normalizeMemorySensitivity(input.sensitivity);
    const ownerRestricted = sensitivity === 'owner-restricted';
    const encryption = this.getEncryption(input.tenantId);
    const isEncrypted = Boolean(encryption) && (sensitivity === 'encrypted' || ownerRestricted);
    const storedSummary = isEncrypted ? this.encryptString(input.summary, input.tenantId) : input.summary;
    const storedContent = JSON.stringify(input.content);
    const storedContentJson = isEncrypted ? this.encryptString(storedContent, input.tenantId) : storedContent;
    this.tx.execute(pcoreCmdInsertMemory({
      id: memoryId,
      tenantId: input.tenantId,
      personaId: input.personaId,
      forkId: input.forkId ?? null,
      kind: input.kind,
      sensitivity,
      isEncrypted: isEncrypted ? 1 : 0,
      ownerRestricted: ownerRestricted ? 1 : 0,
      summary: storedSummary,
      contentJson: storedContentJson,
      importance: clamp(input.importance, 0, 1),
      now,
    }));

    const memory: PersonaMemory = {
      id: memoryId,
      tenantId: input.tenantId,
      personaId: input.personaId,
      forkId: input.forkId ?? null,
      kind: input.kind,
      sensitivity,
      isEncrypted,
      ownerRestricted,
      summary: input.summary,
      content: input.content,
      importance: clamp(input.importance, 0, 1),
      createdAt: now,
      updatedAt: now,
    };

    if (!input.skipCognitiveProjection) {
      this.projectEventMemory(memory);
    }

    return memory;
  }

  /** Project a knowledge item into the cognitive graph as a semantic
   *  memory. Used by `PersonaCoreService.addKnowledge` after it
   *  writes the knowledge row + growth event. */
  projectKnowledgeItem(input: {
    tenantId: string;
    personaId: string;
    knowledgeItemId: string;
    title: string;
    content: string;
    confidence: number;
  }): void {
    this.getCognitive(input.tenantId).projectMemory({
      tenantId: input.tenantId,
      personaId: input.personaId,
      knowledgeItemId: input.knowledgeItemId,
      kind: 'semantic',
      content: `${input.title}\n${input.content}`.trim(),
      valence: 0.1,
      salience: clamp(0.35 + input.confidence * 0.55, 0.2, 1),
    });
  }

  /* ── Private helpers ────────────────────────────────────────── */

  /** Resolve the active encryption instance for a tenant. Resolver
   *  wins when it returns enabled; otherwise static fallback. */
  private getEncryption(tenantId: string): FieldEncryption | undefined {
    const resolved = this.encryptionResolver?.(tenantId);
    return resolved?.isEnabled
      ? resolved
      : (this.staticEncryption?.isEnabled ? this.staticEncryption : undefined);
  }

  private getCognitive(tenantId: string): PersonaCognitiveMemoryGraph {
    return new PersonaCognitiveMemoryGraph(this.tx, undefined, this.getEncryption(tenantId), this.clock);
  }

  private projectEventMemory(memory: PersonaMemory): void {
    this.getCognitive(memory.tenantId).projectMemory({
      tenantId: memory.tenantId,
      personaId: memory.personaId,
      forkId: memory.forkId,
      sourceMemoryId: memory.id,
      kind: this.mapEventKindToCognitive(memory.kind),
      content: this.buildEventProjectionContent(memory.summary, memory.content),
      valence: this.estimateEventValence(memory),
      salience: clamp(memory.importance, 0.1, 1),
    });
  }

  private mapEventKindToCognitive(kind: PersonaMemory['kind']): PersonaCognitiveMemoryKind {
    switch (kind) {
      case 'knowledge':
        return 'semantic';
      case 'training':
        return 'procedural';
      case 'interaction':
      case 'task':
      case 'governance':
      default:
        return 'episodic';
    }
  }

  private estimateEventValence(memory: PersonaMemory): number {
    if (memory.kind === 'training') return 0.2;
    if (memory.kind === 'knowledge') return 0.1;

    if (memory.kind === 'task') {
      const qualityScore = this.getNumericField(memory.content, 'qualityScore');
      if (qualityScore !== undefined) {
        return clamp((qualityScore - 0.5) * 1.6, -1, 1);
      }
      return 0.4;
    }

    if (memory.kind === 'governance') {
      const eventType = typeof memory.content.eventType === 'string' ? memory.content.eventType : '';
      if (eventType === 'reward') return 0.7;
      if (eventType === 'warning' || eventType === 'review') return -0.35;
      if (eventType === 'restriction') return -0.75;
      if (eventType === 'death' || eventType === 'transfer') return -0.9;
      return -0.2;
    }

    return 0.25;
  }

  private getNumericField(content: Record<string, unknown>, key: string): number | undefined {
    const value = content[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private buildEventProjectionContent(summary: string, content: Record<string, unknown>): string {
    const lines = Object.entries(content)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .slice(0, 6)
      .map(([key, value]) => `${key}: ${this.stringifyProjectionValue(value)}`);
    return lines.length > 0 ? `${summary}\n${lines.join('\n')}` : summary;
  }

  private stringifyProjectionValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map((item) => this.stringifyProjectionValue(item)).join(', ');
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  /** Public for facade use — e.g. `PersonaCoreService.loadPersonaDetail`
   *  needs to surface recent memories as part of the detail payload.
   *  Without this, the facade would have to re-implement row decoding. */
  memoryFromRow(row: PcoreMemoryRow): PersonaMemory {
    const sensitivity = normalizeMemorySensitivity(row.sensitivity);
    const isEncrypted = Boolean(row.is_encrypted);
    const ownerRestricted = Boolean(row.owner_restricted) || sensitivity === 'owner-restricted';
    const summary = isEncrypted ? this.decryptString(row.summary, row.tenant_id) : row.summary;
    const contentJson = isEncrypted ? this.decryptString(row.content_json, row.tenant_id) : row.content_json;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      personaId: row.persona_id,
      forkId: row.fork_id,
      kind: row.kind as PersonaMemory['kind'],
      sensitivity,
      isEncrypted,
      ownerRestricted,
      summary,
      content: safeJsonParse<Record<string, unknown>>(contentJson, {}),
      importance: Number(row.importance),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private encryptString(value: string, tenantId: string): string {
    const encryption = this.getEncryption(tenantId);
    return encryption ? encryption.encrypt(value) : value;
  }

  private decryptString(value: string, tenantId: string): string {
    /* Tolerate decrypt failures the same way the pre-split facade did.
     * FieldEncryption.decrypt() can throw on malformed ciphertext,
     * missing key refs, or rotated keys without a re-encrypt pass.
     * Without this fallback, one bad row would propagate up through
     * getPersonaDetail() / listPersonaMemories() / searchPersonaMemories()
     * and break unrelated operations. Returning the stored value is
     * the same lossy-but-recoverable behaviour core had before. */
    const encryption = this.getEncryption(tenantId);
    if (!encryption) return value;
    try {
      return encryption.decrypt(value);
    } catch {
      return value;
    }
  }
}
