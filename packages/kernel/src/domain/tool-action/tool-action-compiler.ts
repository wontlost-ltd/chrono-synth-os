/**
 * 工具动作编译器（纯函数，ADR-0060 R1 / T1）——运行时零-LLM 据确定性规则构造工具调用。
 *
 * 两步：
 *   1. resolveActiveRule：从候选规则里选**唯一** active 且未过期、schemaVersion 匹配的规则；
 *      0 个 → no_rule；>1 个 active 命中 → rule_conflict（红线 10 fail-closed，不猜）。
 *   2. compileToolCall：据规则 argMappings 从任务字段确定性构造 arguments，校验 tool 必填项，
 *      产出带幂等键的 ToolCallPlan。任一步无法确定性完成 → fail-closed（绝不用默认值填坑）。
 *
 * 全纯函数、零 node:* 依赖（ADR-0001）；`now` 由调用方注入（不读系统时钟，红线 9 禁时间源进构造）。
 */

import type { McpToolSchema } from '../agent/mcp-protocol-types.js';
import type {
  ToolActionRule, ToolArgMapping, ToolCallPlan, ToolCompileResult,
} from './tool-action-types.js';

/** 规则匹配键（唯一定位一条规则应用的 (persona, capability, tool, schemaVersion)）。 */
export interface ToolRuleKey {
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly capability: string;
  readonly schemaVersion: string;
}

/** resolveActiveRule 结果：唯一命中 / fail-closed（无/冲突/过期）。 */
export type RuleResolution =
  | { readonly ok: true; readonly rule: ToolActionRule }
  | { readonly ok: false; readonly reason: string; readonly code: 'no_rule' | 'rule_conflict' | 'rule_expired' | 'schema_mismatch' };

/**
 * 从候选规则中确定性解析出唯一可用规则。
 * candidates 应是宿主按 (tenant, persona, tool, capability) 从存储取出的集合；本函数只做**纯判定**。
 */
export function resolveActiveRule(candidates: readonly ToolActionRule[], key: ToolRuleKey, now: number): RuleResolution {
  /* 先按 (tenant, persona, tool, capability) + active 圈定「这个场景有没有 active 规则」。 */
  const activeForScope = candidates.filter((r) =>
    r.active &&
    r.tenantId === key.tenantId &&
    r.personaId === key.personaId &&
    r.toolId === key.toolId &&
    r.capability === key.capability,
  );
  /* 再要求 schemaVersion 匹配当前 tool inputSchema 版本。 */
  const matched = activeForScope.filter((r) => r.schemaVersion === key.schemaVersion);
  if (matched.length === 0) {
    /* 区分：有 active 规则但版本不符（tool schema 已变，规则失效 → schema_mismatch，供治理可观测重训）
     * vs 该场景压根没 active 规则（no_rule）。Codex T1 复审 S2：schema_mismatch 须可达。 */
    if (activeForScope.length > 0) {
      return { ok: false, reason: `有 active 规则但 schemaVersion 不符（规则 ${activeForScope.map((r) => r.schemaVersion).join('/')} ≠ 当前 ${key.schemaVersion}，tool schema 已变，须重训规则）`, code: 'schema_mismatch' };
    }
    return { ok: false, reason: '无匹配 active 规则', code: 'no_rule' };
  }
  if (matched.length > 1) {
    /* 红线 10：同 key 多 active → 不猜哪个，fail-closed 要治理消歧。 */
    return { ok: false, reason: `同 key 命中 ${matched.length} 条 active 规则（须治理消歧）`, code: 'rule_conflict' };
  }
  const rule = matched[0];
  if (rule.expiresAt !== null && now >= rule.expiresAt) {
    return { ok: false, reason: `规则已过期（expiresAt=${rule.expiresAt} ≤ now=${now}）`, code: 'rule_expired' };
  }
  return { ok: true, rule };
}

/**
 * 据规则确定性构造工具调用计划。
 * @param rule       已 resolveActiveRule 选出的唯一规则
 * @param taskFields 任务结构化字段（pick/template/enum 的取值源）
 * @param toolSchema 目标 tool 的 inputSchema（校验必填项 + schemaVersion 由调用方在 resolve 阶段已比对）
 * @param now        注入时钟（不读系统时钟）
 */
export function compileToolCall(
  rule: ToolActionRule,
  taskFields: Readonly<Record<string, unknown>>,
  toolSchema: McpToolSchema,
  now: number,
): ToolCompileResult {
  if (rule.expiresAt !== null && now >= rule.expiresAt) {
    return { ok: false, failClosed: true, reason: '规则已过期', code: 'rule_expired' };
  }

  const args: Record<string, unknown> = {};
  /* argMappings 键序不定 → 排序后逐个求值，保证 arguments 键序稳定（红线 4 可复现）。 */
  for (const argName of Object.keys(rule.argMappings).sort()) {
    const step = rule.argMappings[argName];
    const evaluated = evalMapping(step, taskFields);
    if (!evaluated.ok) return { ok: false, failClosed: true, reason: `参数「${argName}」：${evaluated.reason}`, code: evaluated.code };
    args[argName] = evaluated.value;
  }

  /* 校验 tool 必填项都已构造（缺 → invalid_arguments fail-closed，绝不放行不完整调用）。 */
  for (const req of toolSchema.required ?? []) {
    if (!(req in args)) {
      return { ok: false, failClosed: true, reason: `tool 必填参数「${req}」未被规则构造`, code: 'invalid_arguments' };
    }
  }

  /* 最小 JSON-schema 校验（Codex T1 复审 S2：不止查 required，还要类型 + 多余参数守卫）。
   * additionalProperties===false 时拒绝 schema 未声明的多余参数；每个已声明参数按其 type 校验基础类型。 */
  const props = toolSchema.properties;
  for (const argName of Object.keys(args)) {
    if (!(argName in props)) {
      if (toolSchema.additionalProperties === false) {
        return { ok: false, failClosed: true, reason: `参数「${argName}」不在 tool schema 声明中（additionalProperties=false）`, code: 'invalid_arguments' };
      }
      continue; /* 未声明但允许 additionalProperties → 不校验类型 */
    }
    const typeErr = checkJsonType(args[argName], props[argName]);
    if (typeErr) return { ok: false, failClosed: true, reason: `参数「${argName}」类型不符 schema：${typeErr}`, code: 'invalid_arguments' };
  }

  const idempotencyKey = deriveIdempotencyKey(rule.toolId, args);
  const plan: ToolCallPlan = {
    toolId: rule.toolId,
    arguments: args,
    ruleVersion: rule.ruleVersion,
    contentHash: rule.contentHash,
    idempotencyKey,
  };
  return { ok: true, plan };
}

type EvalResult =
  | { readonly ok: true; readonly value: string | number | boolean }
  | { readonly ok: false; readonly reason: string; readonly code: 'missing_field' | 'enum_violation' | 'invalid_mapping' };

/**
 * 求值单个映射步骤（确定性；缺字段/枚举越界/**畸形 DSL** 都受控 fail-closed，**绝不抛异常**）。
 * step 来自持久化（DB），运行时不可信——TS 静态类型不保证形状，故按 unknown 逐字段防御（Codex T1 复审 S1：
 * 未知 kind / 坏 segments / 非数组 allow 曾会走到 switch 无 default → undefined → TypeError 崩溃，非受控 fail-closed）。
 */
function evalMapping(rawStep: ToolArgMapping, taskFields: Readonly<Record<string, unknown>>): EvalResult {
  /* 入口非空对象守卫（Codex T1 二轮）：持久化 JSON 可能是 null/undefined/标量 → 先挡，否则 step.kind 会 TypeError。 */
  if (rawStep === null || typeof rawStep !== 'object') {
    return { ok: false, reason: '映射步骤非对象（畸形 DSL）', code: 'invalid_mapping' };
  }
  const step = rawStep as { kind?: unknown; field?: unknown; value?: unknown; allow?: unknown; segments?: unknown };
  switch (step.kind) {
    case 'const':
      if (!isScalar(step.value)) return { ok: false, reason: 'const 值非标量', code: 'invalid_mapping' };
      return { ok: true, value: step.value };
    case 'pick': {
      if (typeof step.field !== 'string') return { ok: false, reason: 'pick 缺合法 field', code: 'invalid_mapping' };
      if (!(step.field in taskFields)) return { ok: false, reason: `任务字段「${step.field}」缺失`, code: 'missing_field' };
      const v = taskFields[step.field];
      if (!isScalar(v)) return { ok: false, reason: `任务字段「${step.field}」非标量，无法构造参数`, code: 'missing_field' };
      return { ok: true, value: v };
    }
    case 'enum': {
      if (typeof step.field !== 'string') return { ok: false, reason: 'enum 缺合法 field', code: 'invalid_mapping' };
      if (!Array.isArray(step.allow)) return { ok: false, reason: 'enum 缺合法 allow 白名单', code: 'invalid_mapping' };
      if (!(step.field in taskFields)) return { ok: false, reason: `任务字段「${step.field}」缺失`, code: 'missing_field' };
      const v = taskFields[step.field];
      const s = typeof v === 'string' ? v : String(v);
      if (!(step.allow as unknown[]).includes(s)) return { ok: false, reason: `取值「${s}」不在枚举白名单`, code: 'enum_violation' };
      return { ok: true, value: s };
    }
    case 'template': {
      if (!Array.isArray(step.segments)) return { ok: false, reason: 'template 缺合法 segments', code: 'invalid_mapping' };
      let out = '';
      for (const seg of step.segments as unknown[]) {
        if (seg === null || typeof seg !== 'object') return { ok: false, reason: 'template segment 非法', code: 'invalid_mapping' };
        const s = seg as { literal?: unknown; field?: unknown };
        if (typeof s.literal === 'string') { out += s.literal; continue; }
        if (typeof s.field !== 'string') return { ok: false, reason: 'template segment 既非 literal 也非合法 field', code: 'invalid_mapping' };
        if (!(s.field in taskFields)) return { ok: false, reason: `模板字段「${s.field}」缺失`, code: 'missing_field' };
        const v = taskFields[s.field];
        if (!isScalar(v)) return { ok: false, reason: `模板字段「${s.field}」非标量`, code: 'missing_field' };
        out += String(v);
      }
      return { ok: true, value: out };
    }
    default:
      /* 未知 kind（畸形 DSL）→ 受控 fail-closed，不崩溃（S1 修复）。 */
      return { ok: false, reason: `未知映射 kind「${String(step.kind)}」`, code: 'invalid_mapping' };
  }
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * 最小 JSON-schema 基础类型校验（value 对 propSchema.type）。返回错误说明或 null（通过）。
 * 只校验标量基础类型（string/number/integer/boolean）——本编译层只产标量参数（pick/const/enum/template），
 * schema 未声明 type 或声明非标量类型时**放行**（不越权校验，交由下游 adapter/pipeline）。确定性、无副作用。
 */
function checkJsonType(value: unknown, propSchema: unknown): string | null {
  if (propSchema === null || typeof propSchema !== 'object') return null;
  const t = (propSchema as { type?: unknown }).type;
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'string': return typeof value === 'string' ? null : `期望 string，实得 ${typeof value}`;
    case 'boolean': return typeof value === 'boolean' ? null : `期望 boolean，实得 ${typeof value}`;
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? null : `期望 number，实得 ${typeof value}`;
    case 'integer': return typeof value === 'number' && Number.isInteger(value) ? null : `期望 integer，实得 ${typeof value}`;
    default: return null; /* object/array/其它非标量：本层不产此类值，不越权校验 */
  }
}

/**
 * 确定性幂等键：toolId + 规范化 arguments（键排序 JSON）。同一调用 → 同键（红线 4）。
 * 非加密哈希（FNV-1a 32-bit，与 kernel 其它确定性派生同纪律，零依赖、可复现）。
 */
function deriveIdempotencyKey(toolId: string, args: Readonly<Record<string, unknown>>): string {
  const canonical = `${toolId} ${stableStringify(args)}`;
  return `tcall_${fnv1a(canonical)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
