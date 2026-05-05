/**
 * calendar — Google Calendar 工具
 *
 * 操作：list / get / create / update / delete
 * - list / get：低风险（read），不强制确认
 * - create / update / delete：高风险（highRisk=true），强制二次确认
 *
 * 幂等：create/update 必须带 idempotencyKey；同一 key 复用既有 event
 *       （在 metadata 中记录 chrono.idempotencyKey）
 *
 * mock provider：仅用于测试，不真实调用 Google API。
 */

import { createHash } from 'node:crypto';
import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import { getGoogleAccessToken } from './google-auth.js';
import type { Logger } from '../../utils/logger.js';
import { ValidationError, StateError, ErrorCode } from '../../errors/index.js';

export interface CalendarOptions {
  readonly provider: 'google' | 'mock';
  readonly serviceAccountJson?: string;
  readonly oauthAccessToken?: string;
  readonly defaultTimezone: string;
}

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
const ACTION_TIMEOUT_MS = 20_000;
type CalendarAction = 'list' | 'get' | 'create' | 'update' | 'delete';
const HIGH_RISK_ACTIONS = new Set<CalendarAction>(['create', 'update', 'delete']);

export class CalendarTool implements ToolAdapter {
  readonly metadata = {
    id: 'calendar',
    displayName: 'Google Calendar',
    description: 'Google Calendar 集成：list/get/create/update/delete events',
    /* 整个工具标记为高风险；流水线对每次调用都强制二次确认 */
    highRisk: true,
    defaultTimeoutMs: ACTION_TIMEOUT_MS,
    defaultMaxPerDay: 100,
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'] },
        calendarId: { type: 'string', default: 'primary', maxLength: 256 },
        eventId: { type: 'string', maxLength: 256 },
        idempotencyKey: { type: 'string', maxLength: 64 },
        timeMin: { type: 'string', description: 'RFC3339 timestamp' },
        timeMax: { type: 'string', description: 'RFC3339 timestamp' },
        maxResults: { type: 'number', minimum: 1, maximum: 250 },
        event: {
          type: 'object',
          description: 'create/update 时的事件对象（subset of Google Calendar Event）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  };

  constructor(
    private readonly options: CalendarOptions,
    logger: Logger,
  ) {
    if (options.provider === 'google' && !options.serviceAccountJson && !options.oauthAccessToken) {
      logger.warn('CalendarTool', 'provider=google 但未配置 serviceAccountJson/oauthAccessToken；调用时将抛错');
    }
  }

  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    const action = requireString(ctx.arguments, 'action') as CalendarAction;
    if (!HIGH_RISK_ACTIONS.has(action) && action !== 'list' && action !== 'get') {
      throw new ValidationError(`非法 action: ${action}`, ErrorCode.VALIDATION_FORMAT);
    }
    const calendarId = (ctx.arguments['calendarId'] as string | undefined) ?? 'primary';

    if (this.options.provider === 'mock') {
      return mockResult(action, calendarId, ctx.arguments);
    }

    /* 优先使用 ctx.oauthResolver（用户级授权）；fallback 到 service account */
    const userToken = ctx.oauthResolver ? await ctx.oauthResolver(SCOPE) : null;
    if (ctx.oauthResolver && userToken === null && !this.options.serviceAccountJson) {
      throw new StateError(
        '用户尚未授权 Google Calendar；请先完成 OAuth 流程',
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }
    const accessToken = userToken ?? await getGoogleAccessToken({
      scope: SCOPE,
      serviceAccountJson: this.options.serviceAccountJson,
      oauthAccessToken: this.options.oauthAccessToken,
    });

    switch (action) {
      case 'list':   return await this.list(calendarId, ctx.arguments, accessToken, ctx.deadline);
      case 'get':    return await this.get(calendarId, ctx.arguments, accessToken, ctx.deadline);
      case 'create': return await this.create(calendarId, ctx.arguments, accessToken, ctx.deadline);
      case 'update': return await this.update(calendarId, ctx.arguments, accessToken, ctx.deadline);
      case 'delete': return await this.delete(calendarId, ctx.arguments, accessToken, ctx.deadline);
    }
  }

  private async list(calendarId: string, args: Record<string, unknown>, token: string, deadline: number): Promise<ToolInvocationResult> {
    const params = new URLSearchParams();
    if (typeof args['timeMin'] === 'string') params.set('timeMin', args['timeMin'] as string);
    if (typeof args['timeMax'] === 'string') params.set('timeMax', args['timeMax'] as string);
    if (typeof args['maxResults'] === 'number') params.set('maxResults', String(args['maxResults']));
    params.set('timeZone', this.options.defaultTimezone);
    params.set('singleEvents', 'true');
    params.set('orderBy', 'startTime');

    const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
    const json = await this.fetchJson(url, { method: 'GET' }, token, deadline);
    return wrapJson(json);
  }

  private async get(calendarId: string, args: Record<string, unknown>, token: string, deadline: number): Promise<ToolInvocationResult> {
    const eventId = requireString(args, 'eventId');
    const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const json = await this.fetchJson(url, { method: 'GET' }, token, deadline);
    return wrapJson(json);
  }

  private async create(calendarId: string, args: Record<string, unknown>, token: string, deadline: number): Promise<ToolInvocationResult> {
    const event = requireObject(args, 'event');
    const idempotencyKey = (args['idempotencyKey'] as string | undefined) ?? '';
    const finalEvent = idempotencyKey
      ? { ...event, extendedProperties: { ...(event.extendedProperties as object | undefined), private: { 'chrono.idempotencyKey': idempotencyKey } } }
      : event;

    const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
    const json = await this.fetchJson(url, {
      method: 'POST',
      body: JSON.stringify(finalEvent),
      headers: { 'content-type': 'application/json' },
    }, token, deadline);
    return wrapJson(json);
  }

  private async update(calendarId: string, args: Record<string, unknown>, token: string, deadline: number): Promise<ToolInvocationResult> {
    const eventId = requireString(args, 'eventId');
    const event = requireObject(args, 'event');
    const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const json = await this.fetchJson(url, {
      method: 'PATCH',
      body: JSON.stringify(event),
      headers: { 'content-type': 'application/json' },
    }, token, deadline);
    return wrapJson(json);
  }

  private async delete(calendarId: string, args: Record<string, unknown>, token: string, deadline: number): Promise<ToolInvocationResult> {
    const eventId = requireString(args, 'eventId');
    const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    await this.fetchJson(url, { method: 'DELETE' }, token, deadline, { allowEmpty: true });
    return wrapJson({ deleted: true, eventId });
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
    accessToken: string,
    deadline: number,
    opts: { allowEmpty?: boolean } = {},
  ): Promise<unknown> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new StateError('calendar 调用截止时间已过', ErrorCode.STATE_INVALID_TRANSITION);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, ACTION_TIMEOUT_MS));
    try {
      const res = await fetch(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new StateError(`Google Calendar API HTTP ${res.status}: ${errBody.slice(0, 200)}`, ErrorCode.STATE_INVALID_TRANSITION);
      }
      if (res.status === 204 || (opts.allowEmpty && res.headers.get('content-length') === '0')) {
        return {};
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

function wrapJson(json: unknown): ToolInvocationResult {
  const text = JSON.stringify(json);
  return {
    content: [{ type: 'json', json }],
    costCents: 0,
    outputSizeBytes: Buffer.byteLength(text, 'utf8'),
  };
}

function mockResult(action: CalendarAction, calendarId: string, args: Record<string, unknown>): ToolInvocationResult {
  const result = {
    mock: true,
    action,
    calendarId,
    eventId: typeof args['eventId'] === 'string' ? args['eventId'] : `mock_evt_${shortHash(JSON.stringify(args))}`,
  };
  const text = JSON.stringify(result);
  return {
    content: [{ type: 'json', json: result }],
    costCents: 0,
    outputSizeBytes: Buffer.byteLength(text, 'utf8'),
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`参数 ${key} 必须为非空字符串`, ErrorCode.VALIDATION_REQUIRED);
  }
  return value;
}

function requireObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`参数 ${key} 必须为对象`, ErrorCode.VALIDATION_REQUIRED);
  }
  return value as Record<string, unknown>;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}
