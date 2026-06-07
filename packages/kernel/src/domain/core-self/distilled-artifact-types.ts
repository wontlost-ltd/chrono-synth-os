/**
 * 蒸馏工件 — 纯领域类型与决策逻辑（ADR-0047 D3）
 *
 * LLM 的"教学输出"不直接写核心状态，而是先编译为 DistilledArtifact 候选，
 * 经 schema 校验 → UpdateGate 审批 → 编译 → 快照，落入确定性内核。
 * 这是"LLM = 可蒸馏老师，确定性内核 = 运行时"的类型契约层。
 *
 * 零 node:* 依赖（ADR-0001）。本文件只含纯类型与纯函数，不做任何 I/O。
 */

import {
  decideCoreUpdateGate,
  DEFAULT_CORE_UPDATE_GATE_POLICY,
  type CoreUpdateGatePolicy,
} from './core-update-gate.js';

/** 蒸馏工件种类：LLM 教学输出被编译进内核的目标形态 */
export type ArtifactKind =
  | 'rule'                  /* if-then 规则 → 规则库 */
  | 'value_shift'         /* 价值权重漂移 → value-store */
  | 'memory_edge'         /* 记忆关联 → memory-graph 边 */
  | 'decision_style_patch' /* L2 决策风格参数校准 */
  | 'cognitive_model_patch' /* L3 认知模型参数校准 */
  | 'response_template'   /* 离线回应模板 → 模板库 */
  | 'narrative_patch';     /* 叙事摘要/重写 */

/** 蒸馏来源：工件由哪类成长活动产生 */
export type ArtifactSource =
  | 'reflection'          /* LLM 反思循环 */
  | 'conversation'        /* 对话沉淀 */
  | 'knowledge_import'    /* 知识摄入 */
  | 'onboarding';          /* 初始画像 */

/**
 * 工件状态机（ADR-0047）：
 *   candidate ──approve──▶ approved ──compile──▶ compiled
 *       │                      │
 *       └──reject──▶ rejected  └──(失败/退化)──▶ rolled_back
 *   compiled ──rollback──▶ rolled_back
 *
 * LLM 输出永远从 candidate 起步，不可直接 compiled。
 */
export type ArtifactStatus =
  | 'candidate'
  | 'approved'
  | 'compiled'
  | 'rejected'
  | 'rolled_back';

/** 证据条目：工件的来源凭据（provenance），支持审计与重放 */
export interface ArtifactEvidence {
  readonly type: 'memory' | 'conversation' | 'knowledge' | 'pattern' | 'test';
  readonly id: string;
  /** 该证据对工件的支持度 0..1 */
  readonly score: number;
}

/* 运行时枚举集合：供 validateArtifact 防御畸形输入（与上面联合类型同源） */
const ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set([
  'rule', 'value_shift', 'memory_edge', 'decision_style_patch',
  'cognitive_model_patch', 'response_template', 'narrative_patch',
]);
const ARTIFACT_SOURCES: ReadonlySet<ArtifactSource> = new Set([
  'reflection', 'conversation', 'knowledge_import', 'onboarding',
]);
const ARTIFACT_STATUSES: ReadonlySet<ArtifactStatus> = new Set([
  'candidate', 'approved', 'compiled', 'rejected', 'rolled_back',
]);
const EVIDENCE_TYPES: ReadonlySet<ArtifactEvidence['type']> = new Set([
  'memory', 'conversation', 'knowledge', 'pattern', 'test',
]);

/**
 * 蒸馏工件（不可变）。
 *
 * status / compiledAt 为 readonly：状态推进只能经 transitionArtifact() 等纯函数，
 * 调用方不可直接赋值绕过状态机（ADR-0047 D3 不变量的类型级保护）。
 */
export interface DistilledArtifact {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly source: ArtifactSource;
  /** 工件载荷（按 kind 不同而不同；编译器按 kind 解释） */
  readonly payload: unknown;
  /** LLM/蒸馏置信度 0..1 */
  readonly confidence: number;
  /** 来源凭据，至少一条 */
  readonly evidence: readonly ArtifactEvidence[];
  /** 当前状态（只读：经 transitionArtifact 推进） */
  readonly status: ArtifactStatus;
  readonly createdAt: number;
  /** 编译落库时间（compiled 后写入） */
  readonly compiledAt?: number;
}

/** 自动编译门槛配置 */
export interface DistillationPolicy {
  /** value_shift 自动编译所需最低置信度 */
  readonly valueShiftMinConfidence: number;
  /** value_shift 自动编译允许的最大权重变化幅度（超过需审批） */
  readonly valueShiftMaxDelta: number;
  /** memory_edge 自动编译所需最低置信度 */
  readonly memoryEdgeMinConfidence: number;
  /** memory_edge 自动编译所需最少证据条数 */
  readonly memoryEdgeMinEvidence: number;
}

/**
 * 默认蒸馏策略（ADR-0047 D3）。**阈值从统一门控 policy 派生**，不再硬编码——
 * 这样 distillation 与 UpdateGate 的 distilled 分支阈值是同一个事实来源，改一处即生效，
 * 杜绝「共享函数但两份默认值」的伪统一漂移。
 */
export const DEFAULT_DISTILLATION_POLICY: DistillationPolicy = {
  valueShiftMinConfidence: DEFAULT_CORE_UPDATE_GATE_POLICY.distilledValueShiftMinConfidence,
  valueShiftMaxDelta: DEFAULT_CORE_UPDATE_GATE_POLICY.distilledValueShiftMaxDelta,
  memoryEdgeMinConfidence: DEFAULT_CORE_UPDATE_GATE_POLICY.distilledMemoryEdgeMinConfidence,
  memoryEdgeMinEvidence: DEFAULT_CORE_UPDATE_GATE_POLICY.distilledMemoryEdgeMinEvidence,
};

/** value_shift 工件的载荷形状 */
export interface ValueShiftPayload {
  readonly valueId: string;
  readonly currentWeight: number;
  readonly suggestedWeight: number;
  readonly delta: number;
  /** 确定性 pattern-extractor 是否在同方向上支持本次漂移（交叉验证） */
  readonly patternAgrees: boolean;
}

/** memory_edge 工件的载荷形状 */
export interface MemoryEdgePayload {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relation: string;
  readonly strength: number;
}

/** response_template 工件的载荷形状 */
export interface ResponseTemplatePayload {
  /** 触发该模板的意图/主题键 */
  readonly intent: string;
  /** 模板正文（可含 slot 占位） */
  readonly template: string;
}

/** 合法状态转移表 */
const VALID_TRANSITIONS: Readonly<Record<ArtifactStatus, readonly ArtifactStatus[]>> = {
  candidate: ['approved', 'rejected'],
  approved: ['compiled', 'rejected'],
  compiled: ['rolled_back'],
  rejected: [],
  rolled_back: [],
};

/** 判断状态转移是否合法（纯函数，非法 from 安全返回 false 而非抛错） */
export function canTransition(from: ArtifactStatus, to: ArtifactStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/**
 * 校验工件结构完整性（纯函数）。
 * 接受 unknown：畸形 LLM JSON（含 null/primitive/数组）返回问题列表而非抛错，
 * 使 canAutoCompile() 等下游能稳定返回 false。
 * 返回问题列表；为空表示通过。
 */
export function validateArtifact(artifact: unknown): string[] {
  /* 顶层类型守卫：非对象/数组/null 直接判定为畸形，不再访问属性 */
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return ['artifact must be an object'];
  }
  const a = artifact as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof a.id !== 'string' || a.id.length === 0) problems.push('missing id');
  if (!ARTIFACT_KINDS.has(a.kind as ArtifactKind)) problems.push('invalid kind');
  if (!ARTIFACT_SOURCES.has(a.source as ArtifactSource)) problems.push('invalid source');
  if (!ARTIFACT_STATUSES.has(a.status as ArtifactStatus)) problems.push('invalid status');
  if (typeof a.createdAt !== 'number' || !Number.isFinite(a.createdAt)) problems.push('createdAt must be a finite number');
  if (a.compiledAt !== undefined && (typeof a.compiledAt !== 'number' || !Number.isFinite(a.compiledAt))) {
    problems.push('compiledAt must be a finite number when present');
  }
  if (typeof a.confidence !== 'number' || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) {
    problems.push('confidence must be within [0,1]');
  }

  if (!Array.isArray(a.evidence)) {
    problems.push('evidence must be an array');
  } else if (a.evidence.length === 0) {
    problems.push('evidence must not be empty');
  } else {
    for (const raw of a.evidence) {
      const e = raw as Partial<ArtifactEvidence> | null;
      if (!e || typeof e.id !== 'string' || e.id.length === 0) {
        problems.push('evidence requires non-empty id');
        continue;
      }
      if (!EVIDENCE_TYPES.has(e.type as ArtifactEvidence['type'])) problems.push(`evidence ${e.id} has invalid type`);
      if (typeof e.score !== 'number' || !Number.isFinite(e.score) || e.score < 0 || e.score > 1) {
        problems.push(`evidence ${e.id} score must be within [0,1]`);
      }
    }
  }

  /* 仅当 kind 合法时才按 kind 校验 payload */
  if (ARTIFACT_KINDS.has(a.kind as ArtifactKind)) {
    problems.push(...validatePayloadShape(a.kind as ArtifactKind, a.payload));
  }
  return problems;
}

/** 权重/强度等归一化值是否在 [0,1] */
function inUnitRange(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** 按 kind 校验载荷形状（纯函数，payload 为 unknown，安全访问） */
function validatePayloadShape(kind: ArtifactKind, payload: unknown): string[] {
  switch (kind) {
    case 'value_shift': {
      const p = payload as Partial<ValueShiftPayload> | null;
      if (!p || typeof p.valueId !== 'string' || p.valueId.length === 0) {
        return ['value_shift payload requires non-empty valueId'];
      }
      const problems: string[] = [];
      if (!inUnitRange(p.currentWeight)) problems.push('value_shift currentWeight must be within [0,1]');
      if (!inUnitRange(p.suggestedWeight)) problems.push('value_shift suggestedWeight must be within [0,1]');
      if (typeof p.delta !== 'number' || !Number.isFinite(p.delta)) {
        problems.push('value_shift delta must be a finite number');
      } else if (inUnitRange(p.currentWeight) && inUnitRange(p.suggestedWeight)) {
        /* delta 必须与 suggested-current 一致（容忍浮点误差） */
        if (Math.abs(p.suggestedWeight - p.currentWeight - p.delta) > 1e-9) {
          problems.push('value_shift delta must equal suggestedWeight - currentWeight');
        }
      }
      if (typeof p.patternAgrees !== 'boolean') problems.push('value_shift patternAgrees must be boolean');
      return problems;
    }
    case 'memory_edge': {
      const p = payload as Partial<MemoryEdgePayload> | null;
      if (!p || typeof p.sourceId !== 'string' || typeof p.targetId !== 'string') {
        return ['memory_edge payload requires sourceId and targetId'];
      }
      const problems: string[] = [];
      if (p.sourceId === p.targetId) problems.push('memory_edge sourceId and targetId must differ');
      if (typeof p.relation !== 'string' || p.relation.length === 0) problems.push('memory_edge requires non-empty relation');
      if (!inUnitRange(p.strength)) problems.push('memory_edge strength must be within [0,1]');
      return problems;
    }
    case 'response_template': {
      const p = payload as Partial<ResponseTemplatePayload> | null;
      /* intent 是检索键 + 版本序列键，空串会污染序列；template 空则无意义。两者都须非空（trim 后）。 */
      if (!p || typeof p.intent !== 'string' || p.intent.trim().length === 0
        || typeof p.template !== 'string' || p.template.trim().length === 0) {
        return ['response_template payload requires non-empty intent and template'];
      }
      return [];
    }
    case 'narrative_patch': {
      const p = payload as { narrative?: unknown } | null;
      if (!p || typeof p.narrative !== 'string' || p.narrative.trim().length === 0) {
        return ['narrative_patch payload requires non-empty narrative'];
      }
      return [];
    }
    default:
      /* 其余 kind（rule / *_patch）的载荷形状在后续 PR 接入编译器时补充校验 */
      return [];
  }
}

/**
 * 判断 candidate 工件是否可自动编译（无需人工审批，纯函数，ADR-0047 D3）。
 *
 * 强制前置：工件必须处于 candidate 状态且 schema 校验通过——否则一律返回 false。
 * 这保证了"LLM 输出不可绕过审批/校验直达 compiled"：approved/compiled/rejected/
 * rolled_back 或畸形 payload 都不会被判定为可自动编译。
 */
export function canAutoCompile(
  artifact: unknown,
  policy: DistillationPolicy = DEFAULT_DISTILLATION_POLICY,
): boolean {
  /* D3 守卫：先校验（unknown-safe），不合法/非候选一律 false，不抛错 */
  if (validateArtifact(artifact).length > 0) return false;
  const a = artifact as DistilledArtifact; /* validateArtifact 通过后形状可信 */
  if (a.status !== 'candidate') return false;

  /* 自动编译的「门控判定」委托给统一共享层（distilled 来源），杜绝与 UpdateGate 阈值漂移。
   * 本函数仍负责 distillation 专属前置（candidate 状态 + schema 校验）；阈值来自共享 policy。 */
  const gatePolicy = distillationPolicyToGatePolicy(policy);
  switch (a.kind) {
    case 'value_shift': {
      const p = a.payload as ValueShiftPayload;
      return decideCoreUpdateGate(
        { layer: 'L1', sourceClass: 'distilled', delta: p.delta, confidence: a.confidence, patternAgrees: p.patternAgrees },
        gatePolicy,
      ).decision === 'auto';
    }
    case 'memory_edge': {
      return decideCoreUpdateGate(
        { layer: 'MemoryGraph', sourceClass: 'distilled', confidence: a.confidence, evidenceCount: a.evidence.length },
        gatePolicy,
      ).decision === 'auto';
    }
    default:
      /* rule / *_patch / response_template / narrative_patch 默认需审批 */
      return false;
  }
}

/** 把 distillation 专属 policy 适配为统一门控 policy（仅填 distilled 分支字段，deterministic 分支取默认）。 */
function distillationPolicyToGatePolicy(policy: DistillationPolicy): CoreUpdateGatePolicy {
  return {
    ...DEFAULT_CORE_UPDATE_GATE_POLICY,
    distilledValueShiftMinConfidence: policy.valueShiftMinConfidence,
    distilledValueShiftMaxDelta: policy.valueShiftMaxDelta,
    distilledMemoryEdgeMinConfidence: policy.memoryEdgeMinConfidence,
    distilledMemoryEdgeMinEvidence: policy.memoryEdgeMinEvidence,
  };
}

/** 状态推进结果 */
export type TransitionResult =
  | { readonly ok: true; readonly artifact: DistilledArtifact }
  | { readonly ok: false; readonly reason: string };

/**
 * 工件状态推进的唯一写入口（纯函数，返回新工件，不原地修改）。
 *
 * 这是 status 改为 readonly 后唯一合法的状态变更方式：非法转移被拒绝，
 * 调用方无法直接赋值 status 绕过状态机（ADR-0047 D3）。
 *
 * 强制 D3 "schema-validated → gated → compiled"：进入 approved 或 compiled 前
 * 必须 validateArtifact 通过，否则拒绝——畸形/未校验工件不能被编译进 core state。
 * 进入 compiled 时写入 compiledAt。
 */
export function transitionArtifact(
  artifact: DistilledArtifact,
  to: ArtifactStatus,
  now: number,
): TransitionResult {
  if (!canTransition(artifact.status, to)) {
    return { ok: false, reason: `illegal transition ${artifact.status} → ${to}` };
  }
  /* 进入"被采纳"方向（approved/compiled）前强制结构校验 */
  if (to === 'approved' || to === 'compiled') {
    const problems = validateArtifact(artifact);
    if (problems.length > 0) {
      return { ok: false, reason: `cannot ${to} invalid artifact: ${problems.join('; ')}` };
    }
  }
  const next: DistilledArtifact = {
    ...artifact,
    status: to,
    ...(to === 'compiled' ? { compiledAt: now } : {}),
  };
  return { ok: true, artifact: next };
}
