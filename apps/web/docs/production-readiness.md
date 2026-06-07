# Frontend Production Readiness

## Verdict

`chrono-synth-web` 现在可作为企业生产前端镜像交付，前提是：

1. 通过容器环境变量注入运行时配置
2. 通过 `chrono-synth-deploy` 或等效平台提供统一入口与 TLS
3. 把 API、worker、Prometheus、Grafana 统一放在受控反向代理后

## Hard Gates

- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run test:ops`
- GitHub Actions `CI` 绿色
- GitHub Actions `E2E Tests` 绿色
- Docker build + Trivy 扫描通过

## What Changed

- 增加运行时 `runtime-config.js` 注入，避免环境专属 build
- Nginx 改为非 root 运行，监听 `8080`
- `frontend-healthz` 独立于后端代理存活
- Docker 与运行时配置验证接入 CI

## Runtime Environment Variables

- `CHRONO_WEB_API_BASE_URL`
- `CHRONO_WEB_SENTRY_DSN`
- `CHRONO_WEB_ENVIRONMENT`

## Residual Operational Work

- CDN / WAF / TLS 由部署层提供
- CSP 如需更严格的第三方域白名单，应在部署层按实际域名收敛
- Sentry 采样率、release、source maps 上传仍需结合发布流水线配置
