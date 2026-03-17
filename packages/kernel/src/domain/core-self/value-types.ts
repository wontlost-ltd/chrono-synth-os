/** 价值维度唯一标识 */
export type ValueId = string;

/** 核心价值项 — 跨运行时共享的领域类型 */
export interface CoreValue {
  readonly id: ValueId;
  readonly label: string;
  weight: number;
  timeDiscount: number;
  emotionAmplifier: number;
  updatedAt: number;
}

/** 价值更新补丁 */
export interface CoreValuePatch {
  readonly weight?: number;
  readonly timeDiscount?: number;
  readonly emotionAmplifier?: number;
}
