/**
 * ChronoSynth OS 客户端 SDK
 * 基于 fetch 的类型化 API 客户端
 */

export interface ChronoClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** 注入自定义 fetch（用于测试） */
  readonly fetch?: typeof globalThis.fetch;
}

export interface ApiResponse<T = unknown> {
  readonly data: T;
}

/** 错误响应体最大回显长度（防超长/日志污染）。 */
const MAX_ERROR_BODY = 200;

/**
 * 从失败响应提取安全的错误文案（全维评审 G2）：
 *   - 5xx：一律通用文案，绝不回显服务端响应体（即便服务端已脱敏，SDK 也不二次传播内部串）。
 *   - 4xx：优先取结构化 { error | message }（业务错误，对客户端有意义），截断到 MAX_ERROR_BODY；
 *     解析失败则回退截断后的原始文本。
 */
async function extractErrorMessage(res: Response): Promise<string> {
  if (res.status >= 500) return 'server error';
  let text = '';
  try {
    text = await res.text();
  } catch {
    return res.statusText || 'request failed';
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const msg = typeof parsed.error === 'string' ? parsed.error
      : typeof parsed.message === 'string' ? parsed.message
      : null;
    if (msg) return msg.slice(0, MAX_ERROR_BODY);
  } catch { /* 非 JSON，回退截断文本 */ }
  return text.slice(0, MAX_ERROR_BODY) || res.statusText || 'request failed';
}

export class ChronoClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: ChronoClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      /* 不裸抛原始响应体（全维评审 G2）：4xx 优先取结构化 {error/message}（截断防超长），
       * 5xx 一律通用文案（服务端已脱敏，但客户端不再二次传播任何服务端内部串）。 */
      throw new Error(`API 错误 ${res.status}: ${await extractErrorMessage(res)}`);
    }

    return (await res.json()) as T;
  }

  /* ===== 决策 ===== */

  createDecision(input: { title: string; description: string; alternatives?: string[]; constraints?: string[]; context?: Record<string, unknown> }): Promise<ApiResponse> {
    return this.request('POST', '/api/v1/decisions', input);
  }

  simulate(decisionId: string): Promise<ApiResponse> {
    return this.request('POST', `/api/v1/decisions/${decisionId}/simulate`);
  }

  getRun(decisionId: string, runId: string): Promise<ApiResponse> {
    return this.request('GET', `/api/v1/decisions/${decisionId}/runs/${runId}`);
  }

  submitFeedback(decisionId: string, feedback: { runId: string; selectedAlternative: string; satisfaction: number; notes?: string }): Promise<ApiResponse> {
    return this.request('POST', `/api/v1/decisions/${decisionId}/feedback`, feedback);
  }

  /* ===== 人格状态 ===== */

  getPersonaState(): Promise<ApiResponse> {
    return this.request('GET', '/api/v1/pos/state');
  }

  getStateSummary(): Promise<ApiResponse> {
    return this.request('GET', '/api/v1/pos/state/summary');
  }

  getDecisionStyle(): Promise<ApiResponse> {
    return this.request('GET', '/api/v1/pos/decision-style');
  }

  updateDecisionStyle(style: Record<string, number>): Promise<ApiResponse> {
    return this.request('PUT', '/api/v1/pos/decision-style', style);
  }

  getValues(): Promise<ApiResponse> {
    return this.request('GET', '/api/v1/values');
  }

  createValue(label: string, weight: number): Promise<ApiResponse> {
    return this.request('POST', '/api/v1/values', { label, weight });
  }

  /* ===== 可视化 ===== */

  getValuesVisualization(): Promise<ApiResponse> {
    return this.request('GET', '/api/v1/values/visualization');
  }

  getDecisionFingerprint(decisionId: string): Promise<ApiResponse> {
    return this.request('GET', `/api/v1/decisions/${decisionId}/fingerprint`);
  }

  /* ===== 引导 ===== */

  startOnboarding(): Promise<ApiResponse> {
    return this.request('POST', '/api/v1/onboarding/start');
  }

  submitOnboardingStep(sessionId: string, step: number, data?: Record<string, unknown>): Promise<ApiResponse> {
    return this.request('POST', `/api/v1/onboarding/step/${step}?sessionId=${encodeURIComponent(sessionId)}`, data ?? {});
  }

  getOnboardingStatus(sessionId: string): Promise<ApiResponse> {
    return this.request('GET', `/api/v1/onboarding/status/${sessionId}`);
  }

  submitQuestionnaire(responses: Array<{ id: string; score: number }>): Promise<ApiResponse> {
    return this.request('POST', '/api/v1/onboarding/questionnaire', { responses });
  }

  importData(payload: {
    journalEntries?: Array<{ content: string; valence?: number; salience?: number }>;
    decisionRecords?: Array<{ title: string; description: string; outcome?: string }>;
  }): Promise<ApiResponse> {
    return this.request('POST', '/api/v1/onboarding/import', payload);
  }

  /* ===== 隐私 ===== */

  exportData(): Promise<ApiResponse> {
    return this.request('POST', '/api/v1/privacy/export');
  }

  deleteData(): Promise<ApiResponse> {
    return this.request('DELETE', '/api/v1/privacy/data');
  }

  getAuditTrail(): Promise<ApiResponse> {
    return this.request('GET', '/api/v1/privacy/audit-trail');
  }
}
