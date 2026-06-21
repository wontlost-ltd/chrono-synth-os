import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkerExecutionActor, MissingHumanPrincipalError } from '../../workforce/worker-execution-actor.js';

/* ADR-0055 D1：数字员工执行 actor 身份——worker 是 actor 不是法律 principal，principal 必须人类非空。 */
describe('resolveWorkerExecutionActor（D1 执行 actor 身份）', () => {
  it('正常：产出 org_worker actor + 人类 principal', () => {
    const actor = resolveWorkerExecutionActor('w1', 'user-alice');
    assert.equal(actor.invokerType, 'org_worker');
    assert.equal(actor.invokerId, 'worker:w1', 'invokerId 标识具体 worker');
    assert.equal(actor.invokerUserId, 'user-alice', '人类法律 principal 固化');
  });

  it('★铁律★：principal 为 null → 抛错（org_worker 不得无 principal 执行）', () => {
    assert.throws(() => resolveWorkerExecutionActor('w1', null), MissingHumanPrincipalError);
    assert.throws(() => resolveWorkerExecutionActor('w1', undefined), MissingHumanPrincipalError);
    assert.throws(() => resolveWorkerExecutionActor('w1', '   '), /缺少人类法律 principal/);
  });

  it('principal 去空白', () => {
    assert.equal(resolveWorkerExecutionActor('w1', '  user-bob  ').invokerUserId, 'user-bob');
  });

  it('确定性：相同输入相同 actor', () => {
    assert.deepEqual(resolveWorkerExecutionActor('w1', 'u'), resolveWorkerExecutionActor('w1', 'u'));
  });
});
