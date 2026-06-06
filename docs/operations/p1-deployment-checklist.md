# Phase 1 生产部署检查清单

> 适用版本：基于 commit `c8a6ae9` 及之后。
> 用法：从上到下逐项勾选；任何 ❌ 或空白都必须在上线前关闭。
>
> 配套文档：[`docs/operations/stripe-setup.md`](./stripe-setup.md) · [`docs/disaster-recovery-runbook.md`](../disaster-recovery-runbook.md) · [`docs/observability-worker-runbook.md`](../observability-worker-runbook.md)

---

## ✅ 1. Database

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] DB driver 为 `postgres`（生产）或 `sqlite`（小规模）| `CHRONO_DB_DRIVER=postgres` | `psql -c "SELECT version()"` 通过 |
| [ ] 连接字符串使用 SSL | `CHRONO_DB_CONNECTION_STRING=postgresql://.../db?sslmode=require` | 连接成功 |
| [ ] 连接池 max ≥ 20 | `CHRONO_DB_POOL_MAX=20` | `\conninfo` 显示活跃连接 |
| [ ] 全部迁移已应用（v001 → v066） | 服务端启动日志 `runMigrations applied vN` | `SELECT MAX(version) FROM schema_migrations` = `v066` |
| [ ] 启用 PITR / 每日备份 | 云厂商管理面板配置 | 模拟恢复演练（参考 disaster-recovery-runbook）|
| [ ] tenant 隔离已验证 | `TenantDatabase` 已部署 | 任意租户查询返回的 row.tenant_id 与 JWT 一致 |

## ✅ 2. Encryption（PII / 字段加密）

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] FieldEncryption 已启用 | `CHRONO_ENCRYPTION_ENABLED=true` | 首次写入对话后 `conversation_messages.encryption_key_ref IS NOT NULL` |
| [ ] master key ≥ 32 字符随机串 | `CHRONO_ENCRYPTION_MASTER_KEY=<32+ chars>` | `openssl rand -base64 32` 生成 |
| [ ] master key 通过密钥管理服务存储（不在代码 / .env） | KMS / Vault | secret rotation 计划已制定 |
| [ ] 备用 key 配置（轮换） | `CHRONO_ENCRYPTION_KEYRING={"v2":"..."}` | 切换 `defaultKeyRef` 后旧数据仍可解密 |
| [ ] `keyRotationIntervalDays` 设置 | `CHRONO_ENCRYPTION_KEY_ROTATION_DAYS=90` | 默认 90 天，按合规要求调整 |

## ✅ 3. Authentication / Authorization

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] JWT 启用 | `CHRONO_JWT_ENABLED=true` | 未携带 token → 401 |
| [ ] JWT secret ≥ 32 字符 | `CHRONO_JWT_SECRET=<random 32+ chars>` | 重启后旧 token 失效（如轮换）|
| [ ] JWT issuer 设为产品域名 | `CHRONO_JWT_ISSUER=chrono.<your-domain>` | 解码 token `iss` 字段匹配 |
| [ ] RBAC admin 路由验证 | – | `requireRole('admin')` 普通用户调用返回 403 |
| [ ] API key 仅用于服务端到服务端 | `CHRONO_AUTH_API_KEYS=<csv>` | 用户对话端点拒绝 apikey: 前缀 token |
| [ ] OIDC / SSO 配置（如启用）| `CHRONO_OIDC_*` / `CHRONO_SSO_*` | 测试账户登录通过 |

## ✅ 4. Stripe（计费）

详见 `docs/operations/stripe-setup.md`。摘要：

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] Stripe 启用 | `CHRONO_STRIPE_ENABLED=true` | `/api/v1/billing/plans` 返回 5 项 |
| [ ] secret_key 为 Live key | `CHRONO_STRIPE_SECRET_KEY=sk_live_...` | Stripe Dashboard → API keys 显示对应 prefix |
| [ ] webhook signing secret | `CHRONO_STRIPE_WEBHOOK_SECRET=whsec_...` | "Send test webhook" 成功处理 |
| [ ] starter / growth / enterprise / pro Price ID | `CHRONO_STRIPE_PRICE_*` | 创建 Checkout 不报 invalid priceId |
| [ ] Meter Events 已注册 | Stripe Dashboard → Meters | 调用一次对话 API → 在 Meters 看到事件 |
| [ ] Customer Portal 已配置 | Stripe Dashboard → Settings → Billing | `/billing/portal` 返回 url 可打开 |
| [ ] 测试模式订阅可端到端走完 | – | §6 of stripe-setup.md 的 6 项验证全部通过 |

## ✅ 5. Rate limiting / DDoS 防护

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] 全局 rate limit 启用 | `CHRONO_RATE_LIMIT_MAX=1000` `CHRONO_RATE_LIMIT_WINDOW_MS=60000` | 1 秒内 1001 请求 → 429 |
| [ ] 对话端点 per-(persona, externalUser) 限流 | 路由 keyGenerator 已就位 | 同一外部用户 60 次/分钟 → 429 |
| [ ] 反向代理已部署（CloudFront / nginx） | – | 滥用 IP 由代理层先拦截 |
| [ ] DDoS 防护服务（如 Cloudflare） | – | 全 HTTPS + bot management 启用 |

## ✅ 6. Observability

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] OpenTelemetry exporter | `CHRONO_OBSERVABILITY_ENABLED=true` `CHRONO_OBSERVABILITY_OTLP_ENDPOINT=...` | 启动后 OTLP collector 收到 metrics |
| [ ] Prometheus scrape | `/metrics/prometheus` 可达，配置 metrics API key | scrape job 正常 |
| [ ] 关键 P1 指标告警 | – | 配置告警：<br>• `chrono_conversation_llm_failures_total` rate > 0.1/min<br>• `chrono_conversation_quota_exceeded_total` rate > 0.01/min<br>• `chrono_conversation_messages_total{guard_action="pre_block"}` rate > 0.05/min<br>• （ADR-0047）`chrono_conversation_messages_total{guard_action="autonomous_response"}` 占比异常升高 → 提示 LLM 不可达或未配置，数字人正退化到离线确定性回应 |
| [ ] 日志 JSON 格式 | `CHRONO_LOG_JSON=true` | 日志聚合系统可正确解析 |
| [ ] 日志级别 info 或 warn | `CHRONO_LOG_LEVEL=info` | debug 仅在调试时开启 |
| [ ] tracing sampler 0.1–1.0 | `CHRONO_OBSERVABILITY_SAMPLE_RATE=0.1` | 高流量场景采样率不应过高 |

## ✅ 7. Conversation 安全（P1-C 加固）

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] LLM provider key | `CHRONO_INTELLIGENCE_API_KEY=...` | 测试对话返回 LLM 输出（不是 fallback） |
| [ ] LLM provider 限速宽于业务限速 | `CHRONO_INTELLIGENCE_MAX_TOKENS=1024` | 不会触发 provider 端 429 |
| [ ] CircuitBreaker 阈值合理 | 默认 5 失败 / 60s 重置 | 故障注入测试：连续 5 次 429 → CB open |
| [ ] PII redaction 生效 | – | 注入手机号 / 邮箱 / 身份证 → DB / audit_log 查不到原文 |
| [ ] retention worker 启动 | – | 启动日志含 `bulk import worker 已启动` 与 `retention worker` |
| [ ] retention 策略已对齐合规 | `standardRetentionDays=90` | 业务上 GDPR / SOC2 要求一致 |

## ✅ 8. Object storage（导出 / 导入）

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] 生产环境用云存储而非 local | `CHRONO_OBJECT_STORAGE_PROVIDER=s3` 或 gcs / azure_blob | 调用 `/privacy/export` 返回的 url 可下载 |
| [ ] 凭证最小权限 | – | 仅授予 PutObject / GetObject 到指定 bucket |
| [ ] presign URL TTL 合规 | `CHRONO_OBJECT_STORAGE_PRESIGN_TTL_SECONDS=3600` | 1 小时；下载完成后立即失效 |
| [ ] bucket 默认加密 | – | S3 SSE-S3 / GCS CMEK |

## ✅ 9. Queue / Workers

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] queue.enabled 视使用而定 | `CHRONO_QUEUE_ENABLED=true` | 大批量导入 (>20 items) 走异步路径 |
| [ ] dual-write outbox flush 启动 | `DualWriteFlushWorker.start()` | 启动日志 + `/readyz` 显示 worker ok |
| [ ] settlement reconciliation worker 启动 | – | `/readyz.components.settlement_reconciliation_worker.status=ok` |
| [ ] BillingOutbox 积压告警 | – | `SELECT COUNT(*) FROM billing_outbox WHERE status='pending'` > 1000 即告警 |
| [ ] retention worker 启动 | `ConversationRetentionWorker.start()` | 启动日志含 `retention worker 已启动` |
| [ ] bulk import handler 注册 | – | TaskWorker 已 register `bulk_knowledge_import` 类型 |

## ✅ 10. Multi-tenant 隔离

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] TenantOSFactory 在路由层启用 | – | 不同 JWT tenant 各自只看自己数据 |
| [ ] BYOK / BYOS 客户独立配置 | `tenant_enterprise_profiles` 表 | 测试：不同 tenant 的对象存储 bucket 不同 |
| [ ] subscriptions / usage_records / conversation_messages 都按 tenant_id 过滤 | – | 跨租户查询应返回空 |

## ✅ 11. CORS / 跨域

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] CORS origin 收紧到产品域名 | `CHRONO_CORS_ORIGIN=https://app.example.com,https://admin.example.com` | 不在白名单的 origin 被拒 |
| [ ] credentials 控制 | `CHRONO_CORS_CREDENTIALS=true`（仅必要时）| OPTIONS 请求正确返回 Access-Control-Allow-Credentials |
| [ ] redirect URL 白名单 | `BillingRouteFacade.allowedOriginSet` 已配置 | Checkout success_url 校验通过 |

## ✅ 12. 系统级

| 检查项 | 配置 | 验证 |
|--------|------|------|
| [ ] Node.js ≥ 22 LTS（项目要求） | `node --version` | 启动正常 |
| [ ] 进程管理（systemd / pm2 / k8s deployment） | – | 异常退出后自动重启 |
| [ ] 优雅停机时间 ≥ 30s | – | SIGTERM 后处理完正在进行的请求再退出 |
| [ ] 容器健康检查 | `livenessProbe: /healthz` `readinessProbe: /readyz` | k8s pod 切流前等待 readyz=200 |
| [ ] 滚动发布策略 | maxSurge=1, maxUnavailable=0 | 升级零停机 |
| [ ] 资源限制 | CPU 2 / RAM 2Gi 起步 | 压测下 LLM 路径 P95 仍 < 2s |

## ✅ 13. 审计 / 合规

| 检查项 | 验证 |
|--------|------|
| [ ] audit_log retention ≥ 365 天（生产）| `audit_log` 行未被 prune |
| [ ] PII 不出现在 audit_log | 抽样查 audit_log.payload_json 应已脱敏 |
| [ ] business audit 覆盖关键路径 | 检查 `action_type` 包含：`persona_template.instantiated` / `persona_conversation.message.*` / `persona.drift.*` |
| [ ] GDPR 删除接口可用 | DELETE `/persona-core/<id>/conversations` 返回 deleted count |
| [ ] 数据导出可用 | POST `/privacy/export` → 完整租户数据 |

## ✅ 14. Phase 1 业务验收

| 检查项 | 验证 |
|--------|------|
| [ ] 6 个内置模板可见 | GET `/api/v1/admin/persona-templates` 含 starter/growth/enterprise/free/pro |
| [ ] 模板实例化 < 30 秒 | 端到端实例化 1 个 persona 全流程时间 |
| [ ] 批量导入支持 5 GB | 创建 5000 条 text 样本，job 状态最终 completed，failedCount 合理 |
| [ ] 对话 P95 < 2s | 监控 dashboard 显示 `chrono_conversation_duration_ms` 95 分位 < 2000 |
| [ ] 订阅状态闸门生效 | 使用 free 计划测试：100+ 条对话后返回 402 |
| [ ] Stripe 测试卡完整流程通过 | 见 stripe-setup.md §6 |

---

## 🔥 上线 Day-0 操作

发布按以下顺序：

1. 部署服务端到生产 cluster（蓝绿或滚动）
2. 等待 readiness probe 全绿
3. 触发 Stripe webhook test event 验证签名
4. 用真实信用卡（少量金额）走一次完整 Checkout → Subscription → Cancel
5. 验证 `/billing/portal` 可打开并显示订阅
6. 监控 dashboard 观察 1 小时；若 `chrono_conversation_llm_failures_total` 异常则回滚

发布后 D+1 / D+7 / D+30 复盘指标：客户开通转化率、试用期 → 付费转化、退款率、对话 SLA。
