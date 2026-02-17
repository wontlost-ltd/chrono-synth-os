/**
 * 生存锚点存储：管理 L0 约束/阈值/必需项
 */

import type { IDatabase } from '../storage/database.js';
import type { SurvivalAnchor, SurvivalAnchorKind } from '../types/personality-os.js';
import type { Clock } from '../utils/clock.js';
import { generatePrefixedId } from '../utils/id-generator.js';

interface AnchorRow {
  id: string;
  label: string;
  kind: string;
  value_json: string;
  severity: number;
  created_at: number;
  updated_at: number;
}

const VALID_KINDS: readonly SurvivalAnchorKind[] = ['constraint', 'threshold', 'must_have'];

function assertKind(kind: string): asserts kind is SurvivalAnchorKind {
  if (!(VALID_KINDS as readonly string[]).includes(kind)) {
    throw new RangeError(`锚点类型必须是 ${VALID_KINDS.join(', ')} 之一，收到 ${kind}`);
  }
}

function assertSeverity(severity: number): void {
  if (!Number.isFinite(severity) || severity < 1 || severity > 5 || !Number.isInteger(severity)) {
    throw new RangeError(`严重度必须为 1-5 的整数，收到 ${severity}`);
  }
}

export type SurvivalAnchorUpdate = Partial<Pick<SurvivalAnchor, 'label' | 'kind' | 'value' | 'severity'>>;

export class SurvivalAnchorStore {
  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
  ) {}

  /** 创建生存锚点 */
  create(label: string, kind: SurvivalAnchorKind, value: unknown, severity: number): SurvivalAnchor {
    assertKind(kind);
    assertSeverity(severity);
    const id = generatePrefixedId('anchor');
    const now = this.clock.now();
    this.db.prepare<void>(
      'INSERT INTO survival_anchors (id, label, kind, value_json, severity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, label, kind, JSON.stringify(value ?? null), severity, now, now);
    return { id, label, kind, value, severity, createdAt: now, updatedAt: now };
  }

  /** 更新生存锚点 */
  update(id: string, patch: SurvivalAnchorUpdate): SurvivalAnchor | undefined {
    const current = this.getById(id);
    if (!current) return undefined;

    const now = this.clock.now();
    const nextKind = patch.kind ?? current.kind;
    const nextSeverity = patch.severity ?? current.severity;
    const nextValue = Object.prototype.hasOwnProperty.call(patch, 'value') ? patch.value : current.value;

    assertKind(nextKind);
    assertSeverity(nextSeverity);

    const next: SurvivalAnchor = {
      id,
      label: patch.label ?? current.label,
      kind: nextKind,
      value: nextValue,
      severity: nextSeverity,
      createdAt: current.createdAt,
      updatedAt: now,
    };

    this.db.prepare<void>(
      'UPDATE survival_anchors SET label = ?, kind = ?, value_json = ?, severity = ?, updated_at = ? WHERE id = ?',
    ).run(next.label, next.kind, JSON.stringify(next.value ?? null), next.severity, now, id);

    return next;
  }

  /** 按 ID 获取 */
  getById(id: string): SurvivalAnchor | undefined {
    const row = this.db.prepare<AnchorRow>(
      'SELECT * FROM survival_anchors WHERE id = ?',
    ).get(id);
    return row ? this.toAnchor(row) : undefined;
  }

  /** 获取全部锚点 */
  getAll(): SurvivalAnchor[] {
    const rows = this.db.prepare<AnchorRow>(
      'SELECT * FROM survival_anchors ORDER BY created_at',
    ).all();
    return rows.map(r => this.toAnchor(r));
  }

  /** 删除锚点 */
  delete(id: string): boolean {
    return this.db.prepare<void>('DELETE FROM survival_anchors WHERE id = ?').run(id).changes > 0;
  }

  /** 删除全部 */
  deleteAll(): void {
    this.db.exec('DELETE FROM survival_anchors');
  }

  /** 按原始数据插入（恢复用） */
  insert(anchor: SurvivalAnchor): void {
    this.db.prepare<void>(
      `INSERT INTO survival_anchors (id, label, kind, value_json, severity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, kind=excluded.kind, value_json=excluded.value_json, severity=excluded.severity, created_at=excluded.created_at, updated_at=excluded.updated_at`,
    ).run(anchor.id, anchor.label, anchor.kind, JSON.stringify(anchor.value ?? null), anchor.severity, anchor.createdAt, anchor.updatedAt);
  }

  private toAnchor(row: AnchorRow): SurvivalAnchor {
    return {
      id: row.id,
      label: row.label,
      kind: row.kind as SurvivalAnchorKind,
      value: JSON.parse(row.value_json),
      severity: row.severity,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
