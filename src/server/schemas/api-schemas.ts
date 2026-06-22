/**
 * API 请求/响应 Zod Schema 定义
 */

import { z } from 'zod';
import { PERSONALITY_ARCHETYPES } from '@chrono/kernel';
export {
  ConflictInboxItemV1Schema,
  ConflictResolveRequestV1Schema,
  ConflictResolveResultV1Schema,
} from '@chrono/contracts';

/* 价值管理 */
export const CreateValueSchema = z.object({
  label: z.string().min(1),
  weight: z.number().min(0).max(1),
  timeDiscount: z.number().min(0).max(1).default(0.5),
  emotionAmplifier: z.number().min(0.5).max(2).default(1.0),
});

export const UpdateValueSchema = z.object({
  weight: z.number().min(0).max(1).optional(),
  timeDiscount: z.number().min(0).max(1).optional(),
  emotionAmplifier: z.number().min(0.5).max(2).optional(),
});

/* 记忆管理 */
export const MemorySourceKindSchema = z.enum(['user_input', 'api_sync', 'system_inferred', 'unknown']).default('unknown');
export type MemorySourceKind = z.infer<typeof MemorySourceKindSchema>;

export const CreateMemorySchema = z.object({
  kind: z.enum(['episodic', 'semantic', 'procedural']),
  content: z.string().min(1),
  valence: z.number().min(-1).max(1),
  salience: z.number().min(0).max(1),
  sourceKind: z.enum(['user_input', 'api_sync', 'system_inferred', 'unknown']).default('user_input'),
});

export const LinkMemorySchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.string().min(1),
  strength: z.number().min(0).max(1),
});

/* 认知记忆 */
export const RelatedMemoryQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(5).default(2),
});

/* 叙事管理 */
export const UpdateNarrativeSchema = z.object({
  content: z.string().min(1),
});

/* 人格管理 */
export const ForkPersonaSchema = z.object({
  label: z.string().min(1),
  resourceQuota: z.number().min(0).max(1).default(0.2),
});

/* 岗位人格模板（P1-A） */
const TemplateValueAnchorSchema = z.object({
  label: z.string().min(1),
  weight: z.number().min(0).max(1),
});

const TemplateBehaviorBoundarySchema = z.object({
  rule: z.enum(['never_discuss', 'always_escalate', 'require_confirmation']),
  topic: z.string().min(1),
});

const TemplateCategorySchema = z.enum([
  'customer_service', 'engineer', 'legal', 'sales', 'hr', 'finance',
]);

export const CreatePersonaTemplateSchema = z.object({
  category: TemplateCategorySchema,
  label: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  defaultValues: z.array(TemplateValueAnchorSchema).max(50).optional(),
  defaultNarrative: z.string().max(4000).optional(),
  behaviorBoundaries: z.array(TemplateBehaviorBoundarySchema).max(50).optional(),
  requiredKnowledgeCategories: z.array(z.string().min(1).max(120)).max(50).optional(),
});

export const PatchPersonaTemplateSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  defaultValues: z.array(TemplateValueAnchorSchema).max(50).optional(),
  defaultNarrative: z.string().max(4000).optional(),
  behaviorBoundaries: z.array(TemplateBehaviorBoundarySchema).max(50).optional(),
  requiredKnowledgeCategories: z.array(z.string().min(1).max(120)).max(50).optional(),
});

export const InstantiatePersonaTemplateSchema = z.object({
  displayName: z.string().min(1).max(120),
  ownerUserId: z.string().min(1).optional(),
  overrideValues: z.array(TemplateValueAnchorSchema).max(50).optional(),
  overrideNarrative: z.string().max(4000).optional(),
  /** 用于渲染模板文案中 {{variable}} 占位符的键值映射；缺失变量保留原占位符 */
  templateVariables: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
  initialKnowledge: z.array(z.object({
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(8000),
    source: z.string().max(120).optional(),
    tags: z.array(z.string().max(60)).max(20).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })).max(20).optional(),
});

/* P1-B 知识批量导入 */
const BulkImportSourceSchema = z.object({
  kind: z.enum(['text', 'url', 'file']),
  /** text: 直接内容；url: HTTP(S) URL；file: 调用方已解码的文本 */
  content: z.string().min(1).max(5 * 1024 * 1024),
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(120).optional(),
  fingerprint: z.string().min(8).max(128).optional(),
});

export const BulkKnowledgeImportSchema = z.object({
  sources: z.array(BulkImportSourceSchema).min(1).max(500),
  deduplicateStrategy: z.enum(['skip', 'overwrite']).default('skip'),
  /** 可选：关联到一个岗位人格模板。若提供，service 会用模板的
   *  requiredKnowledgeCategories 校验每条 source.category 是否匹配，
   *  不匹配仅累计计数（不阻断导入）。 */
  expectedTemplateId: z.string().min(1).max(120).optional(),
});

/* P1-C 对话接入 */
const ConversationHistoryEntrySchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});

export const ConversationMessageRequestSchema = z.object({
  sessionId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120),
  externalUserId: z.string().min(1).max(120),
  content: z.string().min(1).max(8000),
  history: z.array(ConversationHistoryEntrySchema).max(20).optional(),
  metadata: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
  confirmationToken: z.string().min(1).max(120).optional(),
  retentionClass: z.enum(['standard', 'extended', 'litigation_hold']).optional(),
});

export const SimulatePersonaSchema = z.object({
  personaId: z.string().min(1),
  scenario: z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
});

export const UpdatePersonaStatusSchema = z.object({
  status: z.enum(['active', 'paused', 'completed', 'failed']),
});

/* Persona Core 2.0 */
export const CreatePersonaCoreSchema = z.object({
  displayName: z.string().min(1).max(120),
  visibility: z.enum(['private', 'shared', 'marketplace']).default('private'),
  profile: z.record(z.string(), z.unknown()).default({}),
  initialKnowledge: z.array(z.object({
    title: z.string().min(1).max(160),
    content: z.string().min(1).max(10_000),
    source: z.string().min(1).max(160).optional(),
    tags: z.array(z.string().min(1).max(80)).max(20).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })).max(20).default([]),
});

export const CreatePersonaCoreForkSchema = z.object({
  label: z.string().min(1).max(120),
  forkType: z.enum(['experimental', 'task', 'social', 'research', 'operations']).default('experimental'),
  syncMode: z.enum(['core', 'isolated']).default('core'),
  experienceFactor: z.number().min(0).max(2).default(1),
});

export const AddPersonaMemorySchema = z.object({
  forkId: z.string().min(1).optional(),
  kind: z.enum(['interaction', 'task', 'training', 'knowledge', 'governance']),
  sensitivity: z.enum(['private', 'encrypted', 'owner-restricted']).default('private'),
  summary: z.string().min(1).max(500),
  content: z.record(z.string(), z.unknown()).default({}),
  importance: z.number().min(0).max(1).default(0.5),
});

export const CreatePersonaMemoryRecordSchema = z.object({
  personaId: z.string().min(1).optional(),
  persona_id: z.string().min(1).optional(),
  memoryType: z.string().min(1).max(120).optional(),
  memory_type: z.string().min(1).max(120).optional(),
  contentText: z.string().min(1).max(10_000).optional(),
  content_text: z.string().min(1).max(10_000).optional(),
  sourceType: z.string().min(1).max(120).optional(),
  source_type: z.string().min(1).max(120).optional(),
  sourceId: z.string().min(1).max(160).optional(),
  source_id: z.string().min(1).max(160).optional(),
  sensitivity: z.enum(['private', 'encrypted', 'owner-restricted']).default('private'),
}).refine((value) => Boolean(value.personaId ?? value.persona_id), {
  message: 'personaId/persona_id 必填',
  path: ['personaId'],
}).refine((value) => Boolean(value.memoryType ?? value.memory_type), {
  message: 'memoryType/memory_type 必填',
  path: ['memoryType'],
}).refine((value) => Boolean(value.contentText ?? value.content_text), {
  message: 'contentText/content_text 必填',
  path: ['contentText'],
});

export const PersonaMemoryListQuerySchema = z.object({
  kind: z.enum(['interaction', 'task', 'training', 'knowledge', 'governance']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
});

export const PersonaMemorySearchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(5),
});

export const PersonaGraphQuerySchema = z.object({
  memoryId: z.string().min(1).optional(),
  kind: z.enum(['episodic', 'semantic', 'procedural']).optional(),
  relation: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(50).default(12),
});

export const AddPersonaKnowledgeSchema = z.object({
  title: z.string().min(1).max(160),
  content: z.string().min(1).max(10_000),
  source: z.string().min(1).max(160).default('manual'),
  tags: z.array(z.string().min(1).max(80)).max(20).default([]),
  confidence: z.number().min(0).max(1).default(0.75),
});

export const AddGovernanceEventSchema = z.object({
  eventType: z.enum(['warning', 'reward', 'restriction', 'review', 'transfer', 'death']),
  severity: z.number().int().min(1).max(5).default(1),
  summary: z.string().min(1).max(300),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const DeceasePersonaSchema = z.object({
  reason: z.string().min(1).max(300).default('owner-request'),
});

export const EvaluatePersonaLifecycleSchema = z.object({
  inactivityDays: z.number().int().min(30).max(3650).default(180),
});

export const TransferPersonaSchema = z.object({
  toOwnerId: z.string().min(1),
  reason: z.string().min(1).max(300).default('asset sale'),
});

export const ApprovePersonaTransferSchema = z.object({
  transferId: z.string().min(1),
});

export const TopPersonasQuerySchema = z.object({
  category: z.enum(['writing', 'coding', 'research', 'operations', 'general']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const PublishMarketplaceTaskSchema = z.object({
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(5000),
  category: z.enum(['writing', 'coding', 'research', 'operations', 'general']).default('general'),
  reward: z.number().min(0),
  currency: z.string().min(1).max(16).default('CRED'),
});

export const AcceptMarketplaceTaskSchema = z.object({
  personaId: z.string().min(1),
  forkId: z.string().min(1).optional(),
});

export const CompleteMarketplaceTaskSchema = z.object({
  qualityScore: z.number().min(0).max(1),
  ownerTrainingHours: z.number().min(0).max(10_000).default(0),
});

export const ApplyTaskSchema = z.object({
  personaId: z.string().min(1),
});

export const AssignTaskSchema = z.object({
  personaId: z.string().min(1),
});

export const CreateRuntimeSessionSchema = z.object({
  personaId: z.string().min(1),
  taskId: z.string().min(1),
});

export const SubmitTaskResultSchema = z.object({
  assignmentId: z.string().min(1),
  resultUri: z.string().min(1),
  evaluation: z.object({
    summary: z.string().min(1).max(1000).optional(),
  }).catchall(z.unknown()).default({}),
});

export const AcceptSubmittedTaskSchema = z.object({
  clientRating: z.number().int().min(1).max(5),
  qualityScore: z.number().min(0).max(1),
});

export const RejectTaskSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const DisputeTaskSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const OpenGovernanceCaseSchema = z.object({
  personaId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  triggerType: z.string().min(1).max(120),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const ApplyGovernanceActionSchema = z.object({
  actionType: z.enum(['warning', 'temporary_restriction', 'temporary_suspension', 'reinstate', 'termination']),
  durationSeconds: z.number().int().min(1).max(10 * 365 * 24 * 60 * 60).optional(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const AppealGovernanceCaseSchema = z.object({
  details: z.record(z.string(), z.unknown()).default({}),
});

export const WalletPayoutSchema = z.object({
  amountMinor: z.number().int().min(1),
});

export const WalletSettlementTaskSchema = z.object({
  taskId: z.string().min(1),
  assignmentId: z.string().min(1),
  totalAmountMinor: z.number().int().min(1),
  currency: z.string().min(1).max(16),
  split: z.object({
    ownerPct: z.number().int().min(0).max(100),
    personaPct: z.number().int().min(0).max(100),
    platformPct: z.number().int().min(0).max(100),
  }),
}).refine((value) => value.split.ownerPct + value.split.personaPct + value.split.platformPct === 100, {
  message: 'split 百分比分配必须等于 100',
  path: ['split'],
});

/* 快照管理 */
export const CreateSnapshotSchema = z.object({
  reason: z.enum(['scheduled', 'manual', 'pre_evolution', 'shutdown']).default('manual'),
});

/* 操作 */
export const RunRegulationSchema = z.object({
  strategy: z.enum(['equal', 'fitness_weighted', 'priority_based']).optional(),
}).optional();

/* 冲突管理 */
export const ResolveConflictSchema = z.object({
  resolution: z.string().min(1),
});

/* P-OS 生存锚点 */
export const CreateSurvivalAnchorSchema = z.object({
  label: z.string().min(1),
  kind: z.enum(['constraint', 'threshold', 'must_have']),
  value: z.unknown().default(null),
  severity: z.number().int().min(1).max(5),
});

export const UpdateSurvivalAnchorSchema = z.object({
  label: z.string().min(1).optional(),
  kind: z.enum(['constraint', 'threshold', 'must_have']).optional(),
  value: z.unknown().optional(),
  severity: z.number().int().min(1).max(5).optional(),
});

/* P-OS 决策风格 */
export const UpdateDecisionStyleSchema = z.object({
  riskAppetite: z.number().min(0).max(1).optional(),
  timeHorizon: z.number().min(0).max(1).optional(),
  explorationBias: z.number().min(0).max(1).optional(),
  lossAversion: z.number().min(1).optional(),
  deliberationDepth: z.number().int().min(1).max(5).optional(),
  regretSensitivity: z.number().min(0).max(1).optional(),
});

/* P-OS 认知模型 */
export const UpdateCognitiveModelSchema = z.object({
  beliefs: z.record(z.string(), z.number().min(0).max(1)).optional(),
  biasWeights: z.record(z.string(), z.number().min(0).max(1)).optional(),
  attributionStyle: z.number().min(0).max(1).optional(),
  growthMindset: z.number().min(0).max(1).optional(),
  /* ④ L3 扩展：模糊容忍 / 直觉↔分析，[0,1]，可选（旧客户端不传→保持原值）。 */
  ambiguityTolerance: z.number().min(0).max(1).optional(),
  analyticalIntuitive: z.number().min(0).max(1).optional(),
});

/* 引导流程 */
export const OnboardingStep1Schema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
});

export const OnboardingStep2Schema = z.object({
  values: z.array(z.string().min(1)).min(3).max(10),
  customValues: z.array(z.string().min(1)).max(5).optional(),
});

export const OnboardingStep3Schema = z.object({
  memories: z.array(z.object({
    description: z.string().min(1),
    valence: z.number().min(-1).max(1).optional(),
    salience: z.number().min(0).max(1).optional(),
  })).min(1).max(5),
});

export const OnboardingQuestionnaireSchema = z.object({
  responses: z.array(z.object({
    id: z.string().min(1),
    score: z.number().int().min(1).max(5),
  })).min(1),
});

export const OnboardingImportSchema = z.object({
  journalEntries: z.array(z.object({
    content: z.string().min(1),
    valence: z.number().min(-1).max(1).optional(),
    salience: z.number().min(0).max(1).optional(),
  })).optional(),
  decisionRecords: z.array(z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    outcome: z.string().min(1).optional(),
  })).optional(),
});

/* 出生原型选择（②原型接入 onboarding/API）：用户挑一个性格原型作为出生基准决策风格。
 * 允许值从 kernel PERSONALITY_ARCHETYPES 派生（单一来源，避免 schema 与 kernel 漂移）。 */
export const ApplyArchetypeSchema = z.object({
  archetype: z.enum(PERSONALITY_ARCHETYPES as unknown as [string, ...string[]]),
});

/* W2.1 agent-governance onboarding v2 (5-step wizard) */
export const OnboardingV2StartSchema = z.object({}).passthrough();

export const OnboardingV2OrganizationSchema = z.object({
  sessionId: z.string().min(1),
  organizationName: z.string().min(1).max(120),
});

export const OnboardingV2AgentSchema = z.object({
  sessionId: z.string().min(1),
  agentName: z.string().min(1).max(120),
  llmProvider: z.enum(['openai', 'anthropic']).nullable().optional(),
  llmApiKey: z.string().max(512).nullable().optional(),
});

export const OnboardingV2PolicySchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  policies: z.array(z.object({
    toolId: z.string().min(1),
    /* scope 与 ToolScope kernel 类型对齐：read/write/execute */
    scope: z.enum(['read', 'write', 'execute']),
    decision: z.enum(['allow', 'deny', 'confirm']),
  })).min(1).max(20),
});

export const OnboardingV2SyntheticSchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
});

export const OnboardingV2CompleteSchema = z.object({
  sessionId: z.string().min(1),
});

export const OnboardingV2SkipSchema = z.object({
  sessionId: z.string().min(1),
  currentStep: z.number().int().min(1).max(5),
});

/* 人生模拟 */
export const CreateLifeSimulationSchema = z.object({
  paths: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().default(''),
    initialConditions: z.record(z.string(), z.unknown()).default({}),
    branches: z.array(z.object({
      label: z.string().min(1),
      probability: z.number().min(0).max(1),
      conditions: z.record(z.string(), z.unknown()).default({}),
    })).default([]),
  })).min(2).max(5),
  horizonYears: z.number().int().min(1).max(30).default(10),
  age: z.number().int().min(18).max(80).optional(),
  stressTestConfig: z.object({
    enabled: z.boolean().default(false),
    incomeFreezeYears: z.number().int().min(0).default(0),
    marketDownturnFactor: z.number().min(0).max(1).default(1),
    healthShock: z.number().min(0).max(1).default(0),
  }).optional(),
});

export const StressTestRequestSchema = z.object({
  variantLabel: z.string().min(1),
  overrides: z.record(z.string(), z.unknown()).default({}),
});

/* 认证 */
export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const LogoutSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

/* 计费 */
export const CheckoutSchema = z.object({
  priceId: z.string().min(1),
  successUrl: z.string().min(1),
  cancelUrl: z.string().min(1),
  /** P1-D：可选试用期天数（Stripe 上限 90） */
  trialDays: z.number().int().min(1).max(90).optional(),
});

export const SubscribeBillingSchema = z.object({
  planId: z.string().min(1),
  trialDays: z.number().int().min(1).max(90).optional(),
});

/** P1-D admin 退款 */
export const BillingRefundSchema = z.object({
  paymentIntent: z.string().min(1).optional(),
  charge: z.string().min(1).optional(),
  amount: z.number().int().positive().optional(),
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
}).refine(
  (v) => Boolean(v.paymentIntent || v.charge),
  { message: 'paymentIntent 或 charge 必须提供其一' },
);

export const PortalSchema = z.object({
  returnUrl: z.string().min(1),
});

const organizationRoleSchema = z.enum(['org_admin', 'billing_admin', 'persona_operator', 'marketplace_manager', 'auditor', 'viewer']);

export const CreateOrganizationSchema = z.object({
  name: z.string().min(1).max(160),
  slug: z.string().min(1).max(160).regex(/^[a-z0-9-]+$/).optional(),
  defaultWorkspaceName: z.string().min(1).max(160).default('Default Workspace'),
  defaultWorkspaceSlug: z.string().min(1).max(160).regex(/^[a-z0-9-]+$/).optional(),
});

export const UpsertOrganizationMemberSchema = z.object({
  userId: z.string().min(1).optional(),
  email: z.string().email().optional(),
  workspaceId: z.string().min(1).optional(),
  roles: z.array(organizationRoleSchema).min(1).max(6),
}).refine((value) => Boolean(value.userId ?? value.email), {
  message: 'userId 或 email 至少提供一个',
  path: ['userId'],
});

/* 协作 */
export const ShareSimulationSchema = z.object({
  userId: z.string().min(1),
  permission: z.enum(['view', 'edit']),
});

/* 决策管理 */
export const CreateDecisionSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  alternatives: z.array(z.string().min(1)).min(2).optional(),
  constraints: z.array(z.string().min(1)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const DecisionFeedbackSchema = z.object({
  runId: z.string().min(1),
  selectedAlternative: z.string().min(1),
  satisfaction: z.number().int().min(1).max(5),
  notes: z.string().optional(),
});

/* 通用分页查询参数 */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/* API Key 管理 */
export const CreateApiKeySchema = z.object({
  planId: z.string().min(1).default('free'),
});

export const RevokeApiKeySchema = z.object({
  keyId: z.string().min(1),
});

/* 企业部署 */
const deploymentModeSchema = z.enum(['shared_cluster', 'dedicated_db']);
const databaseIsolationModeSchema = z.enum(['shared', 'dedicated']);
const encryptionModeSchema = z.enum(['platform_managed', 'tenant_dedicated']);

export const UpdateDeploymentProfileSchema = z.object({
  deploymentMode: deploymentModeSchema.optional(),
  databaseIsolationMode: databaseIsolationModeSchema.optional(),
  kafkaNamespace: z.string().max(120).nullable().optional(),
  encryptionMode: encryptionModeSchema.optional(),
  kmsKeyRef: z.string().max(120).nullable().optional(),
  oidc: z.object({
    enabled: z.boolean().optional(),
    issuerUrl: z.string().url().optional(),
    clientId: z.string().min(1).max(300).optional(),
    clientSecret: z.string().min(1).max(2000).optional(),
    audience: z.string().max(300).optional(),
    scope: z.string().max(300).optional(),
    emailClaim: z.string().min(1).max(120).optional(),
    nameClaim: z.string().min(1).max(120).optional(),
  }).optional(),
});

/* SCIM */
export const ScimCreateUserSchema = z.object({
  userName: z.string().email(),
  active: z.boolean().default(true),
  externalId: z.string().max(200).optional(),
  name: z.object({
    givenName: z.string().max(120).optional(),
    familyName: z.string().max(120).optional(),
    formatted: z.string().max(240).optional(),
  }).optional(),
  emails: z.array(z.object({
    value: z.string().email(),
    primary: z.boolean().optional(),
  })).optional(),
});

/* 移动端设备管理 */
export const RegisterDeviceSchema = z.object({
  deviceUid: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']),
  pushToken: z.string().optional(),
  appVersion: z.string().optional(),
});

export const UpdatePushTokenSchema = z.object({
  pushToken: z.string().min(1),
});

/* 身份管理 */
export const UpdateIdentitySchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).optional(),
});

/* 分身管理 */
export const CreateAvatarSchema = z.object({
  label: z.string().min(1).max(50),
  kind: z.enum(['general', 'work', 'social', 'family', 'creative']).default('general'),
  behaviorOverrides: z.object({
    valueWeightAdjustments: z.record(z.string(), z.number().min(-0.3).max(0.3)).optional(),
    decisionStyleOverrides: z.object({
      riskAppetite: z.number().min(0).max(1).optional(),
      timeHorizon: z.number().min(0).max(1).optional(),
      explorationBias: z.number().min(0).max(1).optional(),
    }).optional(),
    contextBeliefs: z.record(z.string(), z.number().min(0).max(1)).optional(),
    memoryFilter: z.object({
      kinds: z.array(z.enum(['episodic', 'semantic', 'procedural'])).optional(),
      minSalience: z.number().min(0).max(1).optional(),
    }).optional(),
  }).optional(),
});

export const UpdateAvatarSchema = CreateAvatarSchema.partial();

/* 设备-分身绑定 */
export const InstallAvatarSchema = z.object({
  avatarId: z.string().min(1),
});

/* Avatar 自动运行 */
export const UpsertAutorunConfigSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(15).max(10080),
  driftThreshold: z.number().min(0).max(1).default(0.3),
  reviewRequired: z.boolean().default(false),
  knowledgeSourceIds: z.array(z.string()).max(50).default([]),
});

export const CreateKnowledgeSourceSchema = z.object({
  type: z.enum(['rss', 'api', 'file', 'manual', 'llm']),
  name: z.string().min(1).max(120),
  config: z.object({
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    pollingMinutes: z.number().int().min(15).max(10080).optional(),
    fileRef: z.string().optional(),
    manualText: z.string().max(20_000).optional(),
    systemPrompt: z.string().max(5000).optional(),
    topics: z.array(z.string().max(200)).max(100).optional(),
    itemsPerRun: z.number().int().min(1).max(20).optional(),
  }).refine(cfg => cfg.url || cfg.fileRef || cfg.manualText || cfg.systemPrompt, '至少提供 url/fileRef/manualText/systemPrompt 之一'),
});

export const UpdateKnowledgeSourceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  type: z.enum(['rss', 'api', 'file', 'manual', 'llm']).optional(),
  config: z.object({
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    pollingMinutes: z.number().int().min(15).max(10080).optional(),
    fileRef: z.string().optional(),
    manualText: z.string().max(20_000).optional(),
    systemPrompt: z.string().max(5000).optional(),
    topics: z.array(z.string().max(200)).max(100).optional(),
    itemsPerRun: z.number().int().min(1).max(20).optional(),
  }).optional(),
  enabled: z.boolean().optional(),
});

export const TriggerAutorunSchema = z.object({
  sourceIds: z.array(z.string()).optional(),
});

export const DriftReviewSchema = z.object({
  decisions: z.array(z.object({
    path: z.string().min(1),
    action: z.enum(['accept', 'reject', 'modify']),
    value: z.any().optional(),
  })).min(1),
  comment: z.string().max(500).optional(),
});

/* SSO 查询参数 */
export const SsoAuthorizeQuerySchema = z.object({
  redirect_uri: z.string().optional(),
});

export const SsoCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

export const OidcAuthorizeQuerySchema = z.object({
  redirect_uri: z.string().optional(),
  tenant_id: z.string().optional(),
});

export const OidcCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

/* 数据可移植性：导入 dry-run 请求体 */
export const DryRunImportBodySchema = z.object({
  manifestJson: z.string().min(1),
});

/* 数据可移植性：导入 commit 请求体 */
export const CommitImportBodySchema = z.object({
  manifestJson: z.string().min(1),
  commitToken: z.string().min(1),
});

/* P3 工具权限 / 代理授权管理 */
const AdminToolScopeSchema = z.enum(['read', 'write', 'execute']);
const AdminAgencyScopeSchema = z.enum(['communication', 'scheduling', 'research', 'finance', 'all']);

const AdminToolConstraintsSchema = z.object({
  maxActionsPerDay: z.number().int().positive().optional(),
  requireConfirmation: z.boolean().optional(),
  budgetLimitCents: z.number().int().nonnegative().optional(),
  allowList: z.array(z.string()).optional(),
  denyList: z.array(z.string()).optional(),
}).strict();

export const GrantToolPermissionSchema = z.object({
  personaId: z.string().min(1),
  toolId: z.string().min(1).max(100),
  scope: AdminToolScopeSchema,
  constraints: AdminToolConstraintsSchema.optional().default({}),
  expiresAt: z.number().int().positive().nullable().optional(),
});

export const RevokeToolPermissionByKeySchema = z.object({
  revocationKey: z.string().min(8),
  reason: z.string().min(1).max(500),
});

export const RevokeReasonSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const CreateAgencyAuthorizationSchema = z.object({
  personaId: z.string().min(1),
  principalUserId: z.string().min(1),
  scope: AdminAgencyScopeSchema,
  scopeDescription: z.string().min(10).max(2000),
  allowedTools: z.array(z.string().min(1)).optional(),
  deniedTools: z.array(z.string().min(1)).optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
});

/* ── F2/F3：Agent OAuth + 待确认 schemas ─────────────────────────── */

export const AgentOauthAuthorizeBodySchema = z.object({
  scope: z.string().min(1),
  redirectAfter: z.string().min(1).max(512).default('/'),
});

export const AgentOauthCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export const AgentOauthScopeQuerySchema = z.object({
  scope: z.string().min(1),
});

export const AgentOauthRevokeBodySchema = z.object({
  reason: z.string().min(1).max(256).default('user_initiated'),
});

export const AgentConfirmationsPendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const AgentConfirmationsApproveBodySchema = z.object({
  arguments: z.record(z.string(), z.unknown()),
  sessionId: z.string().min(1).max(128).optional(),
});

export const AgentConfirmationsRejectBodySchema = z.object({
  reason: z.string().min(1).max(256).default('user_rejected'),
});

/* P1.7.2 — analytics 批量埋点
 *
 * Property value 限制为标量（string / number / boolean / null）以阻断
 * 嵌套对象造成的 PII 泄漏。string 上限 2000 字符避开 abuse；keys 限制 32 个。
 * Event name 强制 lowercase + dot/underscore，便于按 prefix 聚合。 */
const AnalyticsPropertyValueSchema = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const AnalyticsEventSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9_.]+$/, {
    message: 'event name must be lowercase alphanumeric / underscore / dot',
  }),
  properties: z.record(z.string().max(64), AnalyticsPropertyValueSchema)
    .refine((p) => Object.keys(p).length <= 32, {
      message: 'properties must have at most 32 keys',
    })
    .optional(),
  ts: z.number().int().nonnegative().optional(),
});

export const AnalyticsBatchSchema = z.object({
  events: z.array(AnalyticsEventSchema).min(1).max(200),
  sessionId: z.string().min(8).max(128).optional(),
});

/* ── JWT KeyRing admin endpoints (P0-D #1) ──
 * Defined here so the contract snapshot test detects shape changes; the
 * actual routes live in src/server/plugins/jwt-auth.ts because they share
 * the KeyRing/DenyList instances built during plugin registration. */

const JwtKeyEntrySchema = z.object({
  kid: z.string().min(1),
  state: z.enum(['active', 'grace', 'retired', 'compromised']),
  algorithm: z.enum(['HS256', 'HS384', 'HS512', 'RS256', 'ES256']),
  privateKey: z.string().default(''),
  publicKey: z.string().default(''),
  secret: z.string().default(''),
});

export const JwtRotateBodySchema = z.object({
  newActiveKid: z.string().min(1),
  oldActiveNewState: z.enum(['grace', 'retired', 'compromised']).optional(),
  addNew: z.array(JwtKeyEntrySchema).optional(),
});

export const JwtDenyJtiBodySchema = z.object({
  jti: z.string().min(1),
  expiresAtMs: z.number().int().positive(),
});

/* ADR-0047 蒸馏治理：拒绝工件需带原因 */
export const DistillationRejectBodySchema = z.object({
  reason: z.string().min(1).max(500),
});

/* ADR-0048 自主挣钱：触发挣钱周期（可选限制本周期评估任务数） */
export const EarningCycleBodySchema = z.object({
  maxTasksPerCycle: z.number().int().min(1).max(20).optional(),
});

/* ── ADR-0055 E3 数字员工组织交互控制台（写/动作）── */

/* 发起目标：由某 manager 数字员工运行一个目标（确定性分解→委派→执行→汇报→聚合）。 */
export const WorkforceRunGoalBodySchema = z.object({
  managerWorkerId: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  description: z.string().min(0).max(2000),
  goalType: z.string().min(1).max(64),
});

/* 人类决定一个待审批（approve/reject）。reason 拒绝时建议填，approve 可选。 */
export const WorkforceApprovalDecisionBodySchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(500).optional(),
});

/* 触发数字员工真实执行一个已委派任务（D3：接 ToolInvocationPipeline，全确定性门控）。 */
export const WorkforceExecuteTaskBodySchema = z.object({
  workerId: z.string().min(1).max(128),
  toolId: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
  /* 非 low 任务必填：已放行且绑定本次执行的审批 id（D3 审批门按 subject/发起者/风险校验）。 */
  approvalId: z.string().min(1).max(128).optional(),
  /* 仅在上次返回 needs_pipeline_confirmation 后由人类显式提供（铁律4，service 绝不自动补）。 */
  confirmationToken: z.string().min(1).max(256).optional(),
  /* 额外风险信号（来自可信工具 metadata/编排层，不可信调用方不应随意填低——后端会再夹 A0 任务风险）。 */
  riskSignals: z.object({
    toolRisk: z.enum(['low', 'medium', 'high']).optional(),
    outboundCommitment: z.boolean().optional(),
    sensitiveData: z.boolean().optional(),
    funds: z.boolean().optional(),
    irreversible: z.boolean().optional(),
    requireConfirmation: z.boolean().optional(),
  }).optional(),
});

/* 请求一个执行审批（执行前先按有效风险拿审批 id；low 直接 auto_cleared）。 */
export const WorkforceRequestApprovalBodySchema = z.object({
  taskId: z.string().min(1).max(128),
  requesterWorkerId: z.string().min(1).max(128),
  toolId: z.string().min(1).max(128).optional(),
  /* 工具参数：用于服务端按 args 派生动态高风险（isHighRisk(args)）——与 execute 用同一 args，避免
   * 「申请审批 auto_cleared 但执行又 needs_approval」的坏流程（Codex 复审）。 */
  arguments: z.record(z.string(), z.unknown()).default({}),
  /* enterprise policy：是否允许上级数字员工审批 medium（默认 false=只人类）。 */
  allowWorkerApproval: z.boolean().default(false),
  ttlMs: z.number().int().min(1000).max(7 * 24 * 3600 * 1000).optional(),
  riskSignals: z.object({
    toolRisk: z.enum(['low', 'medium', 'high']).optional(),
    outboundCommitment: z.boolean().optional(),
    sensitiveData: z.boolean().optional(),
    funds: z.boolean().optional(),
    irreversible: z.boolean().optional(),
    requireConfirmation: z.boolean().optional(),
  }).optional(),
});

/* ── 自助建组织 / 招数字员工（生产 self-service，admin 鉴权）── */

const ARCHETYPE_ENUM = z.enum(['explorer', 'guardian', 'analyst', 'doer']);
const SENIORITY_ENUM = z.enum(['exec', 'lead', 'senior', 'ic']);

/**
 * 建一个空组织 + 一名根数字员工（CEO/负责人，无上级）。组织由「有 worker」隐式存在，故建组织即建首个根 worker。
 * personaId 由服务端按组织+roleCode 派生（前端不传，避免冲突/伪造）。
 */
export const WorkforceCreateOrgBodySchema = z.object({
  orgId: z.string().min(1).max(128),
  roleCode: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  displayName: z.string().min(1).max(120),
  jobFamily: z.string().min(1).max(64).default('exec'),
  seniority: SENIORITY_ENUM.default('exec'),
  archetype: ARCHETYPE_ENUM.default('doer'),
});

/**
 * 往**已存在**组织招一名数字员工：指定岗位 + 原型 + 直接上级（managerWorkerId）。personaId 服务端派生。
 * 新员工必有上级（非根），出生独立人格内核。
 */
export const WorkforceHireWorkerBodySchema = z.object({
  managerWorkerId: z.string().min(1).max(128),
  roleCode: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  displayName: z.string().min(1).max(120),
  jobFamily: z.string().min(1).max(64).default('ic'),
  seniority: SENIORITY_ENUM.default('ic'),
  archetype: ARCHETYPE_ENUM.default('doer'),
});
