# Security CI Runbook (chrono-synth-web)

> 当 `.github/workflows/security.yml` 中任一 job 失败时如何应对。
> 该 runbook 与 `chrono-synth-os/docs/operations/security-ci-runbook.md` 同源，
> 任何修订都应当在两边保持一致。

## 概览

| Job | 触发器 | 失败的含义 |
|-----|-------|-----------|
| CodeQL (SAST) | push / PR / weekly | 代码中发现 HIGH+ severity 安全模式 |
| TruffleHog | push / PR / weekly | 提交历史或当前 diff 出现疑似 secret |
| License check | push / PR | 引入了 allowlist 之外的 license（GPL-3 / AGPL 等） |
| SBOM | push / PR | SPDX 生成失败（罕见） |
| DAST baseline | PR only | 当前以 `fail_action: false` 运行，不会让 PR fail；仅产出 artifact 供阅读 |

## DAST baseline

> 任务：每个 PR 启一份 production nginx image，用 OWASP ZAP 跑被动扫，
> 报告作为 artifact 上传，**当前不会让 PR fail**。

### 当前状态：collect-only

`fail_action: false`：

- ZAP 全量扫 `http://127.0.0.1:8080`
- 报告上传到 `zap-baseline-<sha>` artifact（HTML / Markdown / JSON 三份）
- nginx log 单独上传到 `chrono-web-dast-nginx-log-<sha>`
- workflow 永远 pass

### Web 仓特有的扫描覆盖面

| URL | 风险点 |
|-----|-------|
| `/` (index.html) | response headers — CSP / X-Frame-Options / Permissions-Policy |
| `/runtime-config.js` | **必须**不含服务端 secret，仅放 public client identifier (apiBaseUrl, sentryDsn, environment)。`scripts/render-runtime-config.sh` 强制只接受这三个字段；新增字段时**必须**同步审视是否会被 ZAP 抓到 |
| `/assets/*.{js,css}` | cache-control / SRI |
| `/frontend-healthz` | 始终 200，无 body — 不应暴露 build hash 或 build time |

### 怎么读报告

1. Actions → 失败/通过的 Security run → Artifacts
2. 下载 `zap-baseline-<sha>`，打开 `report_html.html`
3. 看 **Alerts** 表，按 Risk 排序：
   - **High** — 必须修（典型例：missing HSTS、不安全 cookie 属性、CORS misconfiguration）
   - **Medium** — 优先级 P1（典型例：missing CSP、X-Content-Type-Options）
   - **Low** — 改进项（典型例：cookie no SameSite）
   - **Informational** — 已被 `cmd_options: '-I'` 静默，不出现

### 切到 hard-fail 模式

当 baseline 报告里 0 High + 0 Medium 时，把 `fail_action: false` 改成
`fail_action: true`。这是 P0.1 的 follow-up PR，**不在首次接入 PR 范围内**。

### `runtime-config.js` 安全审查清单

每次修改 `scripts/render-runtime-config.sh` 或 `nginx.conf` 中
`location = /runtime-config.js` 时必须复核：

- [ ] 只输出 client-side public identifier（apiBaseUrl / sentryDsn / environment）
- [ ] 没有 server-side secret（database url / webhook secret / internal api key / kms key）
- [ ] 没有 hardcoded fallback 占位符（如 `"INSERT_API_KEY_HERE"`）
- [ ] env 缺失时降级到空字符串或安全默认值（不是占位符）
- [ ] `package.json` `test:ops` 脚本能验证渲染输出包含期望字段

### 流水线本地复现

```bash
docker build -t chrono-synth-web:dast-local .
docker run -d --name chrono-web-dast --network host chrono-synth-web:dast-local
curl -fsS http://127.0.0.1:8080/frontend-healthz   # wait until 200
docker run --rm --network host \
  -v "$(pwd):/zap/wrk" -t \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py -t http://127.0.0.1:8080 -I -T 10 \
    -r report_html.html -w report_md.md -J report_json.json
docker rm -f chrono-web-dast
```
