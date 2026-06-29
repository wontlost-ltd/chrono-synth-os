import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthorizationError, NotFoundError, StateError, ValidationError, ErrorCode } from '../../errors/index.js';
import { TenantEnterpriseProfileService } from '../../enterprise/tenant-enterprise-profile-service.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import type {
  DailyAnalyticsMaterialization,
  EconomyAnalytics,
  GovernanceAction,
  GovernanceCase,
  MarketplaceTask,
  MarketplaceAnalytics,
  PersonaAnalytics,
  PersonaCognitiveMemory,
  PersonaCoreDetail,
  PersonaCoreSummary,
  PersonaFork,
  PersonaGraphQueryResult,
  PersonaGraphSummary,
  PersonaGovernanceEvent,
  PersonaGrowthEvent,
  PersonaKnowledgeItem,
  PersonaMemorySearchResult,
  PersonaRankingEntry,
  PersonaReputationHistoryEntry,
  PersonaReputationSummary,
  PersonaTransfer,
  PersonaMemory,
  RuntimeSession,
  TaskApplication,
  TaskAssignment,
  TaskWalletSettlement,
  TaskResult,
  PersonaOperatingState,
  PersonaWallet,
  WalletPayoutRequest,
  WalletTransaction,
} from '../../persona-core/types.js';
import {
  AddGovernanceEventSchema,
  AddPersonaKnowledgeSchema,
  AddPersonaMemorySchema,
  AppealGovernanceCaseSchema,
  ApplyGovernanceActionSchema,
  ApplyTaskSchema,
  ApprovePersonaTransferSchema,
  AssignTaskSchema,
  AcceptSubmittedTaskSchema,
  CompleteMarketplaceTaskSchema,
  CreateRuntimeSessionSchema,
  CreatePersonaCoreForkSchema,
  CreatePersonaCoreSchema,
  DeceasePersonaSchema,
  DisputeTaskSchema,
  EvaluatePersonaLifecycleSchema,
  OpenGovernanceCaseSchema,
  PersonaGraphQuerySchema,
  PersonaMemoryListQuerySchema,
  PersonaMemorySearchSchema,
  PublishMarketplaceTaskSchema,
  AcceptMarketplaceTaskSchema,
  RejectTaskSchema,
  SubmitTaskResultSchema,
  TopPersonasQuerySchema,
  TransferPersonaSchema,
  WalletPayoutSchema,
  WalletSettlementTaskSchema,
} from '../schemas/api-schemas.js';

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(Number(value)).toISOString();
}

function serializeWallet(wallet: PersonaWallet) {
  return {
    ...wallet,
    lastSettledAt: toIso(wallet.lastSettledAt),
    createdAt: toIso(wallet.createdAt),
    updatedAt: toIso(wallet.updatedAt),
  };
}

function serializeWalletSummary(wallet: PersonaWallet) {
  return {
    walletId: wallet.id,
    personaId: wallet.personaId,
    balanceMinor: Math.round(wallet.balance * 100),
    currency: wallet.currency,
    status: wallet.status,
  };
}

function serializeWalletTransaction(transaction: WalletTransaction) {
  return {
    transactionId: transaction.id,
    transactionType: transaction.transactionType,
    amountMinor: transaction.amountMinor,
    currency: transaction.currency,
    referenceType: transaction.referenceType,
    referenceId: transaction.referenceId,
    createdAt: toIso(transaction.createdAt),
  };
}

function serializeWalletPayoutRequest(request: WalletPayoutRequest) {
  return {
    ...request,
    createdAt: toIso(request.createdAt),
    completedAt: toIso(request.completedAt),
  };
}

function serializeWalletSettlement(settlement: TaskWalletSettlement) {
  return {
    ...settlement,
    createdAt: toIso(settlement.createdAt),
    completedAt: toIso(settlement.completedAt),
  };
}

function serializeMaterialization(materialization: DailyAnalyticsMaterialization) {
  return materialization;
}

function serializeTask(task: MarketplaceTask) {
  return {
    ...task,
    publishedAt: toIso(task.publishedAt),
    acceptedAt: toIso(task.acceptedAt),
    completedAt: toIso(task.completedAt),
    createdAt: toIso(task.createdAt),
    updatedAt: toIso(task.updatedAt),
  };
}

function serializeTaskApplication(application: TaskApplication) {
  return {
    ...application,
    createdAt: toIso(application.createdAt),
    updatedAt: toIso(application.updatedAt),
  };
}

function serializeTaskAssignment(assignment: TaskAssignment) {
  return {
    ...assignment,
    assignedAt: toIso(assignment.assignedAt),
    startedAt: toIso(assignment.startedAt),
    submittedAt: toIso(assignment.submittedAt),
    completedAt: toIso(assignment.completedAt),
  };
}

function serializeTaskResult(result: TaskResult) {
  return {
    ...result,
    createdAt: toIso(result.createdAt),
    updatedAt: toIso(result.updatedAt),
    acceptedAt: toIso(result.acceptedAt),
    rejectedAt: toIso(result.rejectedAt),
    disputedAt: toIso(result.disputedAt),
  };
}

function serializeRuntimeSession(session: RuntimeSession) {
  return {
    ...session,
    timeoutAt: toIso(session.timeoutAt),
    createdAt: toIso(session.createdAt),
    updatedAt: toIso(session.updatedAt),
    completedAt: toIso(session.completedAt),
  };
}

function serializeGovernanceCase(governanceCase: GovernanceCase) {
  return {
    ...governanceCase,
    openedAt: toIso(governanceCase.openedAt),
    resolvedAt: toIso(governanceCase.resolvedAt),
    appealedAt: toIso(governanceCase.appealedAt),
  };
}

function serializeGovernanceAction(action: GovernanceAction) {
  return {
    ...action,
    createdAt: toIso(action.createdAt),
  };
}

function serializeMemory(memory: PersonaMemory) {
  return {
    ...memory,
    createdAt: toIso(memory.createdAt),
    updatedAt: toIso(memory.updatedAt),
  };
}

function serializeFork(fork: PersonaFork) {
  return {
    ...fork,
    createdAt: toIso(fork.createdAt),
    updatedAt: toIso(fork.updatedAt),
    recycledAt: toIso(fork.recycledAt),
  };
}

function serializeKnowledge(item: PersonaKnowledgeItem) {
  return {
    ...item,
    createdAt: toIso(item.createdAt),
    updatedAt: toIso(item.updatedAt),
  };
}

function serializeGrowthEvent(event: PersonaGrowthEvent) {
  return {
    ...event,
    createdAt: toIso(event.createdAt),
  };
}

function serializeGovernanceEvent(event: PersonaGovernanceEvent) {
  return {
    ...event,
    createdAt: toIso(event.createdAt),
  };
}

function serializeCognitiveMemory(memory: PersonaCognitiveMemory) {
  return {
    ...memory,
    createdAt: toIso(memory.createdAt),
    lastAccessedAt: toIso(memory.lastAccessedAt),
    lastDecayedAt: toIso(memory.lastDecayedAt),
  };
}

function serializeMemorySearchResult(result: PersonaMemorySearchResult) {
  return {
    ...result,
    createdAt: toIso(result.createdAt),
  };
}

function serializeGraphSummary(summary: PersonaGraphSummary) {
  return summary;
}

function serializeGraphQueryResult(result: PersonaGraphQueryResult) {
  return {
    nodes: result.nodes.map(serializeCognitiveMemory),
    edges: result.edges,
  };
}

function serializeTransfer(transfer: PersonaTransfer) {
  return {
    ...transfer,
    requestedAt: toIso(transfer.requestedAt),
    approvedAt: toIso(transfer.approvedAt),
    completedAt: toIso(transfer.completedAt),
  };
}

function serializeOperatingState(state: PersonaOperatingState) {
  return {
    persona: serializePersonaDetail(state.persona),
    cognitive: {
      ...state.cognitive,
      workingMemory: state.cognitive.workingMemory.map((entry) => ({
        slot: {
          ...entry.slot,
          enteredAt: toIso(entry.slot.enteredAt),
        },
        memory: entry.memory ? serializeCognitiveMemory(entry.memory) : null,
      })),
      recentExperiences: state.cognitive.recentExperiences.map(serializeCognitiveMemory),
      semanticKnowledge: state.cognitive.semanticKnowledge.map(serializeCognitiveMemory),
      proceduralMemory: state.cognitive.proceduralMemory.map(serializeCognitiveMemory),
    },
  };
}

function serializePersonaDetail(detail: PersonaCoreDetail) {
  return {
    ...detail,
    createdAt: toIso(detail.createdAt),
    updatedAt: toIso(detail.updatedAt),
    deceasedAt: toIso(detail.deceasedAt),
    transferredAt: toIso(detail.transferredAt),
    wallet: serializeWallet(detail.wallet),
    forks: detail.forks.map(serializeFork),
    recentMemories: detail.recentMemories.map(serializeMemory),
    knowledgeItems: detail.knowledgeItems.map(serializeKnowledge),
    growthEvents: detail.growthEvents.map(serializeGrowthEvent),
    governanceEvents: detail.governanceEvents.map(serializeGovernanceEvent),
    marketplaceTasks: detail.marketplaceTasks.map(serializeTask),
  };
}

function serializePersonaSummary(summary: PersonaCoreSummary) {
  return {
    ...summary,
    createdAt: toIso(summary.createdAt),
    updatedAt: toIso(summary.updatedAt),
    deceasedAt: toIso(summary.deceasedAt),
    transferredAt: toIso(summary.transferredAt),
    wallet: serializeWallet(summary.wallet),
  };
}

function requireJwtUser(request: { user?: JwtPayload }): JwtPayload {
  const user = request.user;
  if (!user || user.sub.startsWith('apikey:')) {
    throw new AuthorizationError(
      'Persona Core 仅支持用户 JWT 访问',
      ErrorCode.AUTH_INSUFFICIENT_ROLE,
    );
  }
  return user;
}

/**
 * 任务完成事件（earn→distill 闭环 WP-0）。完成市场任务后由路由触发，宿主（app.ts）订阅后
 * 经 tenant OS 的 earningDistiller 把高质量 outcome 蒸馏成 core value 候选（经蒸馏门，不绕过）。
 */
export interface MarketplaceTaskCompletedEvent {
  readonly tenantId: string;
  readonly personaId: string;
  readonly taskId: string;
  readonly category: string;
  readonly qualityScore: number;
  readonly payout: number;
}

export function registerPersonaCoreRoutes(
  app: FastifyInstance,
  db: IDatabase,
  config?: AppConfig,
  /** 可选：任务完成回调（earn→distill 闭环）。app.ts 注入经 tenantFactory 调 earningDistiller。 */
  onTaskCompleted?: (event: MarketplaceTaskCompletedEvent) => void,
): void {
  const tx = db;
  const profileService = config ? new TenantEnterpriseProfileService(tx, config) : undefined;
  const service = new PersonaCoreService(
    tx,
    profileService?.getTenantEncryption('default'),
    config?.runtime.recovery.sessionTimeoutMs,
    profileService ? (tenantId) => profileService.getTenantEncryption(tenantId) : undefined,
  );

  app.get('/api/v1/persona-core', async (request) => {
    const user = requireJwtUser(request);
    const personas = service.listPersonas(request.tenantId, user.sub).map(serializePersonaSummary);
    return { data: personas };
  });

  app.post('/api/v1/persona-core', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = CreatePersonaCoreSchema.parse(request.body);
    const detail = service.createPersona({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      displayName: body.displayName,
      profile: body.profile,
      visibility: body.visibility,
      initialKnowledge: body.initialKnowledge,
    });
    return reply.status(201).send({ data: serializePersonaDetail(detail) });
  });

  app.post('/api/v1/personas', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = CreatePersonaCoreSchema.parse(request.body);
    const detail = service.createPersona({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      displayName: body.displayName,
      profile: body.profile,
      visibility: body.visibility,
      initialKnowledge: body.initialKnowledge,
    });
    return reply.status(201).send({ data: serializePersonaDetail(detail) });
  });

  app.get<{ Params: { id: string } }>('/api/v1/persona-core/:id', async (request) => {
    const user = requireJwtUser(request);
    const detail = service.getPersonaDetail(request.tenantId, user.sub, request.params.id);
    if (!detail) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializePersonaDetail(detail) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/personas/:id/profile', async (request) => {
    const user = requireJwtUser(request);
    const detail = service.getPersonaDetail(request.tenantId, user.sub, request.params.id);
    if (!detail) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return {
      data: {
        personaId: detail.id,
        displayName: detail.displayName,
        profile: detail.profile,
        visibility: detail.visibility,
        status: detail.status,
        updatedAt: toIso(detail.updatedAt),
      },
    };
  });

  app.get<{ Params: { id: string } }>('/api/v1/persona-core/:id/operating-state', async (request) => {
    const user = requireJwtUser(request);
    const state = service.getOperatingState(request.tenantId, user.sub, request.params.id);
    if (!state) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializeOperatingState(state) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/persona-core/:id/forks', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = CreatePersonaCoreForkSchema.parse(request.body);
    const detail = service.createFork({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
      label: body.label,
      forkType: body.forkType,
      syncMode: body.syncMode,
      experienceFactor: body.experienceFactor,
    });
    if (!detail) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return reply.status(201).send({ data: serializePersonaDetail(detail) });
  });

  app.post<{ Params: { id: string } }>('/api/v1/persona-core/:id/memories', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = AddPersonaMemorySchema.parse(request.body);
    const memory = service.addMemory({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
      forkId: body.forkId,
      kind: body.kind,
      sensitivity: body.sensitivity,
      summary: body.summary,
      content: body.content,
      importance: body.importance,
    });
    if (!memory) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return reply.status(201).send({ data: serializeMemory(memory) });
  });

  app.post<{ Params: { id: string } }>('/api/v1/personas/:id/memories', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = AddPersonaMemorySchema.parse(request.body);
    const memory = service.addMemory({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
      forkId: body.forkId,
      kind: body.kind,
      sensitivity: body.sensitivity,
      summary: body.summary,
      content: body.content,
      importance: body.importance,
    });
    if (!memory) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return reply.status(201).send({ data: serializeMemory(memory) });
  });

  app.get<{ Params: { id: string } }>('/api/v1/personas/:id/memories', async (request) => {
    const user = requireJwtUser(request);
    const query = PersonaMemoryListQuerySchema.parse(request.query);
    const memories = service.listPersonaMemories(request.tenantId, user.sub, request.params.id, query);
    if (!memories) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return {
      data: memories.map(serializeMemory),
      meta: {
        nextCursor: memories.length > 0 ? memories[memories.length - 1]!.createdAt : null,
      },
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/personas/:id/memories/search', async (request) => {
    const user = requireJwtUser(request);
    const body = PersonaMemorySearchSchema.parse(request.body);
    const results = service.searchPersonaMemories(request.tenantId, user.sub, request.params.id, body.query, body.limit);
    if (!results) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: results.map(serializeMemorySearchResult) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/personas/:id/graph', async (request) => {
    const user = requireJwtUser(request);
    const summary = service.getPersonaGraphSummary(request.tenantId, user.sub, request.params.id);
    if (!summary) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializeGraphSummary(summary) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/personas/:id/graph/query', async (request) => {
    const user = requireJwtUser(request);
    const body = PersonaGraphQuerySchema.parse(request.body);
    const result = service.queryPersonaGraph(request.tenantId, user.sub, request.params.id, body);
    if (!result) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializeGraphQueryResult(result) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/persona-core/:id/knowledge', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = AddPersonaKnowledgeSchema.parse(request.body);
    const detail = service.addKnowledge({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
      title: body.title,
      content: body.content,
      source: body.source,
      tags: body.tags,
      confidence: body.confidence,
    });
    if (!detail) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return reply.status(201).send({ data: serializePersonaDetail(detail) });
  });

  app.get<{ Params: { id: string } }>('/api/v1/persona-core/:id/wallet', async (request) => {
    const user = requireJwtUser(request);
    const wallet = service.getWallet(request.tenantId, user.sub, request.params.id);
    if (!wallet) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializeWallet(wallet) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/wallets/:id', async (request) => {
    const user = requireJwtUser(request);
    const wallet = service.getWalletByIdForOwner(request.tenantId, user.sub, request.params.id);
    if (!wallet) {
      throw new NotFoundError(`Wallet ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_WALLET);
    }
    return { data: serializeWalletSummary(wallet) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/wallets/:id/transactions', async (request) => {
    const user = requireJwtUser(request);
    const transactions = service.listWalletTransactions(request.tenantId, user.sub, request.params.id);
    if (!transactions) {
      throw new NotFoundError(`Wallet ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_WALLET);
    }
    return { data: transactions.map(serializeWalletTransaction) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/wallets/:id/payout', async (request) => {
    const user = requireJwtUser(request);
    const body = WalletPayoutSchema.parse(request.body);
    const payout = service.requestWalletPayout({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      walletId: request.params.id,
      amountMinor: body.amountMinor,
    });
    if (!payout) {
      throw new NotFoundError(`Wallet ${request.params.id} 不存在或余额不足`, ErrorCode.NOT_FOUND_WALLET);
    }
    return { data: serializeWalletPayoutRequest(payout) };
  });

  app.post('/api/v1/wallets/settlements/task', async (request) => {
    const user = requireJwtUser(request);
    const body = WalletSettlementTaskSchema.parse(request.body);
    const settlement = service.settleTaskPayment({
      tenantId: request.tenantId,
      actorUserId: user.sub,
      taskId: body.taskId,
      assignmentId: body.assignmentId,
      totalAmountMinor: body.totalAmountMinor,
      currency: body.currency,
      split: body.split,
    });
    if (!settlement) {
      throw new NotFoundError('任务结算失败，任务、assignment 或钱包不存在', ErrorCode.NOT_FOUND_WALLET);
    }
    return {
      data: {
        settlementId: settlement.id,
        status: settlement.status,
        settlement: serializeWalletSettlement(settlement),
      },
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/persona-core/:id/governance-events', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = AddGovernanceEventSchema.parse(request.body);
    const detail = service.addGovernanceEvent({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
      eventType: body.eventType,
      severity: body.severity,
      summary: body.summary,
      payload: body.payload,
    });
    if (!detail) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return reply.status(201).send({ data: serializePersonaDetail(detail) });
  });

  app.post<{ Params: { id: string } }>('/api/v1/persona-core/:id/decease', async (request) => {
    const user = requireJwtUser(request);
    const body = DeceasePersonaSchema.parse(request.body);
    const detail = service.markDeceased(request.tenantId, user.sub, request.params.id, body.reason);
    if (!detail) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializePersonaDetail(detail) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/persona-core/:id/lifecycle/evaluate', async (request) => {
    const user = requireJwtUser(request);
    const body = EvaluatePersonaLifecycleSchema.parse(request.body);
    const result = service.evaluateLifecycle({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
      inactivityDays: body.inactivityDays,
    });
    if (!result) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return {
      data: {
        persona: serializePersonaDetail(result.persona),
        evaluation: {
          transition: result.transition,
          inactivityDays: result.inactivityDays,
          lastActiveAt: toIso(result.lastActiveAt),
        },
      },
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/persona-core/:id/activate', async (request) => {
    const user = requireJwtUser(request);
    const detail = service.activatePersona({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
    });
    if (!detail) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在或不可激活`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializePersonaDetail(detail) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/personas/:id/activate', async (request) => {
    const user = requireJwtUser(request);
    const detail = service.activatePersona({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
    });
    if (!detail) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在或不可激活`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializePersonaDetail(detail) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/persona-core/:id/deactivate', async (request) => {
    const user = requireJwtUser(request);
    const detail = service.deactivatePersona({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
    });
    if (!detail) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在或不可休眠`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializePersonaDetail(detail) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/personas/:id/deactivate', async (request) => {
    const user = requireJwtUser(request);
    const detail = service.deactivatePersona({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
    });
    if (!detail) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在或不可休眠`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializePersonaDetail(detail) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/persona-core/:id/transfer', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = TransferPersonaSchema.parse(request.body);
    const transfer = service.requestTransfer({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
      toOwnerUserId: body.toOwnerId,
      reason: body.reason,
    });
    if (!transfer) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在或不可转移`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return reply.status(202).send({ data: serializeTransfer(transfer) });
  });

  app.post<{ Params: { id: string } }>('/api/v1/personas/:id/transfer', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = TransferPersonaSchema.parse(request.body);
    const transfer = service.requestTransfer({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: request.params.id,
      toOwnerUserId: body.toOwnerId,
      reason: body.reason,
    });
    if (!transfer) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在或不可转移`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return reply.status(202).send({ data: serializeTransfer(transfer) });
  });

  app.get<{ Params: { id: string } }>('/api/v1/persona-core/:id/transfers', async (request) => {
    const user = requireJwtUser(request);
    const transfers = service.listTransfers(request.tenantId, user.sub, request.params.id);
    if (!transfers) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在或无权限查看转移历史`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: transfers.map(serializeTransfer) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/personas/:id/transfers', async (request) => {
    const user = requireJwtUser(request);
    const transfers = service.listTransfers(request.tenantId, user.sub, request.params.id);
    if (!transfers) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在或无权限查看转移历史`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: transfers.map(serializeTransfer) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/persona-core/:id/transfers/approve', async (request) => {
    const user = requireJwtUser(request);
    const body = ApprovePersonaTransferSchema.parse(request.body);
    const result = service.approveTransfer({
      tenantId: request.tenantId,
      personaId: request.params.id,
      transferId: body.transferId,
      approverUserId: user.sub,
    });
    if (!result) {
      throw new NotFoundError(`转移 ${body.transferId} 不存在或不可批准`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return {
      data: {
        transfer: serializeTransfer(result.transfer),
        persona: serializePersonaDetail(result.persona),
      },
    };
  });

  app.get<{ Params: { id: string } }>('/api/v1/persona-core/:id/reputation', async (request) => {
    const user = requireJwtUser(request);
    const summary = service.getReputationSummary(request.tenantId, user.sub, request.params.id);
    if (!summary) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: summary satisfies PersonaReputationSummary };
  });

  app.get<{ Params: { id: string } }>('/api/v1/personas/:id/reputation', async (request) => {
    const user = requireJwtUser(request);
    const summary = service.getReputationSummary(request.tenantId, user.sub, request.params.id);
    if (!summary) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: summary satisfies PersonaReputationSummary };
  });

  app.get<{ Params: { id: string } }>('/api/v1/persona-core/:id/reputation/history', async (request) => {
    const user = requireJwtUser(request);
    const history = service.listReputationHistory(request.tenantId, user.sub, request.params.id);
    if (!history) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return {
      data: history.map((entry) => ({
        ...(entry satisfies PersonaReputationHistoryEntry),
        createdAt: toIso(entry.createdAt),
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/v1/personas/:id/reputation/history', async (request) => {
    const user = requireJwtUser(request);
    const history = service.listReputationHistory(request.tenantId, user.sub, request.params.id);
    if (!history) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return {
      data: history.map((entry) => ({
        ...(entry satisfies PersonaReputationHistoryEntry),
        createdAt: toIso(entry.createdAt),
      })),
    };
  });

  app.get('/api/v1/marketplace/top-personas', async (request) => {
    const query = TopPersonasQuerySchema.parse(request.query);
    const rankings = service.listTopPersonas(request.tenantId, {
      category: query.category,
      limit: query.limit,
    });
    return { data: rankings satisfies PersonaRankingEntry[] };
  });

  app.post('/api/v1/marketplace/rankings/recompute', async (request) => {
    const query = TopPersonasQuerySchema.parse(request.query);
    const result = service.recomputeMarketplaceRankings(request.tenantId, {
      category: query.category,
      limit: query.limit,
    });
    return {
      data: {
        rankings: result.rankings satisfies PersonaRankingEntry[],
        materialization: serializeMaterialization(result.materialization),
      },
    };
  });

  app.get<{ Params: { id: string } }>('/api/v1/analytics/personas/:id', async (request) => {
    const user = requireJwtUser(request);
    const analytics = service.getPersonaAnalytics(request.tenantId, user.sub, request.params.id);
    if (!analytics) {
      throw new NotFoundError(`Persona Core ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: analytics satisfies PersonaAnalytics };
  });

  app.get('/api/v1/analytics/marketplace/overview', async (request) => {
    const analytics = service.getMarketplaceAnalytics(request.tenantId);
    return { data: analytics satisfies MarketplaceAnalytics };
  });

  app.get('/api/v1/analytics/economy/overview', async (request) => {
    const analytics = service.getEconomyAnalytics(request.tenantId);
    return { data: analytics satisfies EconomyAnalytics };
  });

  app.get<{ Params: { id: string } }>('/api/v1/personas/:id/governance/cases', async (request) => {
    const user = requireJwtUser(request);
    const cases = service.listGovernanceCases(request.tenantId, user.sub, request.params.id);
    if (!cases) {
      throw new NotFoundError(`Persona ${request.params.id} 不存在或无权查看治理案件`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: cases.map(serializeGovernanceCase) };
  });

  app.post('/api/v1/governance/cases', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = OpenGovernanceCaseSchema.parse(request.body);
    /*
     * 越权防御（P1）：用户直接发起的开案必须验证 persona 归属——否则任意已认证
     * 用户可对他人 persona 开治理案，触发 status/reputation 变更。内部系统自动开案
     * （如 marketplace disputeTask 由发布者对接单 persona 开案）走 service 层，不经此路由。
     */
    if (!service.personaExists(request.tenantId, user.sub, body.personaId)) {
      throw new NotFoundError(`Persona ${body.personaId} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    const governanceCase = service.openGovernanceCase({
      tenantId: request.tenantId,
      actorUserId: user.sub,
      personaId: body.personaId,
      taskId: body.taskId,
      triggerType: body.triggerType,
      severity: body.severity,
      details: body.details,
    });
    if (!governanceCase) {
      throw new NotFoundError(`Persona ${body.personaId} 不存在`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return reply.status(201).send({ data: serializeGovernanceCase(governanceCase) });
  });

  app.post<{ Params: { id: string } }>('/api/v1/governance/cases/:id/actions', async (request) => {
    const user = requireJwtUser(request);
    const body = ApplyGovernanceActionSchema.parse(request.body);
    const result = service.applyGovernanceAction({
      tenantId: request.tenantId,
      actorUserId: user.sub,
      caseId: request.params.id,
      actionType: body.actionType,
      durationSeconds: body.durationSeconds,
      details: body.details,
    });
    if (!result) {
      throw new NotFoundError(`治理案件 ${request.params.id} 不存在或不可执行动作`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return {
      data: {
        caseId: result.governanceCase.id,
        actionId: result.action.id,
        personaStatus: result.personaStatus,
        governanceCase: serializeGovernanceCase(result.governanceCase),
        action: serializeGovernanceAction(result.action),
      },
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/governance/cases/:id/appeal', async (request) => {
    const user = requireJwtUser(request);
    const body = AppealGovernanceCaseSchema.parse(request.body);
    const governanceCase = service.appealGovernanceCase({
      tenantId: request.tenantId,
      actorUserId: user.sub,
      caseId: request.params.id,
      details: body.details,
    });
    if (!governanceCase) {
      throw new NotFoundError(`治理案件 ${request.params.id} 不存在或不可申诉`, ErrorCode.NOT_FOUND_PERSONA);
    }
    return { data: serializeGovernanceCase(governanceCase) };
  });

  app.post('/api/v1/runtime/sessions', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = CreateRuntimeSessionSchema.parse(request.body);
    const session = service.createRuntimeSession({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      personaId: body.personaId,
      taskId: body.taskId,
    });
    if (!session) {
      throw new NotFoundError('无法创建 runtime session，任务或 assignment 不存在', ErrorCode.NOT_FOUND_TASK);
    }
    return reply.status(201).send({ data: serializeRuntimeSession(session) });
  });

  app.get<{ Params: { id: string } }>('/api/v1/runtime/sessions/:id', async (request) => {
    const user = requireJwtUser(request);
    const session = service.getRuntimeSession(request.tenantId, user.sub, request.params.id);
    if (!session) {
      throw new NotFoundError(`Runtime session ${request.params.id} 不存在`, ErrorCode.NOT_FOUND_TASK);
    }
    return { data: serializeRuntimeSession(session) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/runtime/sessions/:id/plan', async (request) => {
    const user = requireJwtUser(request);
    const session = service.planRuntimeSession(request.tenantId, user.sub, request.params.id);
    if (!session) {
      throw new NotFoundError(`Runtime session ${request.params.id} 不存在或不可规划`, ErrorCode.NOT_FOUND_TASK);
    }
    return { data: serializeRuntimeSession(session) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/runtime/sessions/:id/execute', async (request) => {
    const user = requireJwtUser(request);
    const session = service.executeRuntimeSession(request.tenantId, user.sub, request.params.id);
    if (!session) {
      throw new NotFoundError(`Runtime session ${request.params.id} 不存在或不可执行`, ErrorCode.NOT_FOUND_TASK);
    }
    return { data: serializeRuntimeSession(session) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/runtime/sessions/:id/evaluate', async (request) => {
    const user = requireJwtUser(request);
    const session = service.evaluateRuntimeSession(request.tenantId, user.sub, request.params.id);
    if (!session) {
      throw new NotFoundError(`Runtime session ${request.params.id} 不存在或不可评估`, ErrorCode.NOT_FOUND_TASK);
    }
    return { data: serializeRuntimeSession(session) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/runtime/sessions/:id/complete', async (request) => {
    const user = requireJwtUser(request);
    const session = service.completeRuntimeSession(request.tenantId, user.sub, request.params.id);
    if (!session) {
      throw new NotFoundError(`Runtime session ${request.params.id} 不存在或不可完成`, ErrorCode.NOT_FOUND_TASK);
    }
    return { data: serializeRuntimeSession(session) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/apply', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = ApplyTaskSchema.parse(request.body);
    const existing = service.findTaskApplication(request.tenantId, request.params.id, body.personaId);
    if (existing) {
      throw new StateError(`任务 ${request.params.id} 已存在该 persona 的申请`, ErrorCode.STATE_ALREADY_EXISTS);
    }
    const application = service.applyToTask({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      taskId: request.params.id,
      personaId: body.personaId,
    });
    if (!application) {
      throw new NotFoundError(`任务 ${request.params.id} 不存在或不可申请`, ErrorCode.NOT_FOUND_TASK);
    }
    return reply.status(202).send({ data: serializeTaskApplication(application) });
  });

  /* GET 列某工单的 persona 申请者（含 display_name）——发布者据此选委派给哪个数字人格（ADR-0058）。 */
  app.get<{ Params: { id: string } }>('/api/v1/tasks/:id/applicants', async (request) => {
    requireJwtUser(request);
    const applicants = service.listTaskApplicants(request.tenantId, request.params.id);
    return { data: applicants };
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/assign', async (request) => {
    const user = requireJwtUser(request);
    const body = AssignTaskSchema.parse(request.body);
    const assignment = service.assignTask({
      tenantId: request.tenantId,
      actorUserId: user.sub,
      taskId: request.params.id,
      personaId: body.personaId,
    });
    if (!assignment) {
      throw new NotFoundError(`任务 ${request.params.id} 不存在、无申请记录或不可指派`, ErrorCode.NOT_FOUND_TASK);
    }
    return { data: serializeTaskAssignment(assignment) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/submit', async (request) => {
    const user = requireJwtUser(request);
    const body = SubmitTaskResultSchema.parse(request.body);
    const result = service.submitTaskResult({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      taskId: request.params.id,
      assignmentId: body.assignmentId,
      resultUri: body.resultUri,
      evaluation: body.evaluation,
    });
    if (!result) {
      throw new NotFoundError(`任务 ${request.params.id} 不存在或不可提交`, ErrorCode.NOT_FOUND_TASK);
    }
    return {
      data: {
        taskId: request.params.id,
        status: 'submitted' as const,
        result: serializeTaskResult(result),
      },
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/accept', async (request) => {
    const user = requireJwtUser(request);
    const body = AcceptSubmittedTaskSchema.parse(request.body);
    const result = service.acceptSubmittedTask({
      tenantId: request.tenantId,
      actorUserId: user.sub,
      taskId: request.params.id,
      clientRating: body.clientRating,
      qualityScore: body.qualityScore,
    });
    if (!result) {
      throw new NotFoundError(`任务 ${request.params.id} 不存在或不可验收`, ErrorCode.NOT_FOUND_TASK);
    }
    return {
      data: {
        taskId: request.params.id,
        status: 'accepted' as const,
        settlementStatus: 'queued' as const,
        assignment: serializeTaskAssignment(result.assignment),
        result: serializeTaskResult(result.result),
        task: serializeTask(result.task),
      },
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/reject', async (request) => {
    const user = requireJwtUser(request);
    const body = RejectTaskSchema.parse(request.body);
    const result = service.rejectSubmittedTask({
      tenantId: request.tenantId,
      actorUserId: user.sub,
      taskId: request.params.id,
      reason: body.reason,
    });
    if (!result) {
      throw new NotFoundError(`任务 ${request.params.id} 不存在或不可拒绝`, ErrorCode.NOT_FOUND_TASK);
    }
    return {
      data: {
        taskId: request.params.id,
        status: 'rejected' as const,
        assignment: serializeTaskAssignment(result.assignment),
        result: serializeTaskResult(result.result),
        task: serializeTask(result.task),
      },
    };
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/dispute', async (request) => {
    const user = requireJwtUser(request);
    const body = DisputeTaskSchema.parse(request.body);
    const result = service.disputeTask({
      tenantId: request.tenantId,
      actorUserId: user.sub,
      taskId: request.params.id,
      reason: body.reason,
    });
    if (!result) {
      throw new NotFoundError(`任务 ${request.params.id} 不存在或不可发起争议`, ErrorCode.NOT_FOUND_TASK);
    }
    return {
      data: {
        taskId: request.params.id,
        status: 'disputed' as const,
        assignment: serializeTaskAssignment(result.assignment),
        result: result.result ? serializeTaskResult(result.result) : null,
        governanceCase: serializeGovernanceCase(result.governanceCase),
        task: serializeTask(result.task),
      },
    };
  });

  app.get('/api/v1/marketplace/tasks', async (request) => {
    const rawStatus = (request.query as { status?: string } | undefined)?.status;
    const status = rawStatus ?? undefined;
    if (status && !['open', 'accepted', 'completed', 'cancelled'].includes(status)) {
      throw new ValidationError(`无效任务状态: ${status}`, ErrorCode.VALIDATION_FORMAT);
    }
    const tasks = service.listMarketplaceTasks(request.tenantId, status as 'open' | 'accepted' | 'completed' | 'cancelled' | undefined);
    return { data: tasks.map(serializeTask) };
  });

  app.get('/api/v1/tasks', async (request) => {
    const rawStatus = (request.query as { status?: string } | undefined)?.status;
    const status = rawStatus ?? undefined;
    if (status && !['open', 'accepted', 'completed', 'cancelled'].includes(status)) {
      throw new ValidationError(`无效任务状态: ${status}`, ErrorCode.VALIDATION_FORMAT);
    }
    const tasks = service.listMarketplaceTasks(request.tenantId, status as 'open' | 'accepted' | 'completed' | 'cancelled' | undefined);
    return { data: tasks.map(serializeTask) };
  });

  app.post('/api/v1/marketplace/tasks', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = PublishMarketplaceTaskSchema.parse(request.body);
    const task = service.publishTask({
      tenantId: request.tenantId,
      publisherUserId: user.sub,
      title: body.title,
      description: body.description,
      category: body.category,
      reward: body.reward,
      currency: body.currency,
    });
    return reply.status(201).send({ data: serializeTask(task) });
  });

  app.post('/api/v1/tasks', async (request, reply) => {
    const user = requireJwtUser(request);
    const body = PublishMarketplaceTaskSchema.parse(request.body);
    const task = service.publishTask({
      tenantId: request.tenantId,
      publisherUserId: user.sub,
      title: body.title,
      description: body.description,
      category: body.category,
      reward: body.reward,
      currency: body.currency,
    });
    return reply.status(201).send({ data: serializeTask(task) });
  });

  app.post<{ Params: { id: string } }>('/api/v1/marketplace/tasks/:id/accept', async (request) => {
    const user = requireJwtUser(request);
    const body = AcceptMarketplaceTaskSchema.parse(request.body);
    const task = service.acceptTask({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      taskId: request.params.id,
      personaId: body.personaId,
      forkId: body.forkId,
    });
    if (!task) {
      throw new NotFoundError(`市场任务 ${request.params.id} 不存在或不可接受`, ErrorCode.NOT_FOUND_TASK);
    }
    return { data: serializeTask(task) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/marketplace/tasks/:id/complete', async (request) => {
    const user = requireJwtUser(request);
    const body = CompleteMarketplaceTaskSchema.parse(request.body);
    const result = service.completeTask({
      tenantId: request.tenantId,
      ownerUserId: user.sub,
      taskId: request.params.id,
      qualityScore: body.qualityScore,
      ownerTrainingHours: body.ownerTrainingHours,
    });
    if (!result) {
      throw new NotFoundError(`市场任务 ${request.params.id} 不存在或不可完成`, ErrorCode.NOT_FOUND_TASK);
    }
    /* earn→distill 闭环（WP-0）：完成后触发回调，宿主经蒸馏门把高质量 outcome 蒸馏进 core values。
     * best-effort——蒸馏失败不影响任务完成的返回（钱/声誉已落库）。 */
    if (onTaskCompleted) {
      try {
        onTaskCompleted({
          tenantId: request.tenantId,
          personaId: result.persona.id,
          taskId: result.task.id,
          category: result.task.category,
          /* qualityScore 用入参（service 正是用它结算的，即结算事实）。 */
          qualityScore: body.qualityScore,
          /* payout 用结算公式（与 service completeTask 一致：reward * max(quality, 0.2)），而非临时重算。 */
          payout: Math.round(result.task.reward * Math.max(body.qualityScore, 0.2) * 100) / 100,
        });
      } catch (err) {
        /* 蒸馏触发失败不阻断任务完成，但记录可观测（不含敏感 payload），否则闭环失效不可见。 */
        app.log.warn(
          { tenantId: request.tenantId, taskId: result.task.id, personaId: result.persona.id, err: err instanceof Error ? err.message : String(err) },
          'earn→distill 回调失败（任务已完成，蒸馏未触发）',
        );
      }
    }
    return {
      data: {
        task: serializeTask(result.task),
        wallet: serializeWallet(result.wallet),
        persona: serializePersonaDetail(result.persona),
      },
    };
  });
}
