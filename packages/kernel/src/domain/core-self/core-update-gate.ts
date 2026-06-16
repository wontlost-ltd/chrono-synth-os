/**
 * 核心自我修改的**统一门控判定**（ADR-0047）。
 *
 * 系统有两条改核心人格状态的路径，历史上各自有独立的门控判定，导致**判定漂移**风险
 * （同类核心变更走不同入口因代码分叉得到不一致结果，且改一处忘改另一处会越漂越远）：
 *   - UpdateGate（src/meta）：确定性来源（API user_confirmation / 统计漂移 / integration）
 *     触发的 L0/L1 价值/锚点更新。
 *   - distillation（canAutoCompile）：LLM 蒸馏来源（reflection/conversation/...）产出的
 *     DistilledArtifact（value_shift/memory_edge/...）。
 *
 * 本模块把两套判定收敛到**单一 policy 来源** `decideCoreUpdateGate`，按 sourceClass
 * 显式分支：
 *   - 'deterministic'：来源可信（非 LLM），只按幅度门（L0 恒需确认；L1 看 |delta| 阈值）。
 *   - 'distilled'：来源可能幻觉，额外叠加证据门（confidence / patternAgrees / evidence）。
 *
 * 两个分支保留各自**正当的** provenance 差异（LLM 来源更谨慎是对的，不是漂移），但阈值
 * 从此只有一个事实来源——改一处即两套生效，杜绝代码分叉漂移。行为与合并前等价。
 *
 * 纯类型 + 纯函数，零 node:* 依赖（ADR-0001）。
 */

/** 核心人格的层级 / 变更落点（ADR-0046 persona 模型 + distillation kind 映射）。 */
export type CoreUpdateLayer =
  | 'L0'          /* survival anchor 底线约束 */
  | 'L1'          /* core value 权重 */
  | 'L2'          /* decision style */
  | 'L3'          /* cognitive model */
  | 'Narrative'   /* 叙事 */
  | 'Rule'        /* 规则 */
  | 'Template'    /* 响应模板 */
  | 'MemoryGraph';/* 记忆图边 */

/** 变更来源类别：决定是否叠加证据门。 */
export type CoreUpdateSourceClass = 'deterministic' | 'distilled';

/**
 * 成长来源 provenance（ADR-0047 血缘 + ADR-0051 感知）。与 ArtifactSource 取值一致——本模块是更底层
 * 的门控层，不反向依赖 distilled-artifact-types（避免循环），故在此独立声明同名取值。
 */
export type GrowthProvenance =
  | 'reflection'        /* LLM 反思循环（人格自身推理） */
  | 'conversation'      /* 对话沉淀（交互式，面向人格） */
  | 'knowledge_import'  /* 知识摄入（读文档/导入） */
  | 'onboarding'        /* 初始画像（owner 监督的初始化） */
  | 'perception';        /* 外部感知（ADR-0051：听/看一段——「不可信外部输入」，最该谨慎） */

/**
 * 信任层级：把 provenance 归并为「该多信任这条未验证成长」的三档。distilled 分支据此**调整证据门
 * 严格度**——同样是 LLM 蒸馏，「人格自身反思」比「听陌生人说一段」可信，门槛该不同（ADR-0047 D2
 * 的 provenance 差异精细化：不是漂移，是合理的来源分级）。
 */
export type GrowthTrustTier =
  | 'internal'  /* 高信任：reflection / onboarding（人格自身/owner 监督） */
  | 'semi'      /* 中信任：conversation / knowledge_import（交互式面向人格） */
  | 'external';  /* 低信任：perception（不可信外部，最严门槛） */

/** provenance → 信任层级（确定性查表）。 */
export function trustTierOf(provenance: GrowthProvenance): GrowthTrustTier {
  switch (provenance) {
    case 'reflection':
    case 'onboarding':
      return 'internal';
    case 'conversation':
    case 'knowledge_import':
      return 'semi';
    case 'perception':
      return 'external';
  }
}

/** 门控判定输入（两套入口都映射到它）。 */
export interface CoreUpdateGateInput {
  readonly layer: CoreUpdateLayer;
  readonly sourceClass: CoreUpdateSourceClass;
  /** 权重/数值变化幅度（L1 value weight 用；缺省视为无幅度约束）。 */
  readonly delta?: number;
  /** 来源置信度（distilled 来源用）。 */
  readonly confidence?: number;
  /** 确定性 pattern 是否同意（distilled value_shift 用）。 */
  readonly patternAgrees?: boolean;
  /** 证据条数（distilled memory_edge 用）。 */
  readonly evidenceCount?: number;
  /**
   * 成长来源 provenance（可选，distilled 来源用于信任分级）。给定时按信任层级调整 confidence 门槛
   * （perception 比 reflection 更严）；不给则视为 tier=internal（乘数 1.0，向后兼容旧二元行为）。
   */
  readonly provenance?: GrowthProvenance;
  /**
   * 不确定性预算状态（可选）：该 persona 当前窗口已 auto-applied 的未验证(distilled)成长数。
   * 给定且达预算上限时，本条即使过门也降级 confirm（防止短期吸收过多未验证成长）。不给则不计预算。
   */
  readonly unverifiedGrowthInWindow?: number;
}

/** 判定结果：auto = 可自动应用；confirm = 需人工确认。 */
export type CoreUpdateDecision = 'auto' | 'confirm';

export interface CoreUpdateGateResult {
  readonly decision: CoreUpdateDecision;
  readonly reason: string;
}

/**
 * 统一门控 policy（单一事实来源）。两套门控的阈值都在此，改一处即生效两套。
 * deterministic 与 distilled 分支保留各自正当阈值（与历史行为等价）。
 */
export interface CoreUpdateGatePolicy {
  /** deterministic 来源：L0 恒需确认？（对应旧 UpdateGate l0RequiresConfirmation） */
  readonly deterministicL0RequiresConfirmation: boolean;
  /** deterministic 来源：L1 value weight 自动应用允许的最大 |delta|（旧 l1ConfirmationThreshold） */
  readonly deterministicL1MaxAutoDelta: number;
  /** distilled 来源：value_shift 自动编译最低置信度（旧 valueShiftMinConfidence） */
  readonly distilledValueShiftMinConfidence: number;
  /** distilled 来源：value_shift 自动编译允许最大 |delta|（旧 valueShiftMaxDelta） */
  readonly distilledValueShiftMaxDelta: number;
  /** distilled 来源：memory_edge 自动编译最低置信度（旧 memoryEdgeMinConfidence） */
  readonly distilledMemoryEdgeMinConfidence: number;
  /** distilled 来源：memory_edge 自动编译最低证据数（旧 memoryEdgeMinEvidence） */
  readonly distilledMemoryEdgeMinEvidence: number;
  /**
   * 信任层级 → confidence 门槛**乘数**（≥1.0 收紧，越大越严）。把「最低置信度」按来源可信度抬高：
   * internal=1.0（不抬，等价旧行为）、semi>1.0、external 最高。乘后仍 clamp 到 ≤1（置信度上界）。
   */
  readonly trustTierConfidenceMultiplier: Readonly<Record<GrowthTrustTier, number>>;
  /**
   * 不确定性预算：单 persona 窗口内允许 auto-apply 的未验证(distilled)成长数上限。达到即后续降级 confirm。
   * 调用方不传 unverifiedGrowthInWindow 时不计预算（向后兼容）。默认设很大 → 实际不限（需显式收紧才生效）。
   */
  readonly unverifiedGrowthBudgetPerWindow: number;
}

/**
 * 统一默认 policy（数值与合并前两套默认完全一致，保证行为等价）。
 * Object.freeze：旧入口默认常量（DEFAULT_DISTILLATION_POLICY / DEFAULT_UPDATE_GATE_CONFIG）
 * 在模块加载期从本对象**派生快照**字段值；冻结可防运行时误改本 singleton 后与快照动态不一致，
 * 坐实「单一事实来源」。
 */
export const DEFAULT_CORE_UPDATE_GATE_POLICY: CoreUpdateGatePolicy = Object.freeze({
  deterministicL0RequiresConfirmation: true,
  deterministicL1MaxAutoDelta: 0.15,
  distilledValueShiftMinConfidence: 0.8,
  distilledValueShiftMaxDelta: 0.05,
  distilledMemoryEdgeMinConfidence: 0.75,
  distilledMemoryEdgeMinEvidence: 2,
  /* 默认乘数：internal 1.0（旧行为等价）；semi/external 收紧。Object.freeze 防运行时误改。 */
  trustTierConfidenceMultiplier: Object.freeze({ internal: 1.0, semi: 1.1, external: 1.25 }),
  /* 默认预算极大 → 实际不限（向后兼容：旧调用方不传 unverifiedGrowthInWindow 本就不计预算）。 */
  unverifiedGrowthBudgetPerWindow: Number.MAX_SAFE_INTEGER,
});

const auto = (reason: string): CoreUpdateGateResult => ({ decision: 'auto', reason });
const confirm = (reason: string): CoreUpdateGateResult => ({ decision: 'confirm', reason });

/**
 * 统一门控判定（纯函数）。两套门控（UpdateGate / canAutoCompile）都应通过它判定，
 * 杜绝阈值分叉漂移。返回 auto（可自动应用）或 confirm（需人工确认）。
 */
export function decideCoreUpdateGate(
  input: CoreUpdateGateInput,
  policy: CoreUpdateGatePolicy = DEFAULT_CORE_UPDATE_GATE_POLICY,
): CoreUpdateGateResult {
  if (input.sourceClass === 'deterministic') {
    /* 确定性来源：只按幅度门（无证据门——来源可信，非 LLM）。 */
    if (input.layer === 'L0') {
      return policy.deterministicL0RequiresConfirmation
        ? confirm('L0 survival anchor change always requires confirmation')
        : auto('L0 change auto-applied (policy: L0 not gated)');
    }
    if (input.layer === 'L1') {
      const mag = Math.abs(input.delta ?? 0);
      return mag > policy.deterministicL1MaxAutoDelta
        ? confirm(`L1 value weight |delta|=${mag} exceeds ${policy.deterministicL1MaxAutoDelta}`)
        : auto(`L1 value weight |delta|=${mag} within auto threshold`);
    }
    /* 其它层确定性更新当前无自动门概念——保守需确认。 */
    return confirm(`deterministic ${input.layer} change requires confirmation`);
  }

  /* distilled 来源：在幅度门之外叠加证据门（LLM 来源可能幻觉，更谨慎）。
   * 信任分级：按 provenance 的信任层级抬高 confidence 门槛（perception 比 reflection 更严）。
   * 不给 provenance 时 tier=internal（乘数 1.0），与旧二元行为逐字等价。 */
  const tier = input.provenance ? trustTierOf(input.provenance) : 'internal';
  const confMul = policy.trustTierConfidenceMultiplier[tier];

  let gateResult: CoreUpdateGateResult;
  switch (input.layer) {
    case 'L1': {
      /* value_shift：置信度（按信任层抬高）+ pattern 交叉验证 + 幅度三重门 */
      const minConf = clampConfidence(policy.distilledValueShiftMinConfidence * confMul);
      const okConfidence = (input.confidence ?? 0) >= minConf;
      const okPattern = input.patternAgrees === true;
      const okDelta = Math.abs(input.delta ?? Infinity) <= policy.distilledValueShiftMaxDelta;
      gateResult = okConfidence && okPattern && okDelta
        ? auto(`distilled value_shift meets confidence(${tier}) + pattern + delta gates`)
        : confirm('distilled value_shift fails one of confidence/pattern/delta gates');
      break;
    }
    case 'MemoryGraph': {
      /* memory_edge：置信度（按信任层抬高）+ 证据数 */
      const minConf = clampConfidence(policy.distilledMemoryEdgeMinConfidence * confMul);
      const okConfidence = (input.confidence ?? 0) >= minConf;
      const okEvidence = (input.evidenceCount ?? 0) >= policy.distilledMemoryEdgeMinEvidence;
      gateResult = okConfidence && okEvidence
        ? auto(`distilled memory_edge meets confidence(${tier}) + evidence gates`)
        : confirm('distilled memory_edge fails confidence/evidence gates');
      break;
    }
    default:
      /* L0/L2/L3/Narrative/Rule/Template 蒸馏来源默认需人工审批（与现状一致）。 */
      return confirm(`distilled ${input.layer} change requires manual approval`);
  }

  /* 不确定性预算：若调用方给了窗口已用量且已达预算上限，则即使本条过门也降级 confirm
   * （防止短期吸收过多未验证成长——一条条都"合格"但累计起来侵蚀核心人格）。
   * 仅对 auto 结果生效（confirm 本就需人工，不必再降级）。不给 unverifiedGrowthInWindow 时不计预算。 */
  if (gateResult.decision === 'auto' && input.unverifiedGrowthInWindow !== undefined
      && input.unverifiedGrowthInWindow >= policy.unverifiedGrowthBudgetPerWindow) {
    return confirm(
      `unverified-growth budget reached (${input.unverifiedGrowthInWindow} ≥ ${policy.unverifiedGrowthBudgetPerWindow}); downgraded to confirm`,
    );
  }
  return gateResult;
}

/** confidence 门槛乘数后 clamp 到 (0,1]（置信度不可能 >1，乘数抬高后封顶）。 */
function clampConfidence(v: number): number {
  return v > 1 ? 1 : v;
}
