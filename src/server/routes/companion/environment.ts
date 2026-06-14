/**
 * ChronoCompanion C 端路由 — 设备环境感知（ADR-0052 Edge-P1 确定性环境旁路接入生产路径）。
 *
 * 把已就绪的 EnvironmentSignalExtractor + EnvironmentObserver 第一次接入运行 app：设备/前端上报
 * 一窗低维传感器信号（光/声/运动）→ **确定性 DSP** 提取离散环境状态 → 沉淀环境观察记忆 → 返回。
 *
 * 论点红线（与 ADR-0052/0051 一致）：
 *   - 纯确定性，**绝不调 LLM/模型**——环境感知是确定性旁路，断网无云仍可（端侧自治）。
 *   - 只 append 事实记忆，**绝不自动改身份核**（EnvironmentObserver 保证）。
 *
 * 已知边界（诚实标注）：本 route 的 EnvironmentObserver 是 per-request 构造——**跨请求的环境状态
 * 变化检测与去重**（避免每窗都记一条）需 observer 持有跨请求状态：要么端侧设备本地持有（ADR-0052
 * 端侧自治），要么服务端持久化（Edge-P3）。本切片每窗以「首次观察」语义沉淀当前环境记忆，去重是后续。
 *
 * 复用 companion/me.ts 的访问门 + 租户隔离 + 私有缓存头。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';
import type { JwtPayload } from '../../../types/auth.js';
import { AuthorizationError, ErrorCode } from '../../../errors/index.js';
import {
  CompanionEnvironmentRequestV1Schema,
  CompanionEnvironmentResultV1Schema,
  type CompanionEnvironmentResultV1,
} from '@chrono/contracts';
import { EnvironmentSignalExtractor } from '../../../perception/environment/environment-signal-extractor.js';
import { EnvironmentObserver } from '../../../perception/environment/environment-observer.js';
import type { EnvironmentState, ChannelState } from '../../../perception/environment/environment-signal.js';

export function registerCompanionEnvironmentRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory: TenantOSFactory | undefined,
): void {
  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /* 与 companion/me.ts 同款访问门：仅个人用户会话，拒 API-key/service + enterprise plan。 */
  function assertCompanionAccess(request: FastifyRequest): void {
    const user = request.user as JwtPayload | undefined;
    if (user?.sub?.startsWith('apikey:') || user?.role === 'service') {
      throw new AuthorizationError(
        'companion 接口仅支持个人用户会话，不支持 API Key / service 主体访问',
        ErrorCode.AUTH_INSUFFICIENT_ROLE,
      );
    }
    if (user?.planId === 'enterprise') {
      throw new AuthorizationError(
        'companion 接口面向个人版账号；enterprise 账号请使用企业控制台',
        ErrorCode.AUTH_INSUFFICIENT_ROLE,
      );
    }
  }

  function setPrivateNoStore(reply: FastifyReply): void {
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Vary', 'Authorization, X-Tenant-Id');
  }

  /* POST /api/v1/companion/me/environment — 设备上报环境信号 */
  app.post('/api/v1/companion/me/environment', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const body = CompanionEnvironmentRequestV1Schema.parse(request.body);
    const tenantOS = getOS(request);

    /* 确定性提取（无 LLM）+ 沉淀环境记忆（per-request observer，首次观察语义）。 */
    const extractor = new EnvironmentSignalExtractor();
    const state = extractor.extract(body.samples);
    const observer = new EnvironmentObserver(tenantOS.core.memories);
    const observed = observer.observe(state);

    const states = collectStates(state);
    const payload: CompanionEnvironmentResultV1 = {
      schemaVersion: 'companion-environment-result.v1',
      states,
      sensedMemoryCount: observed.memoryIds.length,
    };
    return { data: CompanionEnvironmentResultV1Schema.parse(payload) };
  });
}

/** EnvironmentState → 各通道的离散状态视图（脱去聚合数值，只留 level + confidence）。 */
function collectStates(state: EnvironmentState): Array<{ channel: 'light' | 'sound' | 'motion'; level: string; confidence: number }> {
  const out: Array<{ channel: 'light' | 'sound' | 'motion'; level: string; confidence: number }> = [];
  for (const channel of ['light', 'sound', 'motion'] as const) {
    const cs = state[channel] as ChannelState | undefined;
    if (cs) out.push({ channel, level: cs.level, confidence: cs.confidence });
  }
  return out;
}
