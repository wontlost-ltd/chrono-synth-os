/**
 * ChronoCompanion C 端数据契约 — 实时流感知（ADR-0051 Phase 5）。
 *
 * 让人格**动态**认识世界：客户端通过 WebSocket 把一段流式中间表征**分片**（如实时 ASR 陆续出文、
 * 视频抽帧描述逐帧到达）上报，服务端累积后异步蒸馏，不阻塞——区别于一次性 POST /perceive。
 *
 * 论点红线（与 ADR-0051 一致，流式不放松）：
 *   - 服务端**只收已脱离原始媒体的文本表征**（前端 ASR / 抽帧描述），绝不收原始音视频二进制。
 *   - 累积全文走与一次性 perceive **同一条** PerceptionDistiller（确定性蒸馏门）——事实记忆 append、
 *     身份层提案默认 pending 人工审批，绝不自动改身份核。
 *   - 异步蒸馏不阻塞连接/决策主循环（ADR-0051 不变量 5）。
 *
 * 帧协议（JSON over WS）：客户端发 chunk/finalize，服务端回 ack/perceived/error。
 */

import { z } from 'zod';
import { PERCEIVE_REPRESENTATION_MAX_LEN, CompanionPerceiveResultV1Schema, PerceptionModalityV1Schema } from './perceive.js';

/** 单帧 chunk 文本上限（防单帧滥用；累积总量另有 PERCEIVE_REPRESENTATION_MAX_LEN 上限）。 */
export const PERCEIVE_STREAM_CHUNK_MAX_LEN = 1000;

/* ── 客户端 → 服务端帧 ─────────────────────────────────────────────── */

/** chunk：追加一段流式表征（如一句 ASR 增量）。 */
export const PerceiveStreamChunkFrameSchema = z.object({
  type: z.literal('chunk'),
  /** 与一次性 perceive 同源（audio/video）。 */
  modality: PerceptionModalityV1Schema,
  /** 本片表征文本（已脱离原始媒体）。 */
  chunk: z.string().min(1).max(PERCEIVE_STREAM_CHUNK_MAX_LEN),
}).strict();

/** finalize：结束本段流，触发异步蒸馏累积全文。 */
export const PerceiveStreamFinalizeFrameSchema = z.object({
  type: z.literal('finalize'),
}).strict();

/** reset：丢弃当前累积（重新开始一段，不蒸馏）。 */
export const PerceiveStreamResetFrameSchema = z.object({
  type: z.literal('reset'),
}).strict();

export const PerceiveStreamClientFrameSchema = z.discriminatedUnion('type', [
  PerceiveStreamChunkFrameSchema,
  PerceiveStreamFinalizeFrameSchema,
  PerceiveStreamResetFrameSchema,
]);

/* ── 服务端 → 客户端帧 ─────────────────────────────────────────────── */

/** ack：确认收到 chunk，回当前累积长度（客户端可据此判断接近上限）。 */
export const PerceiveStreamAckFrameSchema = z.object({
  type: z.literal('ack'),
  /** 当前已累积字符数。 */
  accumulatedLength: z.number().int().nonnegative(),
  /** 累积上限（达此值后 chunk 被拒）。 */
  maxLength: z.literal(PERCEIVE_REPRESENTATION_MAX_LEN),
}).strict();

/** perceived：异步蒸馏完成，回人格记住的（复用一次性 perceive 结果形状）。 */
export const PerceiveStreamPerceivedFrameSchema = z.object({
  type: z.literal('perceived'),
  result: CompanionPerceiveResultV1Schema,
}).strict();

/** error：协议/限额/蒸馏错误。 */
export const PerceiveStreamErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: z.enum(['INVALID_FRAME', 'CHUNK_TOO_LARGE', 'BUFFER_FULL', 'EMPTY_FINALIZE', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'BUSY', 'INTERNAL']),
  message: z.string(),
}).strict();

export const PerceiveStreamServerFrameSchema = z.discriminatedUnion('type', [
  PerceiveStreamAckFrameSchema,
  PerceiveStreamPerceivedFrameSchema,
  PerceiveStreamErrorFrameSchema,
]);

export type PerceiveStreamClientFrame = z.infer<typeof PerceiveStreamClientFrameSchema>;
export type PerceiveStreamServerFrame = z.infer<typeof PerceiveStreamServerFrameSchema>;
