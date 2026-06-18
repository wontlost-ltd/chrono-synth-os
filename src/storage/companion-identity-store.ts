/**
 * 数字人第一人称身份 store（ADR-0055「自我意识」）。
 *
 * per (tenant_id, persona_id) 一行，存「我是谁」的结构化身份事实——当前为 name。
 * 与 memories（我学到的知识）分开：问「你叫什么」由此第一人称回答「我叫 X」，
 * 而非把用户原话「你叫 X」当第二人称记忆原样复述（主语错位）。
 *
 * 直接走 IDatabase.prepare（与 me.ts countTenantSnapshots 同款轻量读写，无需 kernel query 常量）。
 * 表 companion_identity 含 tenant_id → TenantDatabase 自动隔离；GDPR A 类标准导出/擦除。
 */

import type { IDatabase } from './database.js';

/** 名字最大长度（防超长输入撑爆 + 防把整段话当名字）。 */
const MAX_NAME_LENGTH = 40;

/** 名字基础清洗（store 层防御纵深，不只依赖调用方）：去 ASCII 控制字符与尖括号（防 markup），
 * trim，截断。返回空串表示清洗后无有效名字（调用方应拒绝落库）。 */
function cleanName(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;   // 控制字符
    if (ch === '<' || ch === '>') continue;        // 防 <script> 之类 markup 进身份事实
    out += ch;
  }
  return out.trim().slice(0, MAX_NAME_LENGTH);
}

export class CompanionIdentityStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
    private readonly personaId: string = 'default',
  ) {}

  /** 取数字人的名字；未起名 → undefined。 */
  getName(): string | undefined {
    const row = this.db.prepare<{ name: string | null }>(
      'SELECT name FROM companion_identity WHERE tenant_id = ? AND persona_id = ?',
    ).get(this.tenantId, this.personaId);
    const name = row?.name?.trim();
    return name && name.length > 0 ? name : undefined;
  }

  /**
   * 设置数字人的名字（用户在对话中定义，合法覆盖——非 pristine 锁，允许改名）。
   * 调用方应先过 never_discuss 自检；本层做防御纵深清洗（控制字符/markup/长度）。
   * 清洗后为空 → 抛错（不落空名字）。
   * @returns 实际落库的名字（清洗后）
   */
  setName(name: string, now: number): string {
    const clean = cleanName(name);
    if (clean.length === 0) throw new Error('名字清洗后为空，拒绝落库');
    this.db.prepare<void>(
      `INSERT INTO companion_identity (tenant_id, persona_id, name, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, persona_id) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at`,
    ).run(this.tenantId, this.personaId, clean, now);
    return clean;
  }
}
