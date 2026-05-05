# Security CI Runbook

> 当 `.github/workflows/security.yml` 中任一 job 失败时如何应对。

## 概览

| Job | 触发器 | 失败的含义 |
|-----|-------|-----------|
| CodeQL (SAST) | push / PR / weekly | 代码中发现 HIGH+ severity 安全模式 |
| TruffleHog | push / PR / weekly | 提交历史或当前 diff 出现疑似 secret |
| License check | push / PR | 引入了 allowlist 之外的 license（GPL-3 / AGPL 等） |
| SBOM | push / PR | SPDX 生成失败（罕见） |

## CodeQL 失败

> 仓库未启用 GitHub Advanced Security，因此 SARIF 不上传到 Security 页签的
> Code scanning alerts；改为以 workflow artifact 方式保留。

1. 打开 Actions → 失败的 Security run → Artifacts
2. 下载 `codeql-sarif-<sha>`，里面是 `javascript.sarif`（标准 SARIF 2.1）
3. 用 SARIF viewer 打开（VSCode 插件 `MS-SarifVSCode.sarif-viewer` 或在线
   `microsoft.github.io/sarif-web-component`）；每条 alert 含 `description` + `recommendation`
4. **必须修复**的：injection / xss / 不安全反序列化 / hardcoded credential / weak crypto / path traversal
5. **可标 false positive 的**：误判（必须在 PR 描述中给理由）
6. 修复后 push，CodeQL 自动 re-run

**绝不绕过的方式**：
- ❌ 改 query suite 把 alert 静默
- ❌ 在 paths-ignore 加业务代码（仅 dist / test 等可加）
- ❌ 改 `upload: never` 为 `if: false` 来跳过整个分析

**未来开启 Advanced Security 时**：把 `upload: never` 改成默认（删除该参数），
删掉 `output:` 与 `Upload SARIF as artifact` 步骤，恢复 `permissions:
security-events: write`，alert 即直接写入 Security 页签。

## TruffleHog 失败

### 误报情况
- 测试 fixture 里的 fake key 被识别为真 key
- 文档示例中的 placeholder token

**应对**：
1. TruffleHog 默认 `--results=verified,unknown` 模式：verified 必须修；unknown 通常是 fake/placeholder
2. 反复出现的 false positive 加入 `.trufflehog-exclude` 文件（trufflehog 自动读取仓根）：
   ```
   src/test/fixtures/**/*.json
   docs/examples/**
   ```
3. 在 PR 描述记录原因；CI 重跑

### 真实泄漏
- 立即 **rotate the secret** —— 不是删 commit，是吊销并重发
- 记录 rotate 时间到 `docs/operations/incidents/<date>-secret-rotation.md`
- 查 `git log -p` 确定何时引入；用 `git filter-repo` 清理（仅在确认无第三方 fork 时）
- 给团队发 incident notification

## License check 失败

输出会列出违规包：
```
WARN: Found 1 license violation:
  - some-pkg@1.2.3: AGPL-3.0
```

**判断流程**：
1. 这是直接依赖还是间接？`npm ls some-pkg`
2. 直接依赖 → 找替代品；不行就移除该 feature
3. 间接依赖 → 升级父依赖或锁定旧版本（`overrides` in package.json）
4. 必须保留？提交合规审批 issue 给 legal team；获批后将该包加入 `excludePackages` 列表，并在 ADR 中记录决策

**永远不要**直接放宽 `--onlyAllow` 列表；GPL/AGPL 引入到 chrono-synth-os 会传染整个产品。

## SBOM 失败

通常是 anchore action 的 transient error。

1. 重跑 workflow（GitHub Actions UI 上"Re-run failed jobs"）
2. 仍失败：检查 anchore/sbom-action latest release notes，可能 syft binary 暂时挂了
3. SBOM 是合规证据，failure 不阻塞 release，但要在 release runbook 中记录跳过

## 例外审批流程

当某个 alert 必须放行时：

1. PR 描述中包含 `## Security CI exception` 章节
2. 列出：affected check, alert id, justification (≤ 100 字), 缓解措施, expiry date
3. 至少 1 个 reviewer 必须有 `security-reviewer` 权限
4. 合并后开 issue 跟踪 expiry
5. 每月清理过期豁免

## 周扫调度

每周日 04:00 UTC scheduled run 用于检测：
- supply-chain CVE 增量（依赖未变但漏洞库更新了）
- main 分支 drift（合并后产生的新组合）

如果 scheduled 失败，**不阻塞** main 但必须在 24h 内有人响应（rotation 中的 on-call）。
