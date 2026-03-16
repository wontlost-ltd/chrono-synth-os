/** 生存锚点类型 */
export type SurvivalAnchorKind = 'constraint' | 'threshold' | 'must_have';

/** L0 生存锚点 — 跨运行时共享的领域类型 */
export interface SurvivalAnchor {
  readonly id: string;
  readonly label: string;
  readonly kind: SurvivalAnchorKind;
  readonly value: unknown;
  readonly severity: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 锚点更新补丁 */
export interface SurvivalAnchorPatch {
  readonly label?: string;
  readonly kind?: SurvivalAnchorKind;
  readonly value?: unknown;
  readonly severity?: number;
}
