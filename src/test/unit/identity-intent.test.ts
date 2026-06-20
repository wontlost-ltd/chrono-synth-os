import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectIdentityIntent, detectUserName } from '../../conversation/identity-intent.js';

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
      const r = detectIdentityIntent(input, 'zh-CN');
      assert.equal(r.kind, 'define', `「${input}」应为 define`);
      assert.equal(r.name, name, `「${input}」应提取名字「${name}」`);
    }
  });

  it('问名字（ask）：专问名字的说法识别为询问（含「你现在/到底/究竟叫什么」副词插入）', () => {
    for (const q of [
      '你叫什么', '你叫什么名字', '你的名字呢', '你的名字', '你的名字是什么', '怎么称呼你', '你叫啥',
      '你现在叫什么', '你到底叫什么', '你究竟叫啥', '你现在叫什么名字', '你这会儿叫什么',
    ]) {
      assert.equal(detectIdentityIntent(q, 'zh-CN').kind, 'ask', `「${q}」应为 ask`);
    }
  });

  it('「你是谁」更宽 → 交给 self_intro 综述，不在此拦为 ask', () => {
    assert.equal(detectIdentityIntent('你是谁', 'zh-CN').kind, 'none', '「你是谁」不归 identity-ask（self_intro 处理）');
  });

  it('ask 优先于 define：「你的名字是什么」是询问不是起名', () => {
    assert.equal(detectIdentityIntent('你的名字是什么', 'zh-CN').kind, 'ask');
    /* 而「你的名字是小May」是起名。 */
    const define = detectIdentityIntent('你的名字是小May', 'zh-CN');
    assert.equal(define.kind, 'define');
    assert.equal(define.name, '小May');
  });

  it('非身份意图 → none', () => {
    for (const s of ['今天天气不错', '我喜欢跑步', '怎么做 flat white', '介绍一下你自己']) {
      assert.equal(detectIdentityIntent(s, 'zh-CN').kind, 'none', `「${s}」应为 none`);
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
      assert.notEqual(detectIdentityIntent(s, 'zh-CN').kind, 'define', `「${s}」绝不应被当起名`);
    }
  });

  it('名字清洗：剥离句尾语气词，不把「了/呢」并入名字', () => {
    assert.equal(detectIdentityIntent('以后你就叫张三了', 'zh-CN').name, '张三');
    assert.equal(detectIdentityIntent('你叫小明吧', 'zh-CN').name, '小明');
  });

  it('控制字符：显式起名结构里的名字仍清洗控制字符', () => {
    /* 显式起名结构（给你起名叫X）允许稍复杂名字；提取后名字不含控制字符。 */
    const r = detectIdentityIntent('给你起名叫小明', 'zh-CN');
    assert.equal(r.kind, 'define');
    assert.ok(!/[\n\t]/.test(r.name ?? ''), '名字不含控制字符');
  });

  it('确定性：相同输入 → 相同输出', () => {
    assert.deepEqual(detectIdentityIntent('我叫你Max', 'zh-CN'), detectIdentityIntent('我叫你Max', 'zh-CN'));
  });
});

/* ADR-0056 关系层：用户自报名字识别。 */
describe('detectUserName', () => {
  it('中文：我叫X / 叫我X / 我的名字是X → 用户名', () => {
    assert.equal(detectUserName('我叫小明', 'zh-CN'), '小明');
    assert.equal(detectUserName('叫我老王', 'zh-CN'), '老王');
    assert.equal(detectUserName('我的名字是张三', 'zh-CN'), '张三');
  });
  it('英文：call me X / my name is X → 用户名', () => {
    assert.equal(detectUserName('call me Alex', 'en'), 'Alex');
    assert.equal(detectUserName('my name is Sarah', 'en'), 'Sarah');
  });
  it('对抗（Codex 复审）：英文「I am 形容词/状态/动作」不当用户名', () => {
    for (const s of ['I am happy', 'I am tired', "I'm okay", "I'm sorry", 'I am going home', 'I am working late']) {
      assert.equal(detectUserName(s, 'en'), undefined, `「${s}」不该被当用户名`);
    }
  });
  it('不误判：「你叫X」（给数字人起名）不当用户自报', () => {
    assert.equal(detectUserName('你叫Max', 'zh-CN'), undefined);
    assert.equal(detectUserName('what is your name', 'en'), undefined);
  });
});

/* ADR-0055 多语种：英文身份意图（en locale）。 */
describe('detectIdentityIntent (en)', () => {
  it('起名（define）：多种英文说法都识别并提取名字', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['call you Max', 'Max'],
      ["I'll call you Echo", 'Echo'],
      ['your name is Luna', 'Luna'],
      ['your name will be Aria', 'Aria'],
      ["you're called Sam", 'Sam'],
      ['name you Pip', 'Pip'],
    ];
    for (const [input, name] of cases) {
      const r = detectIdentityIntent(input, 'en');
      assert.equal(r.kind, 'define', `「${input}」应为 define`);
      assert.equal(r.name, name, `「${input}」应提取「${name}」`);
    }
  });

  it('问名字（ask）：英文问法识别为询问（含 whats 无撇号）', () => {
    for (const q of ["what's your name", 'what is your name', 'whats your name', 'what are you called', 'what should I call you', 'do you have a name', 'your name?', 'tell me your name']) {
      assert.equal(detectIdentityIntent(q, 'en').kind, 'ask', `「${q}」应为 ask`);
    }
  });

  it('对抗（Codex 复审）：英文普通 what-问题不被误拦为问名字', () => {
    /* 「what are you doing / what is your favorite color」不是问名字，不该走身份回答。 */
    for (const q of ['what are you doing', 'what is your favorite color', 'what are you thinking', "what's your plan"]) {
      assert.notEqual(detectIdentityIntent(q, 'en').kind, 'ask', `「${q}」不该被当问名字`);
    }
  });

  it('对抗（Codex 复审）：英文「call/name you + 动作/介词/否定」不误判为起名', () => {
    for (const s of [
      'call you back', 'call you a taxi', 'call you later', 'call you tomorrow morning',
      "I'll call you after lunch", 'I can call you from work', 'call you maybe', 'recall you Max',
      'your name is not Max',
    ]) {
      assert.notEqual(detectIdentityIntent(s, 'en').kind, 'define', `「${s}」不应被当起名`);
    }
  });

  it('对抗（Codex 复审 2）：英文疑问/转述上下文的 call you X 不误判为起名', () => {
    for (const s of [
      'Can I call you Max?', 'May I call you Echo?', 'Should I call you Luna?', 'Do I call you Sam?',
      'Would you like me to call you Aria?', 'They call you Max.', 'People call you Echo.',
    ]) {
      assert.notEqual(detectIdentityIntent(s, 'en').kind, 'define', `「${s}」是疑问/转述，不应起名`);
    }
  });

  it('非身份意图 → none', () => {
    for (const s of ['I like running', 'how are you', 'the weather is nice']) {
      assert.equal(detectIdentityIntent(s, 'en').kind, 'none', `「${s}」应为 none`);
    }
  });
});
