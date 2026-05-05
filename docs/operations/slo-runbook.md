# SLO Runbook

> 配套 `chrono-synth-deploy/k8s/addons/observability-slo/`。当 Slack #chrono-oncall 或 #chrono-slo-tickets 收到 ChronoXxx 告警时按本手册处置。

## SLO 总览

| SLI | 目标 | 错误预算 (28d) | 测量窗口 |
|-----|------|---------------|---------|
| API 可用性 | ≥ 99.9% | 0.1% (≈40min/月) | 28d rolling |
| API p95 延迟 | < 500ms | n/a (latency 阈值，非比例) | 5m |
| Agent tool 成功率 | ≥ 99.5% | 0.5% | 28d rolling |
| Conversation 完成率 | ≥ 99.95% | 0.05% | 28d rolling |

## Dashboard

`Chrono SLO` (uid `chrono-slo`)。挂载方式：
1. 把 `dashboards/chrono-slo.json` 放进 grafana 的 dashboard provisioning 目录
2. Grafana → Dashboards → Browse → "Chrono SLO"

## 共通处置流程

每条 alert 的标准 7 步：
1. **Acknowledge** — 在 Slack thread 回 `:eyes:`
2. **Verify** — 打开 Grafana SLO 面板看是真实问题还是 metric 异常
3. **Scope** — 查 `chrono_requests_total{status_code=~"5.."}` by route，定位故障范围
4. **Mitigate** — 即时止血动作（feature flag / rollback / 限流）
5. **Communicate** — 客户 status page 更新（如果 user-impacting）
6. **Resolve** — 修复后等告警 auto-resolve
7. **Postmortem** — 24h 内写 RCA → `docs/operations/incidents/<date>-<slug>.md`

## ChronoApiAvailabilitySloFastBurn

**含义**：1h + 6h 的 5xx 错误率都超过 SLO 预算的 14.4×。这意味着 28 天预算 < 2 天就会耗尽。

**首查**：
- `kubectl top pods -n chrono-synth` — 是不是 OOM？
- `kubectl logs -n chrono-synth -l app.kubernetes.io/name=chrono-synth-os --tail=200` — 看 5xx 是 panic 还是 502 to upstream
- Postgres：`kubectl exec -n chrono-synth postgres-0 -- pg_stat_activity | head` — 锁等待？连接池打满？

**常见根因**：
- Postgres connection pool 打满 → 临时扩 `CHRONO_DB_POOL_MAX`
- 某条慢查询拖累整个池 → `pg_stat_statements` 找凶手 + 加 statement_timeout
- 上游依赖（Stripe/OAuth）超时 → 检查 circuit breaker 状态
- 配置漂移（误改了某个 timeout）→ 看 last config patch via `/api/v1/admin/config/audit`

**止血**：
- 重启 backend pods (`kubectl rollout restart deploy/backend`)
- rollback 上一版镜像（如果是 release 后立刻发生）
- 临时把 rate limit 调严

## ChronoApiAvailabilitySloSlowBurn

**含义**：6h 错误率超 6× 预算，趋势上预算会在 28d 中点耗尽。

不必立即页人，但 24h 内要根因定位 + 修复 + ticket 关闭。

## ChronoApiLatencyP95High / P99Critical

**首查**：
- Grafana `Latency p95 / p99 (5m)` 面板按 route 拆分
- 是不是 cold start？（pods 刚 reschedule）
- Postgres slow log
- 某个 LLM provider 上游慢？

**止血**：
- 临时禁用慢路由的 feature flag
- 缩短 `CHRONO_REQUEST_TIMEOUT_MS` 让上游慢调用 fail fast

## ChronoToolSuccessSloFastBurn / SlowBurn

**首查**：
- Grafana `Tool invocation outcomes (1m rate)` — 哪个 outcome 在涨？
  - `denied_circuit_open` → 上游 (Google / Exa) 持续失败，breaker 已开
  - `timeout` → 上游慢
  - `denied_quota` → 配额风暴；查是哪个 persona / tenant
  - `failed` → 工具内部 bug
- `kubectl logs ... | grep ToolInvocationPipeline` 找异常栈

**止血**：
- 调高 circuit breaker `resetTimeoutMs` 让 breaker 更快尝试半开
- 临时禁用 outcome-恶劣的工具：`DELETE /api/v1/admin/tool-permissions/<id>`

## ChronoConversationCompletionLow

**首查**：
- `chrono_conversation_llm_failures_total` vs `chrono_conversation_quota_exceeded_total`
- LLM provider status page (OpenAI / Anthropic)
- conversation circuit breaker 状态：`/api/v1/admin/conversation/circuit-breaker`

**止血**：
- 切换备份 LLM provider（`CHRONO_INTELLIGENCE_PROVIDER`）
- 临时调高 token budget

## 错误预算消耗政策

每月初 reset。预算消耗到不同阈值的处置：

| 消耗 | 行动 |
|------|------|
| 0–25% | 正常 |
| 25–50% | 暂停低优先级实验性 release |
| 50–75% | 暂停所有 non-critical release；冻结 schema migrations |
| 75–100% | 全员 stop-the-line：所有改动都必须修复可靠性问题 |
| > 100% | 公开 SLA 通报 + RCA + 后续多窗口 burn rate alert 调整 |

## 修改 SLO 目标的流程

不要随便改。每次需要：
1. ADR 写为什么调整
2. PR 同时改 `recording-rules.yaml` + `alerts.yaml` + 本文件
3. 至少 1 个 SRE reviewer
4. 与产品对齐 SLA 影响（如果 SLO 影响合同）
