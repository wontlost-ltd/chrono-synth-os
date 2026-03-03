/**
 * 附加组件管理
 * 提供 add_ons 表的 CRUD 以及默认组件种子数据
 */

import { randomUUID } from 'node:crypto';
import type { IDatabase, SqlValue } from '../storage/database.js';

export interface AddOn {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly stripePriceId: string;
  readonly resource: string;
  readonly quotaAmount: number;
  readonly isActive: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface AddOnRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly stripe_price_id: string;
  readonly resource: string;
  readonly quota_amount: number;
  readonly is_active: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function rowToAddOn(row: AddOnRow): AddOn {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    stripePriceId: row.stripe_price_id,
    resource: row.resource,
    quotaAmount: row.quota_amount,
    isActive: row.is_active !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 默认附加组件定义 */
const DEFAULT_ADD_ONS: ReadonlyArray<Pick<AddOn, 'code' | 'name' | 'description' | 'resource' | 'quotaAmount'>> = [
  { code: 'extra_simulations_10',  name: '额外模拟 ×10',     description: '增加 10 次/月模拟配额',   resource: 'simulation',   quotaAmount: 10 },
  { code: 'extra_tokens_100k',     name: '额外 Token 10 万',  description: '增加 100K LLM Token 配额', resource: 'llm_tokens',   quotaAmount: 100_000 },
  { code: 'advanced_models',       name: '高级模型',           description: '解锁高级 LLM 模型访问',    resource: 'advanced_models', quotaAmount: 1 },
  { code: 'priority_queue',        name: '优先队列',           description: '模拟任务优先执行',         resource: 'priority_queue',  quotaAmount: 1 },
];

/** 初始化默认附加组件（幂等） */
export function seedDefaultAddOns(db: IDatabase): void {
  const now = Date.now();
  for (const def of DEFAULT_ADD_ONS) {
    const existing = db.prepare<{ id: string }>(
      'SELECT id FROM add_ons WHERE code = ?',
    ).get(def.code);
    if (existing) continue;

    db.prepare<void>(
      `INSERT INTO add_ons (id, code, name, description, stripe_price_id, resource, quota_amount, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, TRUE, ?, ?)`,
    ).run(`addon_${randomUUID()}`, def.code, def.name, def.description, def.resource, def.quotaAmount, now, now);
  }
}

/** 列出所有附加组件（可选仅活跃） */
export function listAddOns(db: IDatabase, activeOnly = true): AddOn[] {
  const sql = activeOnly
    ? 'SELECT * FROM add_ons WHERE is_active = TRUE ORDER BY code'
    : 'SELECT * FROM add_ons ORDER BY code';
  return db.prepare<AddOnRow>(sql).all().map(rowToAddOn);
}

/** 按 code 查找附加组件 */
export function getAddOnByCode(db: IDatabase, code: string): AddOn | undefined {
  const row = db.prepare<AddOnRow>('SELECT * FROM add_ons WHERE code = ?').get(code);
  return row ? rowToAddOn(row) : undefined;
}

/** 按 ID 查找附加组件 */
export function getAddOnById(db: IDatabase, id: string): AddOn | undefined {
  const row = db.prepare<AddOnRow>('SELECT * FROM add_ons WHERE id = ?').get(id);
  return row ? rowToAddOn(row) : undefined;
}

/** 创建附加组件 */
export function createAddOn(db: IDatabase, data: Omit<AddOn, 'id' | 'isActive' | 'createdAt' | 'updatedAt'>): AddOn {
  const id = `addon_${randomUUID()}`;
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO add_ons (id, code, name, description, stripe_price_id, resource, quota_amount, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?)`,
  ).run(id, data.code, data.name, data.description, data.stripePriceId, data.resource, data.quotaAmount, now, now);
  return { ...data, id, isActive: true, createdAt: now, updatedAt: now };
}

/** 更新附加组件 */
export function updateAddOn(db: IDatabase, id: string, data: Partial<Pick<AddOn, 'name' | 'description' | 'stripePriceId' | 'quotaAmount'>>): void {
  const sets: string[] = [];
  const params: SqlValue[] = [];
  if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
  if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description); }
  if (data.stripePriceId !== undefined) { sets.push('stripe_price_id = ?'); params.push(data.stripePriceId); }
  if (data.quotaAmount !== undefined) { sets.push('quota_amount = ?'); params.push(data.quotaAmount); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(Date.now(), id);
  db.prepare<void>(`UPDATE add_ons SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/** 停用附加组件 */
export function deactivateAddOn(db: IDatabase, id: string): void {
  db.prepare<void>(
    'UPDATE add_ons SET is_active = FALSE, updated_at = ? WHERE id = ?',
  ).run(Date.now(), id);
}
