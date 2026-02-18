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
