import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybookRegistry, InvalidPlaybookRegistrationError } from '../../workforce/playbook-registry.js';
import type { DecompositionPlaybook } from '../../workforce/types.js';

/* M2 versioned rule pack：playbook 是有版本的规则包，可审计/可演进/可回溯。确定性零-LLM。 */
describe('PlaybookRegistry（M2 playbook 版本注册表）', () => {
  function pb(goalType: string, version: number, provenance: 'reference' | 'distilled' = 'reference'): DecompositionPlaybook {
    return {
      goalType, version, provenance,
      qualityRubric: [{ dimension: 'd', description: 'x' }],
      decompose: () => [{ assigneeRoleCode: 'r', title: `t-v${version}`, taskType: 'x', riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: 'a', requiredCapabilities: [] }],
    };
  }

  it('注册首版 → 激活；getActive 返回该版', () => {
    const r = new PlaybookRegistry();
    const v1 = pb('g', 1);
    r.register(v1);
    assert.equal(r.getActive('g'), v1);
    assert.equal(r.activeVersionOf('g'), 1);
  });

  it('★演进★：注册更高版本 → 激活切到新版（运行时用新规则）', () => {
    const r = new PlaybookRegistry();
    r.register(pb('g', 1));
    const v2 = pb('g', 2, 'distilled');
    r.register(v2);
    assert.equal(r.getActive('g'), v2, '激活切到 v2');
    assert.equal(r.activeVersionOf('g'), 2);
    assert.equal(r.getActive('g')!.provenance, 'distilled');
    /* 历史版本保留可审计/回滚。 */
    assert.equal(r.getVersion('g', 1)!.version, 1);
    assert.deepEqual(r.listVersions('g'), [1, 2]);
  });

  it('★不回退★：注册更低版本只入历史，不改激活', () => {
    const r = new PlaybookRegistry();
    r.register(pb('g', 2));
    r.register(pb('g', 1)); /* 补登旧版 */
    assert.equal(r.activeVersionOf('g'), 2, '激活仍是 2，注册旧版不回退运行时');
    assert.deepEqual(r.listVersions('g'), [1, 2]);
  });

  it('★幂等(按内容)★：同 version、结构相同但**不同对象** → 幂等不报错', () => {
    const r = new PlaybookRegistry();
    r.register(pb('g', 1));
    /* pb('g',1) 每次返回新对象但内容(rubric/decompose 源码)相同 → 指纹同 → 幂等。 */
    assert.doesNotThrow(() => r.register(pb('g', 1)));
    assert.equal(r.activeVersionOf('g'), 1);
    assert.deepEqual(r.listVersions('g'), [1]);
  });

  it('★不可变(按内容)★：同 version、rubric 不同 → 抛错', () => {
    const r = new PlaybookRegistry();
    r.register(pb('g', 1));
    const diff: DecompositionPlaybook = { ...pb('g', 1), qualityRubric: [{ dimension: 'OTHER', description: 'z' }] };
    assert.throws(() => r.register(diff), InvalidPlaybookRegistrationError, 'rubric 不同→内容不可变');
  });

  it('★不可变(按内容)★：同 version、decompose 不同 → 抛错', () => {
    const r = new PlaybookRegistry();
    r.register(pb('g', 1));
    const diff: DecompositionPlaybook = {
      ...pb('g', 1),
      decompose: () => [{ assigneeRoleCode: 'DIFFERENT', title: 'x', taskType: 'y', riskLevel: 'low', allowsToolExecution: false, acceptanceCriteria: 'a', requiredCapabilities: [] }],
    };
    assert.throws(() => r.register(diff), InvalidPlaybookRegistrationError, 'decompose 不同→内容不可变');
  });

  it('★运行时不可变★：注册后 mutate 原对象，getActive 行为不变(深冻结)', () => {
    const r = new PlaybookRegistry();
    const v1 = pb('g', 1);
    r.register(v1);
    /* 试图 mutate 原对象的 rubric（已被深冻结 → 静默无效或抛 TypeError，严格模式抛）。 */
    assert.throws(() => { (v1.qualityRubric as Array<{ dimension: string; description: string }>).push({ dimension: 'hacked', description: 'x' }); });
    /* 注册版本不受影响。 */
    assert.equal(r.getActive('g')!.qualityRubric.length, 1, '注册版本 rubric 未被污染');
  });

  it('version 必须 ≥1 整数', () => {
    const r = new PlaybookRegistry();
    assert.throws(() => r.register(pb('g', 0)), /≥1/);
    assert.throws(() => r.register(pb('g', 1.5)), /整数/);
  });

  it('未知 goalType → undefined/空', () => {
    const r = new PlaybookRegistry();
    assert.equal(r.getActive('nope'), undefined);
    assert.equal(r.activeVersionOf('nope'), undefined);
    assert.deepEqual(r.listVersions('nope'), []);
  });

  it('多 goalType 互不影响；goalTypeList 确定性排序', () => {
    const r = new PlaybookRegistry();
    r.register(pb('b', 1));
    r.register(pb('a', 3));
    assert.deepEqual(r.goalTypeList(), ['a', 'b']);
    assert.equal(r.activeVersionOf('a'), 3);
    assert.equal(r.activeVersionOf('b'), 1);
  });
});
