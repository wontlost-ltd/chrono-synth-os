/**
 * 数字员工执行 actor 身份（ADR-0055 D1）——把一个数字员工解析成 ToolInvocationPipeline 的调用者身份。
 *
 * 铁律（ADR-0055 D0.1 + D0.4）：数字员工是**执行 actor 不是法律 principal**。
 *   - invokerType = 'org_worker'（审计归因到「这是数字员工干的」）；
 *   - invokerId = 'worker:<workerId>'（具体哪个员工）；
 *   - invokerUserId = **人类法律 principal**（org owner / 授权管理员），**绝不为 null**——
 *     org_worker 真实执行必须固化人类 principal，否则法律 principal 只是文档语义而非系统不变量。
 *
 * 本切片只产出 actor 身份（纯函数）；审批门（D2）与真实执行接线（D3）后续。
 *
 * 设计取舍（Codex 复审）：「org_worker 必须有人类 principal」当前是**运行时**强制（本函数抛错）+
 * 返回类型 invokerUserId: string（非可空）。未把整个 InvokeRequest 做成 discriminated union 在类型层
 * 强制——那会破坏所有现有 mcp/internal/admin 调用方（InvokeRequest 被广泛构造）；D1 用「让 org_worker
 * 执行路径只经本 helper 取身份」来保证不变量，类型层强制留作后续重构。
 */

/** worker 执行 actor 身份（喂给 ToolInvocationPipeline.invoke 的调用者三元组）。 */
export interface WorkerExecutionActor {
  readonly invokerType: 'org_worker';
  readonly invokerId: string;
  /** 人类法律 principal（绝不为 null）。 */
  readonly invokerUserId: string;
}

/** worker 执行 actor 解析失败（缺人类 principal 等）。 */
export class MissingHumanPrincipalError extends Error {
  constructor(workerId: string) {
    super(`数字员工 ${workerId} 的真实执行缺少人类法律 principal——org_worker 不得以无 principal 执行`);
    this.name = 'MissingHumanPrincipalError';
  }
}

/**
 * 把一个数字员工 + 其人类法律 principal 解析成执行 actor 身份（确定性纯函数）。
 * principalUserId 必须非空（人类法律责任主体，ADR-0055）；为空 → 抛错（不允许无 principal 执行）。
 */
export function resolveWorkerExecutionActor(workerId: string, principalUserId: string | null | undefined): WorkerExecutionActor {
  const principal = (principalUserId ?? '').trim();
  if (principal.length === 0) throw new MissingHumanPrincipalError(workerId);
  return {
    invokerType: 'org_worker',
    invokerId: `worker:${workerId}`,
    invokerUserId: principal,
  };
}
