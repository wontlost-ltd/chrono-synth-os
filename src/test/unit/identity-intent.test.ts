import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectIdentityIntent } from '../../conversation/identity-intent.js';

/* ADR-0055 第一人称身份意图识别——纯确定性，相同输入相同输出。 */
describe('detectIdentityIntent', () => {
  it('起名（define）：多种说法都能识别并提取名字', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['我给你起个名字叫张三', '张三'],
      ['以后你就叫张三了', '张三'],
      ['我叫你Max', 'Max'],
      ['你叫小明', '小明'],
      ['你现在叫Max', 'Max'],
      ['你的名字是小May', '小May'],
      ['你的名字叫阿强', '阿强'],
      ['给你起名叫阿黄', '阿黄'],
    ];
    for (const [input, name] of cases) {
      const r = detectIdentityIntent(input);
      assert.equal(r.kind, 'define', `「${input}」应为 define`);
      assert.equal(r.name, name, `「${input}」应提取名字「${name}」`);
    }
  });

  it('问名字（ask）：专问名字的说法识别为询问（含「你现在/到底/究竟叫什么」副词插入）', () => {
    for (const q of [
      '你叫什么', '你叫什么名字', '你的名字呢', '你的名字', '你的名字是什么', '怎么称呼你', '你叫啥',
      '你现在叫什么', '你到底叫什么', '你究竟叫啥', '你现在叫什么名字', '你这会儿叫什么',
    ]) {
      assert.equal(detectIdentityIntent(q).kind, 'ask', `「${q}」应为 ask`);
    }
  });

  it('「你是谁」更宽 → 交给 self_intro 综述，不在此拦为 ask', () => {
    assert.equal(detectIdentityIntent('你是谁').kind, 'none', '「你是谁」不归 identity-ask（self_intro 处理）');
  });

  it('ask 优先于 define：「你的名字是什么」是询问不是起名', () => {
    assert.equal(detectIdentityIntent('你的名字是什么').kind, 'ask');
    /* 而「你的名字是小May」是起名。 */
    const define = detectIdentityIntent('你的名字是小May');
    assert.equal(define.kind, 'define');
    assert.equal(define.name, '小May');
  });

  it('非身份意图 → none', () => {
    for (const s of ['今天天气不错', '我喜欢跑步', '怎么做 flat white', '介绍一下你自己']) {
      assert.equal(detectIdentityIntent(s).kind, 'none', `「${s}」应为 none`);
    }
  });

  it('对抗用例（Codex 复审）：「你叫+动作短语」绝不误判为起名', () => {
    /* 这些是命令/陈述，不是起名——裸形强约束（短名字 token + 排除动作字 + 紧接句尾）应挡住。 */
    const adversarial = [
      '你叫得真大声', '你叫起来真好听', '你叫我一声爸爸', '你叫服务员过来', '你叫一下外卖',
      '我叫你别乱动', '我叫你一声哥', '以后我叫你起床', '你叫Max吗', '你叫Max还是May',
      '你现在叫服务员过来', '你现在叫他过来',
      '你现在叫车', '你现在叫救护车', '你现在叫客服', '你从此叫车',
    ];
    for (const s of adversarial) {
      assert.notEqual(detectIdentityIntent(s).kind, 'define', `「${s}」绝不应被当起名`);
    }
  });

  it('名字清洗：剥离句尾语气词，不把「了/呢」并入名字', () => {
    assert.equal(detectIdentityIntent('以后你就叫张三了').name, '张三');
    assert.equal(detectIdentityIntent('你叫小明吧').name, '小明');
  });

  it('控制字符：显式起名结构里的名字仍清洗控制字符', () => {
    /* 显式起名结构（给你起名叫X）允许稍复杂名字；提取后名字不含控制字符。 */
    const r = detectIdentityIntent('给你起名叫小明');
    assert.equal(r.kind, 'define');
    assert.ok(!/[\n\t]/.test(r.name ?? ''), '名字不含控制字符');
  });

  it('确定性：相同输入 → 相同输出', () => {
    assert.deepEqual(detectIdentityIntent('我叫你Max'), detectIdentityIntent('我叫你Max'));
  });
});
