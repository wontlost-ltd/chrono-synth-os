/**
 * ChronoCompanion C 端数据契约 —「让 TA 听一段 / 看一段」感知（ADR-0051 感知层 / ADR-0046）。
 *
 * 用户把一段经历（已转写的语音 transcript / 视频场景描述）交给数字人，人格用确定性感知蒸馏器
 * 把它沉淀为 episodic 记忆，并以「人格视角」反馈「我听到/看到了什么、记住了什么」。
 *
 * 论点（ADR-0051）：多模态模型是「感官老师」，只在摄取阶段把媒体翻译成表征——本接口接收的
 * `representation` 是**已脱离原始媒体**的中间表征（前端 ASR / 用户输入 / 视频抽帧描述），
 * 服务端不碰原始媒体（原始音视频绝不进库，见 ADR-0052 Edge-P5）。感知产物经蒸馏门：事实
 * 记忆 append，身份层提案默认 pending 人工审批——绝不自动改身份核。
 *
 * 端到端类型安全：后端 src/server/routes/companion/perceive.ts 序列化，前端 companion-web 消费。
 */

import { z } from 'zod';

/** 感知模态。第一阶段聚焦 audio；video 预留。 */
export const PerceptionModalityV1Schema = z.enum(['audio', 'video']);

/* ── 请求：POST /api/v1/companion/me/perceive ─────────────────────── */

/** 表征长度上限（防滥用/超长 payload；中间表征是 transcript/描述，非原始媒体）。 */
export const PERCEIVE_REPRESENTATION_MAX_LEN = 4000;

export const CompanionPerceiveRequestV1Schema = z.object({
  modality: PerceptionModalityV1Schema,
  /** 已转写/描述的中间表征（前端 ASR 或用户输入）；服务端绝不接收原始媒体二进制。 */
  representation: z.string().min(1).max(PERCEIVE_REPRESENTATION_MAX_LEN),
}).strict();

export type CompanionPerceiveRequestV1 = z.infer<typeof CompanionPerceiveRequestV1Schema>;

/* ── 响应：人格视角的感知反馈 ──────────────────────────────────────── */

/** 一条新沉淀的感知记忆（人格第一人称）。 */
export const PerceivedMemoryV1Schema = z.object({
  id: z.string().min(1),
  /** 人格第一人称的事实摘要，如「我听到：今天开会很累」。 */
  content: z.string(),
  valence: z.number().min(-1).max(1),
  salience: z.number().min(0).max(1),
}).strict();

export const CompanionPerceiveResultV1Schema = z.object({
  schemaVersion: z.literal('companion-perceive-result.v1'),
  /** 本次感知新沉淀的事实记忆（人格记住了什么）。 */
  perceivedMemories: z.array(PerceivedMemoryV1Schema),
  /**
   * 是否产生了「成长候选」（memory_edge / 身份提案进蒸馏门）。身份层候选默认 pending 人工审批，
   * 不自动改人格——前端可据此提示「这段经历可能影响我对你的理解，待你确认」。
   */
  growthCandidateCount: z.number().int().nonnegative(),
  /** 待人工审批的身份层候选数（pending，绝不自动应用）。 */
  pendingApprovalCount: z.number().int().nonnegative(),
}).strict();

export type CompanionPerceiveResultV1 = z.infer<typeof CompanionPerceiveResultV1Schema>;
