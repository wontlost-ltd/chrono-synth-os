export type PersonaCoreStatus = 'draft' | 'active' | 'restricted' | 'suspended' | 'dormant' | 'deceased' | 'transferred';
export type PersonaVisibility = 'private' | 'shared' | 'marketplace';
export type PersonaForkType = 'experimental' | 'task' | 'social' | 'research' | 'operations';
export type PersonaForkStatus = 'active' | 'recycled' | 'archived';
export type PersonaForkSyncMode = 'core' | 'isolated';
export type PersonaMemoryKind = 'interaction' | 'task' | 'training' | 'knowledge' | 'governance';
export type PersonaMemorySensitivity = 'private' | 'encrypted' | 'owner-restricted';
export type PersonaCognitiveMemoryKind = 'episodic' | 'semantic' | 'procedural';
export type PersonaGrowthEventType = 'task_completed' | 'training' | 'knowledge_sync' | 'governance';
export type PersonaGovernanceEventType = 'warning' | 'reward' | 'restriction' | 'review' | 'transfer' | 'death';
export type MarketplaceTaskCategory = 'writing' | 'coding' | 'research' | 'operations' | 'general';
export type MarketplaceTaskStatus = 'open' | 'accepted' | 'completed' | 'cancelled';
export type TaskApplicationStatus = 'submitted' | 'assigned' | 'rejected' | 'withdrawn';
export type TaskAssignmentStatus = 'assigned' | 'in_progress' | 'submitted' | 'accepted' | 'rejected' | 'disputed' | 'completed';
export type TaskResultStatus = 'submitted' | 'accepted' | 'rejected' | 'disputed';
export type RuntimeSessionState =
  | 'PLAN'
  | 'EXECUTE'
  | 'EVALUATE'
  | 'MEMORY_UPDATE'
  | 'REPUTATION_UPDATE'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'ERROR';
export type PersonaTransferStatus = 'pending_review' | 'approved' | 'completed' | 'rejected' | 'cancelled';
export type WalletTransactionType = 'task_payment' | 'platform_fee' | 'owner_payout' | 'persona_reserve' | 'refund';
export type WalletPayoutStatus = 'completed' | 'rejected';
export type WalletSettlementStatus = 'completed';
export type GovernanceCaseSeverity = 'low' | 'medium' | 'high' | 'critical';
export type GovernanceCaseStatus = 'open' | 'action_applied' | 'appealed' | 'resolved';
export type GovernanceActionType =
  | 'warning'
  | 'temporary_restriction'
  | 'temporary_suspension'
  | 'reinstate'
  | 'termination';

export interface PersonaCore {
  id: string;
  tenantId: string;
  ownerUserId: string;
  displayName: string;
  profile: Record<string, unknown>;
  status: PersonaCoreStatus;
  visibility: PersonaVisibility;
  growthIndex: number;
  reputation: number;
  trainingInvestment: number;
  createdAt: number;
  updatedAt: number;
  deceasedAt: number | null;
  transferredAt: number | null;
}

export interface PersonaWallet {
  id: string;
  tenantId: string;
  personaId: string;
  walletAddress: string;
  balance: number;
  tokenBalance: number;
  currency: string;
  status: 'active' | 'frozen';
  lastSettledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WalletTransaction {
  id: string;
  tenantId: string;
  walletId: string;
  transactionType: WalletTransactionType;
  amountMinor: number;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: number;
}

export interface WalletPayoutRequest {
  id: string;
  tenantId: string;
  walletId: string;
  amountMinor: number;
  currency: string;
  status: WalletPayoutStatus;
  requestedByUserId: string;
  createdAt: number;
  completedAt: number | null;
}

export interface TaskWalletSettlement {
  id: string;
  tenantId: string;
  walletId: string;
  taskId: string;
  assignmentId: string;
  totalAmountMinor: number;
  currency: string;
  ownerPct: number;
  personaPct: number;
  platformPct: number;
  ownerAmountMinor: number;
  personaAmountMinor: number;
  platformAmountMinor: number;
  status: WalletSettlementStatus;
  createdAt: number;
  completedAt: number | null;
}

export interface PersonaFork {
  id: string;
  tenantId: string;
  personaId: string;
  label: string;
  forkType: PersonaForkType;
  status: PersonaForkStatus;
  syncMode: PersonaForkSyncMode;
  experienceFactor: number;
  createdAt: number;
  updatedAt: number;
  recycledAt: number | null;
}

export interface PersonaMemory {
  id: string;
  tenantId: string;
  personaId: string;
  forkId: string | null;
  kind: PersonaMemoryKind;
  sensitivity: PersonaMemorySensitivity;
  isEncrypted: boolean;
  ownerRestricted: boolean;
  summary: string;
  content: Record<string, unknown>;
  importance: number;
  createdAt: number;
  updatedAt: number;
}

export interface PersonaCognitiveMemory {
  id: string;
  tenantId: string;
  personaId: string;
  forkId: string | null;
  sourceMemoryId: string | null;
  knowledgeItemId: string | null;
  kind: PersonaCognitiveMemoryKind;
  content: string;
  valence: number;
  salience: number;
  accessCount: number;
  decayLambda: number;
  lastAccessedAt: number;
  lastDecayedAt: number;
  consolidatedFrom: string | null;
  createdAt: number;
}

export interface PersonaCognitiveEdge {
  tenantId: string;
  personaId: string;
  source: string;
  target: string;
  strength: number;
  relation: string;
}

export interface PersonaWorkingMemorySlot {
  memoryId: string;
  score: number;
  enteredAt: number;
}

export interface PersonaWorkingMemoryEntry {
  slot: PersonaWorkingMemorySlot;
  memory: PersonaCognitiveMemory | null;
}

export interface PersonaCognitiveState {
  totalMemories: number;
  totalEdges: number;
  workingMemory: PersonaWorkingMemoryEntry[];
  recentExperiences: PersonaCognitiveMemory[];
  semanticKnowledge: PersonaCognitiveMemory[];
  proceduralMemory: PersonaCognitiveMemory[];
}

export interface PersonaKnowledgeItem {
  id: string;
  tenantId: string;
  personaId: string;
  title: string;
  content: string;
  source: string;
  tags: string[];
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface PersonaGrowthEvent {
  id: string;
  tenantId: string;
  personaId: string;
  taskId: string | null;
  eventType: PersonaGrowthEventType;
  growthDelta: number;
  reputationDelta: number;
  trainingDelta: number;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface PersonaGovernanceEvent {
  id: string;
  tenantId: string;
  personaId: string;
  eventType: PersonaGovernanceEventType;
  severity: number;
  summary: string;
  payload: Record<string, unknown>;
  actorUserId: string | null;
  createdAt: number;
}

export interface MarketplaceTask {
  id: string;
  tenantId: string;
  publisherUserId: string;
  assigneePersonaId: string | null;
  assigneeForkId: string | null;
  assigneePersonaName: string | null;
  title: string;
  description: string;
  category: MarketplaceTaskCategory;
  reward: number;
  currency: string;
  status: MarketplaceTaskStatus;
  qualityScore: number | null;
  growthDelta: number | null;
  publishedAt: number;
  acceptedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskApplication {
  id: string;
  tenantId: string;
  taskId: string;
  personaId: string;
  rankingScore: number;
  status: TaskApplicationStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TaskAssignment {
  id: string;
  tenantId: string;
  taskId: string;
  personaId: string;
  applicationId: string | null;
  runtimeSessionId: string | null;
  status: TaskAssignmentStatus;
  assignedAt: number;
  startedAt: number | null;
  submittedAt: number | null;
  completedAt: number | null;
}

export interface TaskResult {
  id: string;
  tenantId: string;
  taskId: string;
  assignmentId: string;
  resultUri: string;
  evaluation: Record<string, unknown>;
  qualityScore: number | null;
  clientRating: number | null;
  status: TaskResultStatus;
  rejectionReason: string | null;
  createdAt: number;
  updatedAt: number;
  acceptedAt: number | null;
  rejectedAt: number | null;
  disputedAt: number | null;
}

export interface RuntimeSession {
  id: string;
  tenantId: string;
  personaId: string;
  taskId: string;
  assignmentId: string | null;
  state: RuntimeSessionState;
  retryCount: number;
  timeoutAt: number | null;
  plan: { steps: string[] } | null;
  artifacts: Array<{ type: string; uri: string }>;
  evaluation: Record<string, unknown> | null;
  resultSummary: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface GovernanceCase {
  id: string;
  tenantId: string;
  personaId: string;
  taskId: string | null;
  triggerType: string;
  severity: GovernanceCaseSeverity;
  status: GovernanceCaseStatus;
  details: Record<string, unknown>;
  appeal: Record<string, unknown> | null;
  openedAt: number;
  resolvedAt: number | null;
  appealedAt: number | null;
}

export interface GovernanceAction {
  id: string;
  tenantId: string;
  caseId: string;
  actionType: GovernanceActionType;
  durationSeconds: number | null;
  details: Record<string, unknown>;
  actorUserId: string | null;
  createdAt: number;
}

export interface PersonaCoreSummary extends PersonaCore {
  wallet: PersonaWallet;
  stats: {
    activeForks: number;
    memoryCount: number;
    knowledgeCount: number;
    activeTaskCount: number;
  };
}

export interface PersonaCoreDetail extends PersonaCoreSummary {
  forks: PersonaFork[];
  recentMemories: PersonaMemory[];
  knowledgeItems: PersonaKnowledgeItem[];
  growthEvents: PersonaGrowthEvent[];
  governanceEvents: PersonaGovernanceEvent[];
  marketplaceTasks: MarketplaceTask[];
}

export interface PersonaOperatingState {
  persona: PersonaCoreDetail;
  cognitive: PersonaCognitiveState;
}

export interface PersonaLifecycleEvaluation {
  persona: PersonaCoreDetail;
  transition: 'none' | 'dormant' | 'reactivated' | 'deceased';
  inactivityDays: number;
  lastActiveAt: number;
}

export interface PersonaTransfer {
  id: string;
  tenantId: string;
  personaId: string;
  fromOwnerUserId: string;
  toOwnerUserId: string;
  status: PersonaTransferStatus;
  reason: string;
  requestedAt: number;
  approvedAt: number | null;
  completedAt: number | null;
}

export interface PersonaReputationSummary {
  personaId: string;
  score: number;
  summary: {
    successfulTasks: number;
    disputes: number;
    governancePenalties: number;
  };
}

export interface PersonaReputationHistoryEntry {
  id: string;
  tenantId: string;
  personaId: string;
  oldScore: number;
  newScore: number;
  reason: string;
  createdAt: number;
}

export interface PersonaRankingEntry {
  personaId: string;
  name: string;
  score: number;
  reputationScore: number;
  growthIndex: number;
  category: MarketplaceTaskCategory | 'all';
}

export interface PersonaAnalytics {
  personaId: string;
  growthIndex: number;
  tasksCompleted: number;
  walletBalance: number;
  walletTokenBalance: number;
  reputationScore: number;
  memoryCount: number;
  governanceEvents: number;
}

export interface MarketplaceAnalytics {
  openTasks: number;
  activePersonas: number;
  completedTasks7d: number;
  grossVolume: number;
}

export interface EconomyAnalytics {
  grossRevenueMinor: number;
  ownerPayoutsMinor: number;
  platformFeesMinor: number;
  personaReservesMinor: number;
  payoutRequests: number;
  settlementCount: number;
  transactionCount: number;
}

export interface DailyAnalyticsMaterialization {
  metricDate: string;
  personaRows: number;
  marketplaceRows: number;
}

export interface PersonaMemorySearchResult {
  memoryId: string;
  score: number;
  contentText: string;
  createdAt: number;
}

export interface PersonaGraphSummary {
  totalNodes: number;
  totalEdges: number;
  workingMemorySize: number;
  memoryKindCounts: Record<PersonaCognitiveMemoryKind, number>;
  relationCounts: Record<string, number>;
}

export interface PersonaGraphQueryInput {
  memoryId?: string;
  kind?: PersonaCognitiveMemoryKind;
  relation?: string;
  limit?: number;
}

export interface PersonaGraphQueryResult {
  nodes: PersonaCognitiveMemory[];
  edges: PersonaCognitiveEdge[];
}

export interface CreatePersonaCoreInput {
  tenantId: string;
  ownerUserId: string;
  displayName: string;
  profile?: Record<string, unknown>;
  visibility?: PersonaVisibility;
  initialKnowledge?: Array<{
    title: string;
    content: string;
    source?: string;
    tags?: string[];
    confidence?: number;
  }>;
}

export interface CreatePersonaForkInput {
  tenantId: string;
  ownerUserId: string;
  personaId: string;
  label: string;
  forkType?: PersonaForkType;
  syncMode?: PersonaForkSyncMode;
  experienceFactor?: number;
}

export interface AddPersonaMemoryInput {
  tenantId: string;
  ownerUserId: string;
  personaId: string;
  forkId?: string;
  kind: PersonaMemoryKind;
  sensitivity?: PersonaMemorySensitivity;
  summary: string;
  content?: Record<string, unknown>;
  importance?: number;
}

export interface AddPersonaKnowledgeInput {
  tenantId: string;
  ownerUserId: string;
  personaId: string;
  title: string;
  content: string;
  source?: string;
  tags?: string[];
  confidence?: number;
  fingerprint?: string;
}

export interface AddGovernanceEventInput {
  tenantId: string;
  ownerUserId: string;
  personaId: string;
  eventType: PersonaGovernanceEventType;
  severity: number;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface EvaluatePersonaLifecycleInput {
  tenantId: string;
  ownerUserId: string;
  personaId: string;
  inactivityDays?: number;
}

export interface SetPersonaStatusInput {
  tenantId: string;
  ownerUserId: string;
  personaId: string;
}

export interface RequestPersonaTransferInput {
  tenantId: string;
  ownerUserId: string;
  personaId: string;
  toOwnerUserId: string;
  reason?: string;
}

export interface ApprovePersonaTransferInput {
  tenantId: string;
  personaId: string;
  transferId: string;
  approverUserId: string;
}

export interface PublishMarketplaceTaskInput {
  tenantId: string;
  publisherUserId: string;
  title: string;
  description: string;
  category?: MarketplaceTaskCategory;
  reward: number;
  currency?: string;
}

export interface AcceptMarketplaceTaskInput {
  tenantId: string;
  ownerUserId: string;
  taskId: string;
  personaId: string;
  forkId?: string;
}

export interface CompleteMarketplaceTaskInput {
  tenantId: string;
  ownerUserId: string;
  taskId: string;
  qualityScore: number;
  ownerTrainingHours?: number;
}

export interface ApplyTaskInput {
  tenantId: string;
  ownerUserId: string;
  taskId: string;
  personaId: string;
}

export interface AssignTaskInput {
  tenantId: string;
  actorUserId: string;
  taskId: string;
  personaId: string;
}

export interface CreateRuntimeSessionInput {
  tenantId: string;
  ownerUserId: string;
  personaId: string;
  taskId: string;
}

export interface SubmitTaskResultInput {
  tenantId: string;
  ownerUserId: string;
  taskId: string;
  assignmentId: string;
  resultUri: string;
  evaluation?: Record<string, unknown>;
}

export interface AcceptSubmittedTaskInput {
  tenantId: string;
  actorUserId: string;
  taskId: string;
  clientRating: number;
  qualityScore: number;
}

export interface RejectSubmittedTaskInput {
  tenantId: string;
  actorUserId: string;
  taskId: string;
  reason: string;
}

export interface DisputeTaskInput {
  tenantId: string;
  actorUserId: string;
  taskId: string;
  reason: string;
}

export interface OpenGovernanceCaseInput {
  tenantId: string;
  actorUserId: string;
  personaId: string;
  triggerType: string;
  severity: GovernanceCaseSeverity;
  taskId?: string;
  details?: Record<string, unknown>;
}

export interface ApplyGovernanceActionInput {
  tenantId: string;
  actorUserId: string;
  caseId: string;
  actionType: GovernanceActionType;
  durationSeconds?: number;
  details?: Record<string, unknown>;
}

export interface AppealGovernanceCaseInput {
  tenantId: string;
  actorUserId: string;
  caseId: string;
  details?: Record<string, unknown>;
}

export interface RequestWalletPayoutInput {
  tenantId: string;
  ownerUserId: string;
  walletId: string;
  amountMinor: number;
}

export interface SettleTaskPaymentInput {
  tenantId: string;
  actorUserId: string;
  taskId: string;
  assignmentId: string;
  totalAmountMinor: number;
  currency: string;
  split: {
    ownerPct: number;
    personaPct: number;
    platformPct: number;
  };
}
