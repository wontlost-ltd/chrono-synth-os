/**
 * 规则存储（ADR-0047）— 薄适配器，委托 kernel query/command。
 *
 * rule 工件落本专用表，持久不衰减、版本化。
 *   - appendVersion：同 ruleId 追加新版本（version = 当前最高 + 1，从 1 起）；
 *   - getActiveRules：取某 persona 每个 ruleId 的最新版本，供 RuleEngine 消费；
 *   - listByPersona：审计/回滚。
 *
 * ⚠️ 并发契约：appendVersion 的版本号用 maxVersion+1 计算（读-改-写），**不是**自身原子的。
 * 安全前提是调用方串行化同一 (tenant, persona) 的写入。当前生产调用方是
 * ArtifactCompiler.compileRule，它走 DistillationService.compileApproved，
 * 已被 ADR-0047 租户级全局 compile 锁串行化，故 maxVersion→insert 之间无并发竞争。
 * 若未来在该锁外调用本方法，必须自行串行化，否则并发会撞复合主键（本方法对此显式抛错，
 * 不静默吞）。
 */

import type { SyncWriteUnitOfWork, RulePayload } from '@chrono/kernel';
import {
  ruleQueryActiveByPersona, ruleQueryByPersona, ruleQueryMaxVersion,
  ruleCmdInsert, personaRuleFromRow, rulePayloadFromRow,
  type PersonaRule,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';
import { ValidationError, ErrorCode } from '../errors/index.js';

export class RuleStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /**
   * 追加一个新版本的规则。version = 该 ruleId 当前最高版本 + 1（无则为 1）。
   * 见类注释的并发契约：调用方须串行化同 (tenant, persona) 写入（生产路径由 compile 锁保证）。
   * 复合主键冲突（并发未串行化）会向上抛 ValidationError，绝不静默。
   */
  appendVersion(personaId: string, payload: RulePayload, artifactId: string | null, now: number): number {
    const maxRow = this.tx.queryOne(ruleQueryMaxVersion({ tenantId: this.tenantId, personaId, ruleId: payload.ruleId }));
    const nextVersion = (maxRow?.max_version ?? 0) + 1;
    try {
      this.tx.execute(ruleCmdInsert({
        tenantId: this.tenantId,
        personaId,
        ruleId: payload.ruleId,
        condition: payload.condition,
        action: payload.action,
        weight: payload.weight,
        description: payload.description ?? null,
        artifactId,
        version: nextVersion,
        createdAt: now,
        updatedAt: now,
      }));
    } catch (err) {
      /* 仅把「主键/唯一约束冲突」转成明确的并发契约错误（同 ruleId 并发算出同一 version）；
       * 缺表/连接/权限等其它错误保留原样向上抛，不误报为并发冲突。 */
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE|PRIMARY KEY|constraint failed|duplicate key/i.test(msg)) {
        throw new ValidationError(
          `rule 版本冲突 (ruleId=${payload.ruleId} v${nextVersion})：并发写入未串行化，违反 appendVersion 并发契约。${msg}`,
          ErrorCode.STATE_INVALID_TRANSITION,
        );
      }
      throw err;
    }
    return nextVersion;
  }

  /** 取某 persona 的 active rules（每个 ruleId 最高版本），供 RuleEngine 消费。 */
  getActiveRules(personaId: string): RulePayload[] {
    const rows = [...this.tx.queryMany(ruleQueryActiveByPersona({ tenantId: this.tenantId, personaId }))];
    return rows.map(rulePayloadFromRow);
  }

  /** 取某 persona 的所有规则版本（审计/回滚）。 */
  listByPersona(personaId: string): PersonaRule[] {
    const rows = [...this.tx.queryMany(ruleQueryByPersona({ tenantId: this.tenantId, personaId }))];
    return rows.map(personaRuleFromRow);
  }
}
