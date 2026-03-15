# Observability Worker Runbook

## 目标

`observability-worker` 是 ChronoSynth OS 的异步观测聚合进程，负责把 `observability_outbox` 中的业务事件消费并汇总到 `observability_rollups`，供 `/metrics` 和 `/metrics/prometheus` 暴露给监控系统。

它支持两种运行模式：

- `direct`
  - 直接从数据库 outbox 拉取并聚合
  - 不依赖 Kafka，适合本地开发、单集群部署和 Kafka 不可用时的降级
- `kafka`
  - 以数据库 outbox 为持久化边界，producer 将待处理事件送入 Kafka，consumer 再聚合回 rollup
  - 适合更高吞吐、更强解耦和多消费者扩展

## 关键约束

- 数据库 outbox 仍然是最终可靠边界；即使 Kafka 不可用，也不会丢失已入库事件
- 当前镜像构建阶段会安装 `kafkajs`
- 如果是直接在宿主机运行 `node dist/main-observability-worker.js`，仍需先执行 `npm install`
- 若宿主机依赖缺失，即便 `OBS_KAFKA_ENABLED=true`，worker 也会自动回退到 `direct`

## Podman 本地运行

官方本地 Podman 拓扑已经迁移到同级仓库 `../chrono-synth-deploy`，并统一使用原生 `podman` CLI 脚本，不再维护旧的 Compose 入口。

### 1. 标准企业拓扑（Redpanda + 独立 worker）

```bash
cd ../chrono-synth-deploy
cp podman/.env.example podman/.env
./deploy.sh podman build
./deploy.sh podman up
./scripts/e2e-test.sh
```

关键结果：

- Frontend: `http://localhost:8088`
- Backend API: `http://localhost:3100`
- Worker monitor: `http://localhost:8088/worker/healthz`
- Prometheus: `http://localhost:8088/prometheus/targets`
- Grafana: `http://localhost:8088/grafana/`

建议同时确认：

- 镜像内已安装 `kafkajs`
- `chrono-synth-redpanda` 已处于 healthy
- `chrono-synth-observability-worker` 已处于 healthy
- worker 日志出现 Kafka 观测链路启动成功

若日志出现 `Kafka 观测链路不可用，回退到 DB worker`，说明系统已自动降级，但事件仍会继续通过数据库 worker 处理。

### 2. 宿主机直跑 direct 模式

如果只验证 direct worker，而不是完整企业拓扑，则直接在本仓库启动进程：

```bash
npm install
npm run build
node dist/main.js
# 新终端
node dist/main-observability-worker.js
```

可直接检查：

```bash
curl http://localhost:3100/healthz
curl http://localhost:3100/readyz
curl http://localhost:3100/metrics/prometheus
```

## 环境变量

### 通用 worker

- `CHRONO_OBSERVABILITY_WORKER_ENABLED`
- `CHRONO_OBSERVABILITY_WORKER_POLL_INTERVAL_MS`
- `CHRONO_OBSERVABILITY_WORKER_BATCH_SIZE`
- `CHRONO_OBSERVABILITY_WORKER_MAX_ATTEMPTS`
- `CHRONO_OBSERVABILITY_WORKER_STALE_PROCESSING_MS`

### worker monitor

- `CHRONO_OBSERVABILITY_WORKER_HTTP_ENABLED`
- `CHRONO_OBSERVABILITY_WORKER_HTTP_HOST`
- `CHRONO_OBSERVABILITY_WORKER_HTTP_PORT`

### Kafka

- `CHRONO_OBSERVABILITY_KAFKA_ENABLED`
- `CHRONO_OBSERVABILITY_KAFKA_BROKERS`
- `CHRONO_OBSERVABILITY_KAFKA_CLIENT_ID`
- `CHRONO_OBSERVABILITY_KAFKA_TOPIC`
- `CHRONO_OBSERVABILITY_KAFKA_CONSUMER_GROUP_ID`
- `CHRONO_OBSERVABILITY_KAFKA_STARTUP_WAIT_MS`
- `CHRONO_OBSERVABILITY_KAFKA_SSL`
- `CHRONO_OBSERVABILITY_KAFKA_SASL_MECHANISM`
- `CHRONO_OBSERVABILITY_KAFKA_USERNAME`
- `CHRONO_OBSERVABILITY_KAFKA_PASSWORD`

## 探针与可观测性

worker 自带独立 monitor 端口：

- `/healthz`
  - 进程活着即返回 200
  - graceful shutdown 期间返回 `status: shutting_down`，但仍保持 200，避免 liveness 引发重启风暴
- `/readyz`
  - 检查 pipeline 与数据库
  - shutdown 或数据库异常时返回 503
- `/metrics/prometheus`
  - 暴露 worker 自身指标
  - 包括 readiness、mode、inflight、outbox backlog

Prometheus 关键指标：

- `chrono_observability_worker_ready`
- `chrono_observability_worker_inflight_jobs`
- `chrono_observability_worker_outbox_pending`
- `chrono_observability_worker_outbox_processing`
- `chrono_observability_worker_outbox_failed`
- `chrono_observability_worker_mode{mode="..."}`

## Kubernetes 落地

新增/更新的清单：

- `k8s/observability-worker-deployment.yml`
- `k8s/observability-worker-service.yml`
- `k8s/observability-worker-network-policy.yml`
- `k8s/observability-prometheus-rule.yml`
- `infra/observability/grafana/chrono-synth-overview.json`

如果采用仓库内新的生产模板，则直接使用：

- `k8s/production/servicemonitor.yml`
- `k8s/production/observability-worker-servicemonitor.yml`

这两个 `ServiceMonitor` 会通过 `bearerTokenSecret` 抓取 `/metrics/prometheus`，对应应用侧由 `CHRONO_AUTH_METRICS_API_KEYS` 提供只读 scrape key，不需要把 metrics 端点匿名开放。

部署后可获得：

- dedicated worker 副本
- `healthz/readyz` 探针
- 独立 `ClusterIP Service`
- Prometheus scrape annotation

### Dashboard 与告警

Prometheus Operator 环境可直接应用：

```bash
kubectl apply -f k8s/observability-prometheus-rule.yml
```

Grafana 可导入：

```text
infra/observability/grafana/chrono-synth-overview.json
```

该 dashboard 聚焦 Enterprise Readiness 文档要求的核心指标：

- task success rate
- runtime duration
- wallet settlement latency
- governance cases backlog
- observability outbox / worker health
- persona growth trend

## 排障

### `readyz` 返回 503

优先检查：

- 数据库连接串是否正确
- `observability-worker` 是否已完成迁移所需表结构
- Kafka 模式下是否由于 `kafkajs` 缺失而自动回退

### outbox backlog 持续上涨

检查顺序：

1. `curl http://localhost:3100/metrics/prometheus`
2. 查看 `chrono_observability_worker_outbox_pending`
3. 查看 worker 日志中是否存在 `观测事件处理失败`
4. 查看 Kafka consumer 是否 healthy

### Kafka 已开启但仍是 `direct`

通常有三种原因：

1. `kafkajs` 在宿主机未安装，或镜像尚未重新构建
2. broker 地址不可达
3. topic / SASL / TLS 配置错误
