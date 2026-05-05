# Disaster Recovery Runbook

## 目标

满足 `ChronoSynth-OS-v1-Enterprise-Readiness` 中的 P0-6：

- 自动化数据库备份
- 自动化存储备份
- 7 天保留策略
- 可执行恢复脚本

## 脚本

- `scripts/backup_db.sh`
- `scripts/restore_db.sh`
- `scripts/backup_storage.sh`
- `scripts/test_disaster_recovery.sh`

## 环境变量

- `CHRONO_DB_DRIVER`
  - `sqlite` 或 `postgres`
- `CHRONO_DB_PATH`
  - SQLite 文件路径
- `CHRONO_DB_CONNECTION_STRING`
  - PostgreSQL 连接串
- `CHRONO_STORAGE_PATH`
  - 需要打包备份的存储目录
- `CHRONO_BACKUP_DIR`
  - 备份输出目录，默认 `./backups`
- `BACKUP_RETENTION_DAYS`
  - 默认 `7`

## 本地执行

### 备份 SQLite

```bash
CHRONO_DB_DRIVER=sqlite \
CHRONO_DB_PATH=./data/chrono.db \
bash scripts/backup_db.sh
```

### 备份 PostgreSQL

```bash
CHRONO_DB_DRIVER=postgres \
CHRONO_DB_CONNECTION_STRING='postgresql://chrono:chrono@localhost:5432/chrono_synth' \
bash scripts/backup_db.sh
```

### 备份存储目录

```bash
CHRONO_STORAGE_PATH=./data \
bash scripts/backup_storage.sh
```

### 恢复 SQLite

```bash
CHRONO_DB_DRIVER=sqlite \
CHRONO_DB_PATH=./data/chrono.db \
bash scripts/restore_db.sh ./backups/db/chrono-sqlite-20260313T000000Z.db.gz
```

### 恢复 PostgreSQL

```bash
CHRONO_DB_DRIVER=postgres \
CHRONO_DB_CONNECTION_STRING='postgresql://chrono:chrono@localhost:5432/chrono_synth' \
bash scripts/restore_db.sh ./backups/db/chrono-postgres-20260313T000000Z.sql.gz
```

## Podman 计划任务示例

```bash
0 2 * * * cd /path/to/chrono-synth-os && CHRONO_DB_DRIVER=postgres CHRONO_DB_CONNECTION_STRING='postgresql://chrono:chrono@localhost:5432/chrono_synth' bash scripts/backup_db.sh
15 2 * * * cd /path/to/chrono-synth-os && CHRONO_STORAGE_PATH=./data bash scripts/backup_storage.sh
```

## 仓库内验证

CI 现在会直接执行：

```bash
npm run test:ops
```

该命令不再只是 shell 语法检查，还会实际完成一轮：

1. 创建 SQLite 测试数据库
2. 执行数据库备份
3. 删除原数据库并执行恢复
4. 校验恢复后的业务记录仍存在
5. 执行存储目录打包并验证归档内容

## 恢复演练建议

每次版本发布前至少执行一次：

1. 生成数据库备份
2. 在隔离环境恢复到新库或新文件
3. 启动应用并执行：
   - `GET /healthz`
   - `GET /readyz`
   - 关键登录 / persona / billing smoke test
4. 验证租户数据、persona core、wallet、governance、audit 数据完整

## 验收标准

- 备份文件可生成
- 7 天外备份会自动清理
- 恢复脚本支持 SQLite / PostgreSQL
- 恢复后服务可以通过健康检查

---

## P2.5 — Chaos Engineering 演练

`chrono-synth-deploy/chaos/experiments/` 下的 chaos-mesh 资源用于在
staging 集群定期触发可控故障，验证服务韧性。每月最后一周执行一次
全演练，结果记入 `docs/operations/chaos-drill-log.md`。

### 演练前置条件

1. chaos-mesh 已安装在 staging 集群（namespace `chaos-mesh`）。
2. 演练窗口提前 24h 在 #sre-oncall 公告。
3. SLO 团队确认当前没有进行中的事故。

### 实验目录

| 实验 | 期望 RTO | 期望 RPO | 预警阈值 |
|------|---------|---------|---------|
| pod-kill-backend | < 60s | 0 | 1m 内 5xx > 0.5% 即视为失败 |
| network-partition-postgres | < 60s（恢复后） | 0 | 分区期间 /readyz 必须返回 503 |
| dns-failure-llm-upstream | n/a（外部依赖） | 0 | 5xx 不超过 0.5%；4xx 不限 |

### <a id="pod-kill-drill"></a>Pod-kill 演练

```bash
kubectl apply -f chaos/experiments/pod-kill-backend.yaml
# 实验运行 5s 后自动恢复；另一副本应在 healthcheck 超时前接管
kubectl rollout status deploy/backend -n chrono-synth
```

观察：
- `kubectl get pods -n chrono-synth -l app.kubernetes.io/name=backend`
  应在 60s 内恢复到目标副本数。
- Grafana：5xx burst < 30s。
- 漂移分析、对话提交 SLO 不受影响。

### <a id="db-partition-drill"></a>DB 网络分区演练

```bash
kubectl apply -f chaos/experiments/network-partition-postgres.yaml
# 60s 后自动恢复
```

期望：
- 分区期间 `/readyz` 返回 503 ≤ 5s 内（驱动层探活）。
- backend pod 不会被 OOMKill，只是被摘出 endpoints。
- 分区结束后 1 分钟内全部重新 ready；无需手工 restart。

### <a id="llm-dns-drill"></a>LLM upstream DNS 故障演练

```bash
kubectl apply -f chaos/experiments/dns-failure-llm-upstream.yaml
# 60s 后自动恢复
```

期望：
- 对话提交 5xx rate < 0.5%；4xx with Retry-After 不限。
- `chrono_conversation_quota_exceeded_total` 升高。
- circuit breaker 跳闸日志可见，避免重试风暴。
- 故障结束后无需人工干预即可恢复。

### Region failover playbook（多区域，规划中）

> 当前为单 region 部署；本节是 P3.6 完成后的目标 SOP。

1. 确认 primary region 不可用（监控持续 5min 无心跳）。
2. 切换 DNS：将 `api.chrono.example.com` 指向 secondary region 的
   入口 LB。TTL 已预设为 60s。
3. Failover postgres：用最新 streaming replica 的 LSN promote 为
   primary（异步复制；预期 RPO < 5s）。
4. ArgoCD 在 secondary region 的 cluster 上做 sync 把 secrets +
   service accounts 装好。
5. 跑 `npm run test:dr` 的子集（healthz + login + 创建 persona）
   作为冒烟测试。
6. 全员 #sre-oncall 通报：实际 RPO / RTO / 受影响请求数。

### 验收标准（P2.5）

- [ ] pod-kill 演练每月一次、结果归档
- [ ] network-partition 演练每月一次、结果归档
- [ ] DNS 故障演练每月一次、结果归档
- [ ] 任一演练导致 SLO breach 时，触发事故复盘流程
