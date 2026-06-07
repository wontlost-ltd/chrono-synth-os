/**
 * 响应模板存储（ADR-0047）— 薄适配器，委托 kernel query/command。
 *
 * 取代「编译进会衰减的 procedural memory」：模板落本专用表，持久不衰减、版本化。
 *   - appendVersion：同 intent 追加新版本（version = 当前最高 + 1，从 1 起）；
 *   - getLatestByIntent：取某 intent 的最新版本（未来对话消费端契约入口）；
 *   - listVersionsByIntent / listByPersona：审计/回滚。
 *
 * ⚠️ 并发契约：appendVersion 的版本号用 maxVersion+1 计算（读-改-写），**不是**自身原子的。
 * 安全前提是调用方串行化同一 (tenant, persona) 的写入。当前唯一生产调用方是
 * ArtifactCompiler.compileResponseTemplate，它走 DistillationService.compileApproved，
 * 已被 ADR-0047 租户级全局 compile 锁串行化，故 maxVersion→insert 之间无并发竞争。
 * 若未来在该锁外调用本方法，必须自行串行化，否则并发会撞复合主键（本方法对此显式抛错，
 * 不静默吞）。
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import {
  rtQueryLatestByIntent, rtQueryByIntent, rtQueryByPersona, rtQueryMaxVersion,
  rtCmdInsert, responseTemplateFromRow,
  type ResponseTemplate,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from './executors/index.js';
import { ValidationError, ErrorCode } from '../errors/index.js';

export class ResponseTemplateStore {
  constructor(
    private readonly tx: SyncWriteUnitOfWork,
    private readonly tenantId: string = 'default',
  ) {
    registerCoreSelfExecutors();
  }

  /**
   * 追加一个新版本的模板。version = 该 intent 当前最高版本 + 1（无则为 1）。
   * 见类注释的并发契约：调用方须串行化同 (tenant, persona) 写入（生产路径由 compile 锁保证）。
   * 复合主键冲突（并发未串行化）会向上抛 ValidationError，绝不静默。
   * @param artifactId 溯源的蒸馏工件 id（无则 null）
   * @param now epoch ms
   * @returns 写入的版本号
   */
  appendVersion(personaId: string, intent: string, template: string, artifactId: string | null, now: number): number {
    const maxRow = this.tx.queryOne(rtQueryMaxVersion({ tenantId: this.tenantId, personaId, intent }));
    const nextVersion = (maxRow?.max_version ?? 0) + 1;
    try {
      this.tx.execute(rtCmdInsert({
        tenantId: this.tenantId,
        personaId,
        intent,
        template,
        version: nextVersion,
        artifactId,
        createdAt: now,
        updatedAt: now,
      }));
    } catch (err) {
      /* 仅把「主键/唯一约束冲突」转成明确的并发契约错误（同 intent 并发算出同一 version）；
       * 缺表/连接/权限等其它错误保留原样向上抛，不误报为并发冲突。 */
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE|PRIMARY KEY|constraint failed|duplicate key/i.test(msg)) {
        throw new ValidationError(
          `response_template 版本冲突 (intent=${intent} v${nextVersion})：并发写入未串行化，违反 appendVersion 并发契约。${msg}`,
          ErrorCode.STATE_INVALID_TRANSITION,
        );
      }
      throw err;
    }
    return nextVersion;
  }

  /** 取某 intent 的最新版本模板（对话消费端入口）。 */
  getLatestByIntent(personaId: string, intent: string): ResponseTemplate | undefined {
    const row = this.tx.queryOne(rtQueryLatestByIntent({ tenantId: this.tenantId, personaId, intent }));
    return row ? responseTemplateFromRow(row) : undefined;
  }

  /** 取某 intent 的所有版本（最新在前）。 */
  listVersionsByIntent(personaId: string, intent: string): ResponseTemplate[] {
    const rows = [...this.tx.queryMany(rtQueryByIntent({ tenantId: this.tenantId, personaId, intent }))];
    return rows.map(responseTemplateFromRow);
  }

  /** 取某 persona 的所有模板（每 intent 每版本一行）。 */
  listByPersona(personaId: string): ResponseTemplate[] {
    const rows = [...this.tx.queryMany(rtQueryByPersona({ tenantId: this.tenantId, personaId }))];
    return rows.map(responseTemplateFromRow);
  }
}
