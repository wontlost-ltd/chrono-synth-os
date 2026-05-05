/**
 * k6 — portability export 压测
 *
 * 模型：admin VU 提交导出任务（POST /api/v2/portability/export）后，
 * 周期性轮询任务状态直至 completed/failed。一个 VU 同一时间只持有一个
 * 进行中的导出，避免触发后端 5/min/IP 速率限制。
 *
 * 与上面两个脚本不同，此处考察的是 admin-rare-but-heavy 的工作负载：
 * 单租户密集导出时 worker pool 是否阻塞、对话 SLO 是否仍达标。
 *
 * Thresholds：
 *   - http_req_failed{name:export_start} < 1%（429 不计入；它是预期的）
 *   - http_req_failed{name:export_poll} < 1%
 *   - 任务从 submitted 到 completed 的端到端时长 p95 < 30s（中等 persona）
 *   - p99 < 60s（大 persona 兜底）
 *
 * 运行：
 *   BASE_URL=http://localhost:3000 \
 *   BEARER_TOKEN=$(echo $ADMIN_JWT) \
 *   k6 run perf/k6-portability-export.js
 */

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const BEARER_TOKEN = __ENV.BEARER_TOKEN || '';
const SCENARIO = __ENV.K6_SCENARIO || 'ramp';
const POLL_INTERVAL_MS = Number.parseInt(__ENV.POLL_INTERVAL_MS || '1000', 10);
const MAX_POLL_ATTEMPTS = Number.parseInt(__ENV.MAX_POLL_ATTEMPTS || '90', 10); /* 90s budget */

if (!BEARER_TOKEN) {
  fail('BEARER_TOKEN env var is required (Authorization: Bearer <admin-jwt>)');
}

const exportE2eMs = new Trend('chrono_portability_export_e2e_ms', true);
const exportRateLimited = new Counter('chrono_portability_export_rate_limited_total');
const exportFailed = new Counter('chrono_portability_export_failed_total');
const exportTimedOut = new Counter('chrono_portability_export_timed_out_total');

const SCENARIOS = {
  /* smoke：1 VU，足以验证脚本语义 */
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '60s',
    gracefulStop: '30s',
  },
  /* ramp：admin 工作流的真实节奏；上限 4 VU 留 1 RPS 给 5/min 限速 */
  ramp: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 2 },
      { duration: '5m', target: 4 },
      { duration: '1m', target: 0 },
    ],
    gracefulStop: '60s',
  },
  /* burst：故意超出 5/min 限速，验证 429 行为不会污染整体可用性 */
  burst: {
    executor: 'constant-vus',
    vus: 10,
    duration: '2m',
    gracefulStop: '30s',
  },
};

if (!SCENARIOS[SCENARIO]) {
  fail(`Unknown K6_SCENARIO=${SCENARIO}; expected one of: ${Object.keys(SCENARIOS).join(', ')}`);
}

export const options = {
  scenarios: { portability_export: SCENARIOS[SCENARIO] },
  thresholds: {
    'http_req_failed{name:export_start}': ['rate<0.01'],
    'http_req_failed{name:export_poll}': ['rate<0.01'],
    'chrono_portability_export_e2e_ms': ['p(95)<30000', 'p(99)<60000'],
    'checks': ['rate>0.95'],
  },
  maxRedirects: 0,
};

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

function startExport() {
  const res = http.post(`${BASE_URL}/api/v2/portability/export`, '{}', buildHeaders('export_start'));

  /* 429 Too Many Requests 是设计内的；不视为失败 */
  if (res.status === 429) {
    exportRateLimited.add(1);
    return null;
  }

  const ok = check(res, {
    'export_start status 200/202': (r) => r.status === 200 || r.status === 202,
    'export_start returns id': (r) => typeof r.json('data.exportId') === 'string',
  });
  if (!ok) {
    exportFailed.add(1);
    return null;
  }

  return res.json('data.exportId');
}

function pollExport(exportId) {
  const url = `${BASE_URL}/api/v2/portability/export/${encodeURIComponent(exportId)}`;
  const start = Date.now();
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    sleep(POLL_INTERVAL_MS / 1000);
    const res = http.get(url, buildHeaders('export_poll'));
    if (res.status !== 200) {
      check(res, { 'export_poll no 5xx': (r) => r.status < 500 });
      continue;
    }
    const status = res.json('data.status');
    if (status === 'completed') {
      exportE2eMs.add(Date.now() - start);
      return 'completed';
    }
    if (status === 'failed') {
      exportFailed.add(1);
      return 'failed';
    }
    /* still pending / running — keep polling */
  }
  exportTimedOut.add(1);
  return 'timeout';
}

export default function () {
  const exportId = startExport();
  if (!exportId) {
    /* 限速或启动失败：退避，让其他 VU 通过 */
    sleep(2 + Math.random() * 3);
    return;
  }
  const outcome = pollExport(exportId);
  check(null, { 'export reached terminal state': () => outcome === 'completed' || outcome === 'failed' });
  /* 一个 VU 完成一次导出后稍歇，模拟真实 admin 节奏 */
  sleep(5 + Math.random() * 5);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    'perf-results/portability-export.json': JSON.stringify(data, null, 2),
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
    '== Portability export perf summary ==',
    fmt('chrono_portability_export_e2e_ms'),
    fmt('http_req_duration{name:export_start}'),
    `  export_start_failed: rate=${(m['http_req_failed{name:export_start}']?.values?.rate ?? 0).toFixed(4)}`,
    `  rate_limited: ${m.chrono_portability_export_rate_limited_total?.values?.count ?? 0}`,
    `  failed: ${m.chrono_portability_export_failed_total?.values?.count ?? 0}`,
    `  timed_out: ${m.chrono_portability_export_timed_out_total?.values?.count ?? 0}`,
    `  iterations: ${m.iterations?.values?.count ?? 0}`,
    '',
  ].join('\n');
}
