/**
 * 能力缺口检测器 GapDetector（ADR-0057 L1）——确定性识别「数字员工干这个任务缺哪块能力」。
 *
 * ADR-0057 D0.2 红线：缺口发现是对**既有确定性信号**的**纯函数门控**，**不是**后台 LLM「思考我会不会」
 * 的循环。本模块只做最结构化、最可靠的那个信号——**职能能力覆盖差集**（requiredCapabilities − 已学能力）：
 *   「任务要求能力 X，persona 没学过 X」→ 缺口 X。
 *
 * 严守红线（ADR-0057）：
 *   - 零-LLM（红线 1/3）：纯集合差运算 + 字符串规范化，**禁止**任何 LLM/embedding/reranker/语义归并。
 *   - 确定性可复现（红线 4 同纪律）：同输入（required + learned）→ 同输出（缺口列表，字典序稳定）。
 *   - per-persona（红线 8）：输入的 learned 能力是**该 persona 自己**的（调用方按 (tenant, persona) 取，
 *     本纯函数不碰存储）。
 *   - 能力归因来自任务字段（D0.2）：缺口直接来自 task.requiredCapabilities，**不**做 LLM 归因。
 *
 * 纯类型 + 纯函数，零 node:* 依赖（ADR-0001）。存储/事件/wiring 在宿主层（L2 起）。
 */

import { normalizeCapabilities } from './capability-taxonomy.js';

/** 缺口优先级（确定性，由任务风险/SLA 派生；本函数按输入的 taskPriority 直传，不自创推理）。 */
export type GapPriority = 'low' | 'medium' | 'high';

/** GapDetector 输入：任务要求的能力 + 该 persona 已学的能力（+ 可选上下文，仅用于产出证据/优先级）。 */
export interface GapDetectionInput {
  /** 任务声明的所需能力（OrgTask.requiredCapabilities，自由字符串，内部会规范化）。 */
  readonly requiredCapabilities: readonly string[];
  /** 该 persona 已学/已具备的能力（来自 CapabilityIndex，L7 前可传已学事件派生的集合；空=从未学）。 */
  readonly personaLearnedCapabilities: readonly string[];
  /** 可选：任务优先级（由调用方按任务风险/SLA 确定性派生），缺省 'medium'。仅写进缺口记录，不影响是否为缺口。 */
  readonly taskPriority?: GapPriority;
  /** 可选：任务标识（写进证据，便于审计「哪个任务暴露了这个缺口」）。 */
  readonly taskId?: string;
}

/** 单个能力缺口（L1 输出；L2 会据此落 LearningRequest 账本）。 */
export interface CapabilityGap {
  /** 缺的能力（已规范化）。 */
  readonly capability: string;
  /** 确定性证据（人类可读 + 可审计，非 LLM 生成）。 */
  readonly evidence: string;
  /** 优先级（直传自输入 taskPriority）。 */
  readonly priority: GapPriority;
}

/** GapDetector 结果。 */
export interface GapDetectionResult {
  /** 缺口列表（字典序稳定，可复现）。空 = 无缺口（persona 覆盖任务全部所需能力）。 */
  readonly gaps: readonly CapabilityGap[];
  /** 是否有缺口（gaps.length > 0 的便捷布尔）。 */
  readonly hasGap: boolean;
}

/**
 * 检测能力缺口：required − learned = 缺口（确定性集合差）。
 *
 * 规范化两侧能力标识后做差集——任务要求但 persona 未学的能力即缺口。
 * 多能力任务（如 ['review','compliance']）→ 多个缺口（D0.8 多缺口语义：任务记全部缺口）。
 * 无缺口（persona 覆盖全部所需）→ gaps=[]，hasGap=false（调用方据此零-LLM 直接执行）。
 */
export function detectCapabilityGaps(input: GapDetectionInput): GapDetectionResult {
  const required = normalizeCapabilities(input.requiredCapabilities);
  const learned = new Set(normalizeCapabilities(input.personaLearnedCapabilities));
  const priority: GapPriority = input.taskPriority ?? 'medium';
  const taskRef = input.taskId ? `任务 ${input.taskId} ` : '任务';

  const gaps: CapabilityGap[] = [];
  for (const cap of required) {
    if (!learned.has(cap)) {
      gaps.push({
        capability: cap,
        evidence: `${taskRef}要求能力「${cap}」，该数字员工尚未学过此能力（覆盖差集）。`,
        priority,
      });
    }
  }
  /* required 已字典序（normalizeCapabilities 排序），gaps 顺序随之稳定可复现。 */
  return { gaps, hasGap: gaps.length > 0 };
}
