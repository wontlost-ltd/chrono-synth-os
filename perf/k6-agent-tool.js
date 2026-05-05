/**
 * k6 — agent 工具调用流水线压测（MCP JSON-RPC）
 *
 * 模型：每个 VU 通过 POST /api/v1/mcp 走 JSON-RPC 调一个低风险工具
 * （默认 web_search），偶尔轮询一次 tools/list 验证 schema 暴露。
 * 不触发高风险工具（email.send / calendar.create），避免压测产生
 * 真实副作用。
 *
 * Thresholds 与 SLO 对齐：
 *   - http_req_failed{name:tool_call} < 0.5%（工具成功率 SLO 99.5%）
 *   - http_req_duration{name:tool_call} p95 < 800ms
 *   - http_req_duration{name:tool_call} p99 < 2500ms
 *   - 不能出现 5xx
 *
 * 运行：
 *   BASE_URL=http://localhost:3000 \
 *   BEARER_TOKEN=$(echo $JWT) \
 *   PERSONA_IDS="p1,p2,p3" \
 *   k6 run perf/k6-agent-tool.js
 */

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const BEARER_TOKEN = __ENV.BEARER_TOKEN || '';
const PERSONA_IDS_RAW = __ENV.PERSONA_IDS || 'perf-persona-1,perf-persona-2,perf-persona-3';
const TOOL_ID = __ENV.TOOL_ID || 'web_search';
const SCENARIO = __ENV.K6_SCENARIO || 'ramp';
/* tools/list 调用占总请求的比例；默认 5% */
const LIST_RATIO = Number.parseFloat(__ENV.LIST_RATIO || '0.05');

if (!BEARER_TOKEN) {
  fail('BEARER_TOKEN env var is required (Authorization: Bearer <jwt>)');
}

const personaIds = new SharedArray('persona-ids', () => PERSONA_IDS_RAW.split(',').map((s) => s.trim()).filter(Boolean));

const toolCallDuration = new Trend('chrono_tool_call_ms', true);
const toolPendingConfirmation = new Counter('chrono_tool_pending_confirmation_total');
const toolDeniedPermission = new Counter('chrono_tool_denied_permission_total');
const toolJsonRpcOk = new Rate('chrono_tool_jsonrpc_ok');

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const SCENARIOS = {
  smoke: {
    executor: 'constant-vus',
    vus: 3,
    duration: '30s',
    gracefulStop: '10s',
  },
  ramp: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 10 },
      { duration: '3m', target: 30 },
      { duration: '5m', target: 30 },
      { duration: '1m', target: 0 },
    ],
    gracefulStop: '30s',
  },
  /* 高基数租户压力：50 VU，捕捉权限缓存 / 配额计数器的争用 */
  contention: {
    executor: 'constant-vus',
    vus: 50,
    duration: '5m',
    gracefulStop: '30s',
  },
};

if (!SCENARIOS[SCENARIO]) {
  fail(`Unknown K6_SCENARIO=${SCENARIO}; expected one of: ${Object.keys(SCENARIOS).join(', ')}`);
}

export const options = {
  scenarios: { agent_tool: SCENARIOS[SCENARIO] },
  thresholds: {
    'http_req_failed{name:tool_call}': ['rate<0.005'],
    'http_req_duration{name:tool_call}': ['p(95)<800', 'p(99)<2500'],
    'chrono_tool_jsonrpc_ok': ['rate>0.99'],
    'checks': ['rate>0.99'],
  },
  maxRedirects: 0,
};

const SAMPLE_QUERIES = [
  'latest changelog for kubernetes 1.32',
  'best practices postgres partitioning',
  'github actions cache strategy',
  'opentelemetry semantic conventions http',
];

function buildHeaders(name) {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BEARER_TOKEN}`,
      'User-Agent': 'chrono-perf-k6/1.0',
    },
    tags: { name },
    timeout: '10s',
  };
}

function callTool(personaId) {
  const reqId = `${__VU}-${__ITER}`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: reqId,
    method: 'tools/call',
    personaId,
    params: {
      name: TOOL_ID,
      arguments: { query: randomItem(SAMPLE_QUERIES), maxResults: 5 },
    },
  });

  const res = http.post(`${BASE_URL}/api/v1/mcp`, body, buildHeaders('tool_call'));
  toolCallDuration.add(res.timings.duration);

  let parsed = null;
  try { parsed = res.json(); } catch (_) { /* invalid JSON tracked below */ }

  /* JSON-RPC 信封正确（即便业务层返回 error，HTTP 层仍是 200） */
  const envelopeOk = parsed && parsed.jsonrpc === '2.0' && (parsed.id === reqId || parsed.id === 0);
  toolJsonRpcOk.add(envelopeOk ? 1 : 0);

  /* 业务级状态分流：pending_confirmation / denied_permission 是合法响应 */
  if (parsed?.result?.outcome === 'pending_confirmation') {
    toolPendingConfirmation.add(1);
  } else if (parsed?.result?.outcome === 'denied_permission') {
    toolDeniedPermission.add(1);
  }

  check(res, {
    'tool_call no 5xx': (r) => r.status < 500,
    'tool_call jsonrpc envelope ok': () => envelopeOk,
    'tool_call no auth error': () => !parsed?.error || parsed.error.code !== -32001,
  });
}

function listTools() {
  const reqId = `${__VU}-${__ITER}-list`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: reqId,
    method: 'tools/list',
  });

  const res = http.post(`${BASE_URL}/api/v1/mcp`, body, buildHeaders('tools_list'));

  check(res, {
    'tools/list status 200': (r) => r.status === 200,
    'tools/list returns array': (r) => Array.isArray(r.json('result.tools')),
  });
}

export default function () {
  const personaId = randomItem(personaIds);
  if (Math.random() < LIST_RATIO) {
    listTools();
  } else {
    callTool(personaId);
  }
  sleep(0.5 + Math.random() * 1.0);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    'perf-results/agent-tool.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const fmt = (k, fields = ['avg', 'p(95)', 'p(99)', 'max']) => {
    const v = m[k]?.values;
    if (!v) return `  ${k}: (no data)`;
    return `  ${k}: ${fields.map((f) => `${f}=${(v[f] ?? 0).toFixed(2)}`).join(' ')}`;
  };
  return [
    '',
    '== Agent tool perf summary ==',
    fmt('http_req_duration{name:tool_call}'),
    fmt('chrono_tool_call_ms'),
    `  http_req_failed{name:tool_call}: rate=${(m['http_req_failed{name:tool_call}']?.values?.rate ?? 0).toFixed(4)}`,
    `  jsonrpc_ok: rate=${(m.chrono_tool_jsonrpc_ok?.values?.rate ?? 0).toFixed(4)}`,
    `  pending_confirmation: ${m.chrono_tool_pending_confirmation_total?.values?.count ?? 0}`,
    `  denied_permission: ${m.chrono_tool_denied_permission_total?.values?.count ?? 0}`,
    `  iterations: ${m.iterations?.values?.count ?? 0}`,
    '',
  ].join('\n');
}
