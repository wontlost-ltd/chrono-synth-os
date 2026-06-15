/**
 * ChronoCompanion C 端 — 实时流感知 WebSocket（ADR-0051 Phase 5）。
 *
 * 让人格**动态**认识世界：客户端经 WS 把流式中间表征**分片**上报（实时 ASR 增量 / 视频抽帧描述
 * 逐帧），服务端 per-connection 累积，finalize 时**异步**跑与一次性 perceive 同一条 PerceptionDistiller，
 * 不阻塞连接/决策主循环——回一帧 perceived。
 *
 * 论点红线（与 ADR-0051 一致，流式不放松）：
 *   - 服务端**只收已脱离原始媒体的文本表征**，绝不收原始音视频二进制（chunk 是文本，单帧 + 累积都有上限）。
 *   - 累积全文走同一条 PerceptionDistiller（确定性蒸馏门）——事实记忆 append、身份提案默认 pending，
 *     绝不自动改身份核。
 *   - 蒸馏异步（不在收帧回调里 await 阻塞）；蒸馏期间允许继续收下一段（reset/新 chunk）。
 *
 * 鉴权：复用 JWT preHandler（request.user）+ companion 访问门（拒 API-key/service/enterprise）。
 * 限额：单帧 chunk ≤ PERCEIVE_STREAM_CHUNK_MAX_LEN；累积 ≤ PERCEIVE_REPRESENTATION_MAX_LEN；
 *      finalize 前查 perception 配额（与一次性 perceive 同口径，防 BYOK LLM 刷爆）。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';
import type { IDatabase } from '../../../storage/database.js';
import type { AppConfig } from '../../../config/schema.js';
import type { JwtPayload } from '../../../types/auth.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  PerceiveStreamClientFrameSchema,
  PERCEIVE_REPRESENTATION_MAX_LEN,
  type PerceiveStreamServerFrame,
} from '@chrono/contracts';
import { perceptionEventInsert } from '@chrono/kernel';
import { QuotaManager } from '../../../multi-tenant/quota-manager.js';
import { PerceptionDistiller } from '../../../perception/perception-distiller.js';
import type { PerceptionProvider } from '../../../perception/perception-provider.js';
import { tryByokEncryption } from '../../../storage/llm-credential-store.js';
import { selectPerceptionProvider } from './perception-provider-factory.js';

/** WS 单帧字节上限（防超大帧；chunk 文本上限另由契约管）。 */
const WS_FRAME_MAX_BYTES = 8192;
/** 连接级消息速率上限（条/秒）——防高频刷非法帧/空 finalize/小 chunk（配额只在 finalize 扣，挡不住这些）。 */
const WS_MAX_MESSAGES_PER_SECOND = 30;

interface MinimalSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message' | 'close' | 'error', cb: (arg?: unknown) => void): void;
}

/** safe send：仅在连接打开时发，且吞发送异常（close 竞态下 send 仍可能抛）——与主 /ws safeSend 同款。 */
function send(socket: MinimalSocket, frame: PerceiveStreamServerFrame): void {
  if (socket.readyState !== 1) return;
  try { socket.send(JSON.stringify(frame)); } catch { /* 发送失败（连接已断）无害，忽略 */ }
}

export function registerCompanionPerceiveStreamRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory: TenantOSFactory | undefined,
  db?: IDatabase,
  config?: AppConfig,
  /** 测试注入 provider（给定则所有租户用它）。 */
  injectedProvider?: PerceptionProvider,
): void {
  /* WS 插件关闭时不注册此流式入口（它依赖 @fastify/websocket；否则 { websocket: true } 无意义）。 */
  if (config && !config.websocket.enabled) return;

  const sharedDb = db ?? os.getDatabase();
  const llmEncryption = config ? tryByokEncryption(config.encryption) : undefined;
  const quotaManager = new QuotaManager(sharedDb);

  function getOS(tenantId: string): ChronoSynthOS {
    if (tenantFactory && tenantId && tenantId !== 'default') return tenantFactory.getTenantOS(tenantId);
    return os;
  }

  function assertCompanionAccess(user: JwtPayload | undefined): boolean {
    if (user?.sub?.startsWith('apikey:') || user?.role === 'service') return false;
    if (user?.planId === 'enterprise') return false;
    return true;
  }

  app.get('/api/v1/companion/me/perceive/stream', { websocket: true }, (socket: MinimalSocket, request: FastifyRequest) => {
    const user = request.user as JwtPayload | undefined;
    if (config?.jwt.enabled && !user?.sub) {
      socket.close(4001, 'Authentication required');
      return;
    }
    if (!assertCompanionAccess(user)) {
      socket.close(4003, 'companion stream 仅支持个人用户会话');
      return;
    }
    const tenantId = user?.tenantId ?? request.tenantId ?? 'default';

    /* per-connection 累积缓冲（bounded）。distilling 标记：蒸馏进行中拒绝并发 finalize（可继续累积下一段，
     * 但不能提交，直到上一段完成）。 */
    let accumulated = '';
    let modality: 'audio' | 'video' = 'audio';
    let distilling = false;
    let closed = false;

    /* 连接级消息速率限制（防高频刷帧——配额只在 finalize 扣，挡不住非法帧/空 finalize/reset/小 chunk）。 */
    let messageCount = 0;
    const rateLimitReset = setInterval(() => { messageCount = 0; }, 1000);
    rateLimitReset.unref?.();
    function cleanup(): void { closed = true; clearInterval(rateLimitReset); }
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    socket.on('message', (raw) => {
      if (closed) return;
      const text = typeof raw === 'string' ? raw : String(raw);
      if (Buffer.byteLength(text, 'utf8') > WS_FRAME_MAX_BYTES) {
        send(socket, { type: 'error', code: 'CHUNK_TOO_LARGE', message: `帧不得超过 ${WS_FRAME_MAX_BYTES} 字节` });
        return;
      }
      messageCount += 1;
      if (messageCount > WS_MAX_MESSAGES_PER_SECOND) {
        send(socket, { type: 'error', code: 'RATE_LIMIT', message: '消息速率超限，请等待 1 秒后重试' });
        return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch {
        send(socket, { type: 'error', code: 'INVALID_FRAME', message: '帧不是合法 JSON' });
        return;
      }
      const frame = PerceiveStreamClientFrameSchema.safeParse(parsed);
      if (!frame.success) {
        send(socket, { type: 'error', code: 'INVALID_FRAME', message: '帧不符合协议' });
        return;
      }

      if (frame.data.type === 'reset') {
        accumulated = '';
        send(socket, { type: 'ack', accumulatedLength: 0, maxLength: PERCEIVE_REPRESENTATION_MAX_LEN });
        return;
      }

      if (frame.data.type === 'chunk') {
        modality = frame.data.modality;
        if (accumulated.length + frame.data.chunk.length > PERCEIVE_REPRESENTATION_MAX_LEN) {
          send(socket, { type: 'error', code: 'BUFFER_FULL', message: `累积已达上限 ${PERCEIVE_REPRESENTATION_MAX_LEN}，请 finalize 或 reset` });
          return;
        }
        accumulated += frame.data.chunk;
        send(socket, { type: 'ack', accumulatedLength: accumulated.length, maxLength: PERCEIVE_REPRESENTATION_MAX_LEN });
        return;
      }

      /* finalize：触发异步蒸馏。 */
      if (distilling) {
        send(socket, { type: 'error', code: 'BUSY', message: '上一段仍在处理，请稍候' });
        return;
      }
      const representation = accumulated.trim();
      if (representation.length === 0) {
        send(socket, { type: 'error', code: 'EMPTY_FINALIZE', message: '没有累积任何内容' });
        return;
      }
      /* 配额（与一次性 perceive 同口径，防 BYOK LLM 刷爆）。 */
      if (!quotaManager.consumeQuota(tenantId, 'perception')) {
        send(socket, { type: 'error', code: 'QUOTA_EXCEEDED', message: '感知配额已用尽，请稍后再试' });
        return;
      }

      distilling = true;
      accumulated = '';  /* 清空，允许 finalize 后继续收下一段。 */
      const capturedModality = modality;
      void distillAsync(tenantId, representation, capturedModality)
        .then((frameOut) => { if (!closed) send(socket, frameOut); })
        .catch(() => { if (!closed) send(socket, { type: 'error', code: 'INTERNAL', message: '感知处理失败' }); })
        .finally(() => { distilling = false; });
    });
  });

  /** 异步蒸馏累积全文：与一次性 perceive 同一条 PerceptionDistiller + 审计落库。 */
  async function distillAsync(
    tenantId: string,
    representation: string,
    modalityIn: 'audio' | 'video',
  ): Promise<PerceiveStreamServerFrame> {
    const tenantOS = getOS(tenantId);
    const representationSha256 = createHash('sha256').update(representation).digest('hex');
    const provider = selectPerceptionProvider(tenantId, sharedDb, config, llmEncryption, injectedProvider);
    const distiller = new PerceptionDistiller(provider, tenantOS.core.memories, tenantOS.distillation);
    const result = await distiller.perceive({
      personaId: 'default',
      tenantId,
      media: { modality: modalityIn, mediaSha256: representationSha256, durationMs: 0, representation },
    });

    const perceivedMemories = result.memoryIds.map((id) => {
      const node = tenantOS.core.memories.getMemory(id);
      return { id, content: node?.content ?? '', valence: node?.valence ?? 0, salience: node?.salience ?? 0 };
    });
    const candidates = result.candidates.filter((c) => c.status !== 'rejected');
    const pendingApprovalCount = result.candidates.filter((c) => c.status === 'pending').length;

    /* 审计落库（best-effort，与一次性 perceive 同款）。 */
    try {
      sharedDb.execute(perceptionEventInsert({
        id: `pevt_${randomUUID()}`,
        tenantId,
        personaId: 'default',
        modality: modalityIn,
        representationSha256,
        providerName: provider.name,
        memoryCount: result.memoryIds.length,
        candidateCount: candidates.length,
        pendingCount: pendingApprovalCount,
        status: result.teacherFailed ? 'failed' : 'done',
        createdAt: Date.now(),
      }));
    } catch { /* 审计失败不拖垮流式响应 */ }

    return {
      type: 'perceived',
      result: {
        schemaVersion: 'companion-perceive-result.v1',
        perceivedMemories,
        /* 透明度：真 LLM 老师还是确定性回退（与一次性 perceive 同口径）。 */
        perceivedBy: provider.kind,
        growthCandidateCount: candidates.length,
        pendingApprovalCount,
      },
    };
  }
}
