/**
 * 工具动作编译 — 纯领域类型与确定性映射（ADR-0060 R1 / T1）。
 *
 * 目的：在**运行时零-LLM**（ADR-0047 根基）下，把任务结构化字段确定性地映射成一次具体工具调用的
 * `arguments`。智能（映射规则本身）在学习/编译期由 LLM 老师产出、经蒸馏门 + lint + 工具考试编译成
 * **确定性规则**（T2/T3）；本模块只定义规则形态 + **运行时纯函数**据规则构造 `ToolCallPlan`。
 *
 * 严守 ADR-0060 红线：
 *   - 红线 1/9（零-LLM + 规则确定性）：映射步骤仅 pick（取任务字段）/const（常量）/enum（白名单枚举）/
 *     template（确定性模板插值）；**禁** LLM/prompt/eval/动态代码/网络/时间源/随机源——否则「运行时查规则」
 *     会把非确定性依赖藏进规则里。本文件是纯类型 + 纯函数，零 node:* 依赖（ADR-0001）。
 *   - 红线 10（冲突 fail-closed）：同 (persona, capability, tool, schemaVersion) 多 active 规则命中 →
 *     不猜，返回 fail-closed。
 *   - 红线 4（确定性可复现）：同输入 → 同 ToolCallPlan（arguments 键序稳定）。
 *   - 红线 5（不绕 7 门）：本模块只产出 plan（toolId + arguments），执行仍走 ToolInvocationPipeline。
 *   - fail-closed（红线 4 of ADR）：任何无法确定性构造合法 arguments 的情况 → 返回 failClosed，要求人工补字段，
 *     绝不用默认值/猜测填坑。
 *
 * 存储 / 学习通道 / wiring 在宿主层（T1 store + T2/T3）。
 */

/** 工具动作映射步骤（受限确定性 DSL；判别联合，运行时按 kind 求值）。 */
export type ToolArgMapping =
  /** 取任务结构化字段的值（field=taskFields 的键）。缺字段 → fail-closed（不填默认）。 */
  | { readonly kind: 'pick'; readonly field: string }
  /** 固定常量值（规则内嵌，不依赖任务）。 */
  | { readonly kind: 'const'; readonly value: string | number | boolean }
  /** 白名单枚举：取任务字段值，**必须**落在 allow 集合内，否则 fail-closed（防注入非法枚举）。 */
  | { readonly kind: 'enum'; readonly field: string; readonly allow: readonly string[] }
  /** 确定性模板：把 parts（字面量）与 fields（任务字段占位）按序拼接。缺字段 → fail-closed。
   *  segments 顺序 = 输出顺序；literal 段原样，field 段取 taskFields[field] 的字符串值。 */
  | { readonly kind: 'template'; readonly segments: readonly ToolTemplateSegment[] };

export type ToolTemplateSegment =
  | { readonly literal: string }
  | { readonly field: string };

/**
 * 一条工具动作规则（ADR-0060 红线 9 元数据齐全）。
 * 规则 = 「某 persona 学会某 capability 后，对某 tool 的某 schemaVersion，如何从任务字段构造 arguments」。
 */
export interface ToolActionRule {
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly capability: string;
  /** 目标 tool inputSchema 的版本（tool schema 变化 → 旧规则版本不匹配 → fail-closed）。 */
  readonly schemaVersion: string;
  /** 规则版本（同 key 演进用；冲突决议时同 key 只能一个 active）。 */
  readonly ruleVersion: string;
  /** 规范化 DSL/IR 的内容哈希（防篡改 + 假变更去重；由宿主编译期计算）。 */
  readonly contentHash: string;
  readonly createdBy: string;
  readonly compiledAt: number;
  /** 过期时间（epoch ms）；now ≥ expiresAt → 规则失效 fail-closed。null=不过期。 */
  readonly expiresAt: number | null;
  /** 是否 active（同 key 只能一个 active，红线 10）。 */
  readonly active: boolean;
  /** arguments 构造映射：目标参数名 → 映射步骤。 */
  readonly argMappings: Readonly<Record<string, ToolArgMapping>>;
}

/** 编译产物：一次确定性的工具调用计划（仍需过 ToolInvocationPipeline 7 门）。 */
export interface ToolCallPlan {
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** 规则溯源（审计 + eligibility 引用）。 */
  readonly ruleVersion: string;
  readonly contentHash: string;
  /** 确定性幂等键（据 toolId + 规范化 arguments 派生，供管线/工具去重）。 */
  readonly idempotencyKey: string;
}

/** 编译结果：成功 plan / fail-closed（要求人工介入，绝不猜）。 */
export type ToolCompileResult =
  | { readonly ok: true; readonly plan: ToolCallPlan }
  | { readonly ok: false; readonly failClosed: true; readonly reason: string; readonly code: ToolCompileFailCode };

export type ToolCompileFailCode =
  | 'no_rule'              /* 无匹配 active 规则 */
  | 'rule_conflict'       /* 多个 active 规则命中同 key（红线 10） */
  | 'rule_expired'        /* 规则已过期 */
  | 'schema_mismatch'     /* 存在同 (tenant,persona,tool,capability) active 规则但 schemaVersion 不符（tool schema 已变） */
  | 'missing_field'       /* pick/template/enum 引用的任务字段缺失 */
  | 'enum_violation'      /* enum 映射取值不在白名单 */
  | 'invalid_mapping'     /* 畸形 DSL（未知 kind / 坏 segments / 非数组 allow / 非标量 const）——受控 fail-closed 不崩溃 */
  | 'invalid_arguments';  /* 构造出的 arguments 缺 tool 必填项 / 类型不符 schema */
