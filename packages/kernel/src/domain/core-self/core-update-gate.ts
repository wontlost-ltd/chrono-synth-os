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

  /* distilled 来源：在幅度门之外叠加证据门（LLM 来源可能幻觉，更谨慎）。 */
  switch (input.layer) {
    case 'L1': {
      /* value_shift：置信度 + pattern 交叉验证 + 幅度三重门 */
      const okConfidence = (input.confidence ?? 0) >= policy.distilledValueShiftMinConfidence;
      const okPattern = input.patternAgrees === true;
      const okDelta = Math.abs(input.delta ?? Infinity) <= policy.distilledValueShiftMaxDelta;
      return okConfidence && okPattern && okDelta
        ? auto('distilled value_shift meets confidence + pattern + delta gates')
        : confirm('distilled value_shift fails one of confidence/pattern/delta gates');
    }
    case 'MemoryGraph': {
      /* memory_edge：置信度 + 证据数 */
      const okConfidence = (input.confidence ?? 0) >= policy.distilledMemoryEdgeMinConfidence;
      const okEvidence = (input.evidenceCount ?? 0) >= policy.distilledMemoryEdgeMinEvidence;
      return okConfidence && okEvidence
        ? auto('distilled memory_edge meets confidence + evidence gates')
        : confirm('distilled memory_edge fails confidence/evidence gates');
    }
    default:
      /* L0/L2/L3/Narrative/Rule/Template 蒸馏来源默认需人工审批（与现状一致）。 */
      return confirm(`distilled ${input.layer} change requires manual approval`);
  }
}
