/**
 * ChronoCompanion C 端数据契约 — 设备环境感知（ADR-0052 Edge-P1 确定性环境旁路接入）。
 *
 * 设备/前端上报一窗低维传感器信号（光/声/运动）→ 服务端用**确定性 DSP**（无 LLM）提取离散环境
 * 状态 + 沉淀环境观察记忆。论点：环境感知是确定性旁路，断网无云仍可（端侧自治），绝不调模型、
 * 不改身份核（只 append 事实记忆）。
 *
 * 端到端类型安全：后端 src/server/routes/companion/environment.ts 序列化，前端/设备 SDK 消费。
 */

import { z } from 'zod';

/** 信号通道（与 src/perception/environment EnvironmentChannel 同源）。 */
export const EnvironmentChannelV1Schema = z.enum(['light', 'sound', 'motion']);

/* ── 请求：POST /api/v1/companion/me/environment ───────────────────── */

/** 单窗最多样本数（防滥用；一窗是一次上报的传感器读数序列）。 */
export const ENVIRONMENT_MAX_SAMPLES = 1000;

/** 一个传感器读数样本。 */
export const EnvironmentSampleV1Schema = z.object({
  channel: EnvironmentChannelV1Schema,
  /** 原始读数（light=lux；sound=相对声压 0..1 或 dB；motion=强度 0..1）。 */
  value: z.number(),
  /** 采样时刻（epoch ms）。 */
  at: z.number().int().nonnegative(),
}).strict();

export const CompanionEnvironmentRequestV1Schema = z.object({
  /** 一窗信号样本（可混合多通道）。 */
  samples: z.array(EnvironmentSampleV1Schema).min(1).max(ENVIRONMENT_MAX_SAMPLES),
}).strict();

export type CompanionEnvironmentRequestV1 = z.infer<typeof CompanionEnvironmentRequestV1Schema>;

/* ── 响应：提取的环境状态 + 沉淀的环境记忆 ────────────────────────── */

/** 单通道环境状态（离散分级 + 置信度）。 */
export const EnvironmentChannelStateV1Schema = z.object({
  channel: EnvironmentChannelV1Schema,
  /** 离散分级，如 dark/dim/normal/bright（light）。 */
  level: z.string().min(1),
  confidence: z.number().min(0).max(1),
}).strict();

export const CompanionEnvironmentResultV1Schema = z.object({
  schemaVersion: z.literal('companion-environment-result.v1'),
  /** 本窗提取的各通道环境状态。 */
  states: z.array(EnvironmentChannelStateV1Schema),
  /** 本窗因环境（相对本次 observer 基线）沉淀的环境记忆条数。 */
  sensedMemoryCount: z.number().int().nonnegative(),
}).strict();

export type CompanionEnvironmentResultV1 = z.infer<typeof CompanionEnvironmentResultV1Schema>;
