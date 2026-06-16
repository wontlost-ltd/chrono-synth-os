/**
 * per-persona 治理策略的 Query/Command kind 契约（ADR-0048 治理可配化）。
 *
 * kernel 只声明形状；执行器在 src/storage/executors。策略是**非 secret 配置**（policy_json
 * 内含 categoryRoutes / AML 阈值 / 预算等可覆盖字段）。无 row 时调用方完全回退 DEFAULT_EARNING_POLICY。
 */

import type { Query, Command } from '../../ports/query.js';

/* ── Query / Command kinds ── */

export const PERSONA_GOVERNANCE_QUERY_BY_PERSONA = 'personaGovernance.byPersona' as const;
export const PERSONA_GOVERNANCE_CMD_UPSERT = 'personaGovernance.upsert' as const;
export const PERSONA_GOVERNANCE_CMD_DELETE = 'personaGovernance.delete' as const;

/* ── Row ── */

export interface PersonaGovernanceRow {
  readonly tenant_id: string;
  readonly persona_id: string;
  /** 可覆盖策略字段的 JSON 文本；resolve 时 merge over DEFAULT_EARNING_POLICY。 */
  readonly policy_json: string;
  readonly updated_by: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/* ── Params ── */

export interface PersonaGovernanceByPersonaParams {
  tenantId: string;
  personaId: string;
}

export interface PersonaGovernanceUpsertParams {
  tenantId: string;
  personaId: string;
  policyJson: string;
  updatedBy: string | null;
  now: number;
}

/* ── 工厂 ── */

/** 取某 persona 的治理策略覆盖（无 row → 调用方回退 DEFAULT_EARNING_POLICY）。 */
export function personaGovernanceQueryByPersona(
  params: PersonaGovernanceByPersonaParams,
): Query<PersonaGovernanceRow | null, PersonaGovernanceByPersonaParams> {
  return { kind: PERSONA_GOVERNANCE_QUERY_BY_PERSONA, params };
}

/** upsert：一 persona 一行，覆盖更新（策略是当前生效配置，非审计资产）。 */
export function personaGovernanceCmdUpsert(
  params: PersonaGovernanceUpsertParams,
): Command<PersonaGovernanceUpsertParams> {
  return { kind: PERSONA_GOVERNANCE_CMD_UPSERT, params };
}

/** 删除某 persona 策略覆盖（恢复默认 / GDPR 擦除）。 */
export function personaGovernanceCmdDelete(
  params: PersonaGovernanceByPersonaParams,
): Command<PersonaGovernanceByPersonaParams> {
  return { kind: PERSONA_GOVERNANCE_CMD_DELETE, params };
}
