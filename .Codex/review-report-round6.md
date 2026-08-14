# 第六轮代码审查报告

**审查范围**：`7c9fc25^..ac1f659`（包含起点 `7c9fc25`，共 7 个提交）  
**审查方式**：独立只读源码审查 + 本地编译/测试 + 两项定向变异验证  
**审查建议**：退回（修复 1 个可确定复现的 SIEM `flush()` 单飞竞态后复审）  
**综合评分**：89/100  
**品味评分**：一般

## 执行摘要

第五轮要求的四项均已正确落地：

1. `releaseDigestClaim()` 返回 `false` 时不再被当作成功；实现会继续至最多 3 次，三次均失败后记录错误日志（`src/integrations/github/github-learning-service.ts:311-332`）。
2. 最终日志调用由 `try/catch` 隔离，logger 后端异常不会向上传播（同文件 `:325-332`）。
3. `releaseClaimDurably()` 已改为 `void`，调用点也未消费结果（同文件 `:252,265,311`）。
4. 两条新增测试真实覆盖目标分支（`src/test/unit/github-learning-service.test.ts:372-397,399-418`），且独立变异验证均转红，不是假绿。

生产装配也已把 service logger 绑定到租户 OS（`src/integrations/github/github-learn-task-wiring.ts:63-81`）；同步 HTTP 路径同样注入租户 logger（`src/server/routes/companion/learn-github.ts:171-176`）。

补审包含起点提交 `7c9fc25` 后，发现 1 个足以要求修复的新增运行时缺陷：SIEM `flush()` 的单飞状态存在“已结束 drain、尚未清除 `inFlight`”窗口。空队列调用 `flush()` 后同步 `enqueue()`，再 `await flush()`，第二次调用会在 `src/siem/siem-delivery.ts:107-110` 复用已经结束的 Promise，新事件保持 pending、不会被此次明确 flush 投递。在 `flushIntervalMs=0` 的外部驱动模式（该值也是默认值，`:40-45`）下，若没有后续第三次 flush，事件可无限滞留。当前源码稳定复现结果：`{"delivered":[],"pending":1}`。

另有 1 个不阻断的新增文档瑕疵：helper 已为 `void`，但方法注释仍写“改为返回布尔值”（`src/integrations/github/github-learning-service.ts:308-311`）。这是明确的注释/签名不一致，不影响行为、类型或测试。

既有 lease/崩溃回收架构项按本轮约定排除，不计分、不阻断。

## 四项修正核实

### 1. false 失败语义与最终告警

- `releaseDigestClaim(...) === true` 才提前返回；`false` 写入失败原因并进入下一轮（`:314-323`）。
- 循环边界为 `1..3`，到底后仅记录一次告警（`:312-330`）。
- 抛错与 `false` 共享同一重试/告警出口，没有新增特殊分支。
- `releaseDigestClaim` 的底层契约确实以 `rowsAffected === 1` 表示成功（`src/storage/github-learn-store.ts:87-95`）。

结论：正确落地。在排除既有 lease 架构项后，未发现 `releaseClaimDurably` 可证明的运行时缺陷。

### 2. logger 异常隔离

- logger 为可选窄接口，仅暴露 `error`；最终调用被完整包含在 `try/catch` 中（`github-learning-service.ts:327-332`）。
- logger 抛错不会掩盖老师失败或账本释放失败，也不会令 `learn()` reject。

结论：正确落地。

### 3. helper void

- 签名为 `void`（`:311`）。
- 两个失败窗口调用点只执行副作用，不读取返回值（`:252,265`）。

结论：正确落地。唯一瑕疵是 `:308` 的旧注释仍称“返回布尔值”。

### 4. 测试与变异把守

- false 用例同时断言 3 次尝试、1 次日志以及后果文案（测试 `:378-396`），能够区分“调用了一次但误判成功”和“到底未告警”。
- logger 用例用 `assert.doesNotReject` 包住完整 `learn()`，logger 明确抛错（测试 `:413-418`），覆盖异常传播边界。
- 独立变异 A：把实现改为“不检查返回值、调用后直接 return”，用例失败：`1 !== 3`。
- 独立变异 B：移除 logger 外层 `try/catch`，用例失败：`Got unwanted rejection`，实际错误为“日志后端故障”。

结论：两条测试均是真把守，无假绿。

## 全批次审查

检查了全部业务改动，并交叉读取至少三个相关实现/模式：

- GitHub claim/release 存储契约：`src/storage/github-learn-store.ts:66-95`；
- 感知三态与部分写入错误：`src/perception/perception-distiller.ts:103-142`；
- GitHub 两条生产装配路径：task wiring `:63-81`、HTTP route `:171-176`；
- 投影版本单调的内存与 SQLite 双实现：`src/data-plane/in-memory-projection-store.ts:31-43`、`src/data-plane/sqlite-projection-store.ts:23-41`；
- PostgreSQL 事务 client 的 BEGIN/COMMIT/ROLLBACK/close 生命周期：`src/storage/postgres-database.ts:244-314`；
- 配额输入约束及所有调用点：`src/multi-tenant/quota-manager.ts:62-118`。

补审 `7c9fc25` 的 P0 改动后，CEF header/extension CRLF 清理（`src/siem/cef-formatter.ts:35-58`）、AWS key 检测/脱敏双实现（`src/conversation/pii-redactor.ts:45-49`、`src/data-classification/pii-detector.ts:77-84`）、GitHub claimed-only DELETE（`src/storage/executors/github-learn-executors.ts:120-133`）均未发现新增缺陷；但 SIEM 单飞实现存在上述可复现竞态。批次内 GitHub 错误窗口划分仍然正确：落库前可释放，部分/全部落库后保持 claim，老师失败的空结果单独识别（`github-learning-service.ts:220-289`）。

## 审查五层法

### 第一层：数据结构（96/100）

claim 行仍是幂等所有权边界；`PartialPerceptionError.writtenMemoryIds` 显式携带部分成功状态，避免用猜测推断是否可重试。投影双实现统一版本单调语义。通过。

### 第二层：特殊情况（82/100）

GitHub 路径中 `false` 与异常统一为释放失败，处理正确；但 SIEM 单飞遗漏“drain 已完成、finally 尚未清状态”这一 Promise 微任务边界，明确 `flush()` 可返回而没有处理调用前已入队的事件。需修改。

### 第三层：复杂度（90/100）

GitHub helper 单一职责、固定三次循环、无深层嵌套。SIEM 的三行单飞实现表面简单，但状态清理依赖 Promise `finally` 微任务时序，契约没有闭合；另有方法注释与实际 `void` 签名失配。

### 第四层：破坏性（87/100）

GitHub 私有 helper 改签名无外部兼容影响，生产 logger 取源与租户依赖一致；但 SIEM 明确 `await flush()` 的调用者可能误以为本次调用前已入队事件已被尝试投递，外部驱动模式下属于行为回归。

### 第五层：可行性（95/100）

修复直接针对可复现的永久跳过、重复摄入、连接泄漏、投影回退和错误配额输入；方案规模与问题严重度匹配。通过。

## 评分

| 维度 | 分数 | 说明 |
|---|---:|---|
| 代码质量 | 89 | GitHub 边界清晰；SIEM 单飞存在微任务竞态；一处过期注释 |
| 测试覆盖 | 88 | GitHub 两项变异有效，但 SIEM 未覆盖空 drain 与 enqueue 的交错 |
| 规范遵循 | 94 | 中文注释、现有框架、无新依赖；注释签名轻微失配 |
| 技术平均 | 90 | — |
| 需求匹配 | 97 | 四项要求逐项落地 |
| 架构一致 | 95 | 租户 logger 与依赖同源，存储契约未扩散 |
| 风险评估 | 84 | 已明确排除 lease，但首提交单飞竞态此前漏审 |
| 战略平均 | 92 | — |

**综合评分：89/100**  
**建议：退回**

## 本地验证证据

1. `npm run typecheck`：EXIT 0。
2. `npm run build`：EXIT 0。
3. 定向测试：
   `node --test --test-force-exit dist/test/unit/github-learning-service.test.js dist/test/integration/perception-distiller.test.js dist/test/unit/in-memory-projection-store.test.js dist/test/unit/sqlite-projection-store.test.js dist/test/unit/platform-key-resolver.test.js dist/test/unit/siem-delivery.test.js`
   ——68 tests，68 pass，0 fail，EXIT 0。
4. `git diff --check 7c9fc25..ac1f659`：EXIT 0。
5. 两项临时副本变异测试：均按预期 EXIT 1，分别被目标新增测试捕获；未修改工作树源码。
6. 起点提交定向测试：CEF、PII、SIEM、GitHub 共 61 tests，61 pass，0 fail，EXIT 0。
7. SIEM 时序复现：先对空队列调用 `flush()`，同步 `enqueue('late')`，再 `await flush()`；当前构建输出 `{"delivered":[],"pending":1}`，证明现有测试存在覆盖缺口。

## 最终决策

`releaseClaimDurably` 在本轮约束下行为闭合，两条新测试确实能把守；第五轮四项本身全部通过。全 7 提交口径下，`src/siem/siem-delivery.ts:107-110` 存在可确定复现的新增运行时竞态：第二次明确 `flush()` 可复用已经结束的 drain，调用前已入队事件仍保持 pending。应修复并增加“空 flush → 同步 enqueue → 第二次 flush 必须投递”的回归测试。另有 `github-learning-service.ts:308-311` 的非阻断注释失配。

**建议：退回**
