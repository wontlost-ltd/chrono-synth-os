/**
 * API 请求/响应 Zod Schema 定义
 */

import { z } from 'zod';

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
export const CreateMemorySchema = z.object({
  kind: z.enum(['episodic', 'semantic', 'procedural']),
  content: z.string().min(1),
  valence: z.number().min(-1).max(1),
  salience: z.number().min(0).max(1),
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
});

export const PortalSchema = z.object({
  returnUrl: z.string().min(1),
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
  type: z.enum(['rss', 'api', 'file', 'manual']),
  name: z.string().min(1).max(120),
  config: z.object({
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    pollingMinutes: z.number().int().min(15).max(10080).optional(),
    fileRef: z.string().optional(),
    manualText: z.string().max(20_000).optional(),
  }).refine(cfg => cfg.url || cfg.fileRef || cfg.manualText, '至少提供 url/fileRef/manualText 之一'),
});

export const UpdateKnowledgeSourceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  type: z.enum(['rss', 'api', 'file', 'manual']).optional(),
  config: z.object({
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    pollingMinutes: z.number().int().min(15).max(10080).optional(),
    fileRef: z.string().optional(),
    manualText: z.string().max(20_000).optional(),
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
