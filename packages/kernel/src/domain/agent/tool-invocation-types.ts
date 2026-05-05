/**
 * 工具调用记录（审计 + 配额）
 *
 * 每次外部工具调用必须落库一行 tool_invocations，含：
 *  - 触发上下文（persona / agency / 调用源）
 *  - 调用结果（success / failure / pending_confirmation）
 *  - 计费信息（cost_cents 用于按调用计费）
 *
 * 该表是 audit_log 的补充：audit_log 是高层语义事件，tool_invocations 是低层物理调用。
 */

/** 调用结果状态 */
export type ToolInvocationStatus =
  | 'success'
  | 'failed'
  | 'pending_confirmation'
  | 'denied_permission'
  | 'denied_quota'
  | 'denied_circuit_open'
  | 'timeout';

/** 工具调用记录 */
export interface ToolInvocation {
  readonly id: string;
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly invokerType: 'mcp' | 'internal' | 'admin';
  /** 调用者标识（jwt sub / api key hash / mcp client id） */
  readonly invokerId: string;
  readonly status: ToolInvocationStatus;
  /** 输入参数 hash（sha256，前 16 字节）— 用于去重和一致性校验 */
  readonly inputHash: string;
  /** 输出 size（bytes），不存内容避免 PII 泄漏 */
  readonly outputSizeBytes: number;
  readonly errorMessage: string | null;
  /** 计费金额（分），按工具不同有不同计费策略 */
  readonly costCents: number;
  readonly durationMs: number;
  readonly invokedAt: number;
  readonly completedAt: number | null;
  /** 关联的二次确认 token id（如有） */
  readonly confirmationTokenId: string | null;
}

/** 写入参数 */
export interface ToolInvocationRecordParams {
  readonly id: string;
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly invokerType: string;
  readonly invokerId: string;
  readonly status: string;
  readonly inputHash: string;
  readonly outputSizeBytes: number;
  readonly errorMessage: string | null;
  readonly costCents: number;
  readonly durationMs: number;
  readonly invokedAt: number;
  readonly completedAt: number | null;
  readonly confirmationTokenId: string | null;
}

/** SQL 行类型 */
export interface ToolInvocationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly tool_id: string;
  readonly invoker_type: string;
  readonly invoker_id: string;
  readonly status: string;
  readonly input_hash: string;
  readonly output_size_bytes: number;
  readonly error_message: string | null;
  readonly cost_cents: number;
  readonly duration_ms: number;
  readonly invoked_at: number;
  readonly completed_at: number | null;
  readonly confirmation_token_id: string | null;
}
