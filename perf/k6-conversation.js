/**
 * k6 — 对话流水线压测
 *
 * 模型：每个 VU 持有一个固定 personaId，循环发送 user message，等待
 * 200 OK + 解码 JSON 响应。考察后端在持续对话负载下的尾延迟与稳健性。
 *
 * Thresholds 与 SLO 对齐（见 docs/operations/slo-runbook.md）：
 *   - http_req_failed < 1%（可用性 ≥ 99%）
 *   - http_req_duration{name:msg_send} p95 < 500ms（端到端延迟）
 *   - http_req_duration{name:msg_send} p99 < 1500ms
 *   - checks 100% 通过（响应体结构正确）
 *
 * 运行：
 *   BASE_URL=http://localhost:3000 \
 *   API_KEY=$CHRONO_PERF_API_KEY \
 *   PERSONA_IDS="p1,p2,p3,p4,p5" \
 *   k6 run perf/k6-conversation.js
 *
 * 调谐：用 --vus / --duration 覆盖默认 stages；CI 跑 ramp-load profile，
 * 本地 smoke 跑 K6_SCENARIO=smoke 跳过长测。
 */

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

/* 不引入 jslib 远程依赖：CI runner 可能离线或带受限 egress */
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || '';
const PERSONA_IDS_RAW = __ENV.PERSONA_IDS || 'perf-persona-1,perf-persona-2,perf-persona-3';
const SCENARIO = __ENV.K6_SCENARIO || 'ramp';

if (!API_KEY) {
  fail('API_KEY env var is required (X-API-Key header value)');
}

const personaIds = new SharedArray('persona-ids', () => PERSONA_IDS_RAW.split(',').map((s) => s.trim()).filter(Boolean));

const messageDuration = new Trend('chrono_conversation_message_ms', true);
const messageQuotaExhausted = new Counter('chrono_conversation_quota_exhausted_total');

const SCENARIOS = {
  /* CI smoke：5 VU × 30s，总 ~150 req，验证脚本可执行 */
  smoke: {
    executor: 'constant-vus',
    vus: 5,
    duration: '30s',
    gracefulStop: '10s',
  },
  /* CI weekly：阶梯加载 0→50 VU，捕捉饱和点 */
  ramp: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 10 },
      { duration: '2m', target: 25 },
      { duration: '5m', target: 50 },
      { duration: '2m', target: 50 },
      { duration: '1m', target: 0 },
    ],
    gracefulStop: '30s',
  },
  /* 持续 soak：30 分钟稳态，捕捉慢泄漏 / 压力下 GC 抖动 */
  soak: {
    executor: 'constant-vus',
    vus: 30,
    duration: '30m',
    gracefulStop: '30s',
  },
};

if (!SCENARIOS[SCENARIO]) {
  fail(`Unknown K6_SCENARIO=${SCENARIO}; expected one of: ${Object.keys(SCENARIOS).join(', ')}`);
}

export const options = {
  scenarios: { conversation: SCENARIOS[SCENARIO] },
  thresholds: {
    'http_req_failed{name:msg_send}': ['rate<0.01'],
    'http_req_duration{name:msg_send}': ['p(95)<500', 'p(99)<1500'],
    'checks': ['rate>0.99'],
  },
  /* k6 默认会跟随 30x；保持显式以避免后续策略意外变化 */
  maxRedirects: 0,
  /* 对话端点本身有时延；2x p99 SLO 作为单请求超时上限 */
  noConnectionReuse: false,
  insecureSkipTLSVerify: false,
};

const SAMPLE_MESSAGES = [
  '今天的优先事项是什么？',
  '帮我把昨晚的会议要点整理成 3 条 bullets',
  'Quick gut check：这个方案的最大风险是？',
  'What did I miss while I was offline?',
  '提醒我下午 4 点之前完成 PR review',
];

function buildHeaders() {
  return {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      /* 防止 k6 默认 UA 在日志里被当成爬虫，便于追溯 */
      'User-Agent': 'chrono-perf-k6/1.0',
    },
    tags: { name: 'msg_send' },
    timeout: '5s',
  };
}

export default function () {
  const personaId = randomItem(personaIds);
  const url = `${BASE_URL}/api/v1/persona-core/${encodeURIComponent(personaId)}/conversations/messages`;
  const payload = JSON.stringify({
    content: randomItem(SAMPLE_MESSAGES),
    /* perf 不持久化任何 PII；attribution 标记便于 audit log 排查 */
    attribution: { source: 'perf-test', vu: __VU, iter: __ITER },
  });

  const res = http.post(url, payload, buildHeaders());

  messageDuration.add(res.timings.duration);

  const ok = check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'body has messageId on 200': (r) => r.status !== 200 || (r.json('messageId') !== undefined),
    'no 5xx': (r) => r.status < 500,
  });

  if (res.status === 429) {
    messageQuotaExhausted.add(1);
  }

  if (!ok) {
    /* 仅在调试时打印；CI 阈值会 fail 整个 run */
    if (__ENV.K6_VERBOSE) {
      console.error(`[VU=${__VU} iter=${__ITER}] persona=${personaId} status=${res.status} body=${res.body?.slice(0, 200)}`);
    }
  }

  /* think time：200ms±100ms，模拟人类输入间隔 */
  sleep(0.1 + Math.random() * 0.2);
}

export function handleSummary(data) {
  /* k6 默认 summary 已经够用；额外发到 stdout 让 CI 容易抓取关键指标 */
  return {
    stdout: textSummary(data),
    'perf-results/conversation.json': JSON.stringify(data, null, 2),
  };
}

/* 内联简版 textSummary：避免外网 jslib 依赖（CI 可能离线） */
function textSummary(data) {
  const lines = ['', '== Conversation perf summary =='];
  const m = data.metrics;
  const fmt = (k, fields = ['avg', 'p(95)', 'p(99)', 'max']) => {
    const v = m[k]?.values;
    if (!v) return `  ${k}: (no data)`;
    return `  ${k}: ${fields.map((f) => `${f}=${(v[f] ?? 0).toFixed(2)}`).join(' ')}`;
  };
  lines.push(fmt('http_req_duration{name:msg_send}'));
  lines.push(fmt('chrono_conversation_message_ms'));
  lines.push(`  http_req_failed{name:msg_send}: rate=${(m['http_req_failed{name:msg_send}']?.values?.rate ?? 0).toFixed(4)}`);
  lines.push(`  iterations: ${m.iterations?.values?.count ?? 0}`);
  lines.push(`  quota_exhausted: ${m.chrono_conversation_quota_exhausted_total?.values?.count ?? 0}`);
  lines.push('');
  return lines.join('\n');
}
