# Production Readiness

## Verdict

当前仓库已经补齐一套可直接评审的企业生产基线，但前提是：

1. 使用 `k8s/production/`，而不是根目录的示例清单
2. 使用外部 PostgreSQL / Redis / Kafka
3. 在集群中注入真实 `Secret`
4. 在发布前执行一次真实恢复演练与灰度发布

如果这 4 个前提满足，我认为 `chrono-synth-os` 已经达到可进入企业生产环境的仓库交付标准。

## Hard Gates

- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run test:ops`
- GitHub Actions `CI` green
- 本地或预发 `chrono-synth-deploy/scripts/e2e-test.sh` green
- 生产环境必须使用 `k8s/production/`
- 生产环境必须启用：
  - `CHRONO_DB_DRIVER=postgres`
  - `CHRONO_AUTH_ENABLED=true`
  - `CHRONO_AUTH_REQUIRE_DB_KEYS=true`
  - `CHRONO_JWT_ENABLED=true`
  - `CHRONO_ENCRYPTION_ENABLED=true`
  - `CHRONO_REDIS_ENABLED=true`

## What Changed

- 新增 `k8s/production/` 生产级 Kubernetes 清单
- 新增 `metrics` 专用 scrape key，支持 Prometheus 通过 `Authorization: Bearer <token>` 安全抓取
- CI 现在实际验证灾备脚本，不再只是语法检查
- 容器构建切换到 `npm ci`，提高可重复性

## Remaining Operational Work

这些不属于代码仓库缺失，而是上线执行项：

- 真实域名、TLS 证书与 WAF/Ingress Controller 接入
- 托管 PostgreSQL / Redis / Kafka 参数调优
- 生产密钥下发与轮换策略接入 KMS/Vault
- 首次灰度发布与回滚演练
- 容量基线和 SLO 告警阈值按真实租户流量校准

## Recommended Release Flow

1. 在预发环境应用 `k8s/production/`
2. 注入真实 `Secret`
3. 运行 smoke + E2E
4. 执行一次恢复演练
5. 只做小流量灰度
6. 观察：
   - `/readyz`
   - `/metrics/prometheus`
   - worker `/readyz`
   - task success rate
   - outbox backlog
7. 再全量切换
