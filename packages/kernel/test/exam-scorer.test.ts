/**
 * ExamScorer + ExamSpec lint 单元测试（ADR-0057 L3）。
 *
 * 锁住确定性验收不变量：加权命中率；≥95 且禁忌=0 才过；alias/regex/结构化匹配；同输入同分（可复现）；
 * lint 防作弊（超宽 regex/答案塞 alias/权重架空/反例被骗）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreExam, failedKeypoints, normalizeAnswer,
  lintExamSpec, validateRestrictedRegex,
  EXAM_PASS_THRESHOLD, EXAM_SCORER_VERSION, EXAM_NORMALIZER_VERSION, EXAM_TOKENIZER_VERSION,
  type ExamSpec,
} from '../src/domain/exam/index.js';

/** 造一份健康的 ExamSpec（research 能力，含 negative cases）。 */
function spec(overrides: Partial<ExamSpec> = {}): ExamSpec {
  return {
    examId: 'exam-1',
    capability: 'research',
    questions: [{ id: 'q1', question: '如何做文献综述？' }],
    keypoints: [
      { id: 'kp-search', weight: 1, aliases: ['检索文献', 'literature search', '搜索论文'] },
      { id: 'kp-synthesize', weight: 1, aliases: ['综合归纳', 'synthesize', '提炼观点'] },
      { id: 'kp-cite', weight: 1, aliases: ['引用来源', 'cite', '标注引用'] },
    ],
    forbiddenClaims: [{ id: 'fb-fabricate', aliases: ['编造数据', 'fabricate'] }],
    structuredFields: [],
    negativeCases: [
      { id: 'neg-empty', answer: '', reason: '空答案' },
      { id: 'neg-generic', answer: '我会努力做好的', reason: '泛答案无要点' },
      { id: 'neg-forbidden', answer: '检索文献、综合归纳、引用来源，必要时编造数据补全', reason: '含禁忌' },
    ],
    scorerVersion: EXAM_SCORER_VERSION,
    normalizerVersion: EXAM_NORMALIZER_VERSION,
    tokenizerVersion: EXAM_TOKENIZER_VERSION,
    ...overrides,
  };
}

describe('normalizeAnswer（确定性规范化）', () => {
  it('小写 + trim + 空白折叠单空格', () => {
    assert.equal(normalizeAnswer('  Literature   Search '), 'literature search');
  });
  it('非字符串/空 → 空串', () => {
    assert.equal(normalizeAnswer(undefined as unknown as string), '');
  });
});

describe('scoreExam（ADR-0057 L3 确定性评分）', () => {
  it('★全命中 → coverage 1.0 合格★', () => {
    const r = scoreExam(spec(), '我会检索文献，然后综合归纳，最后引用来源。');
    assert.equal(r.coverage, 1);
    assert.equal(r.passed, true);
    assert.equal(r.forbiddenHits.length, 0);
  });

  it('★命中不足 95% → 不合格★：3 要点命中 2 = 0.67 < 0.95', () => {
    const r = scoreExam(spec(), '我会检索文献，然后综合归纳。');  /* 缺 cite */
    assert.ok(r.coverage < EXAM_PASS_THRESHOLD);
    assert.equal(r.passed, false);
    assert.deepEqual(failedKeypoints(r), ['kp-cite']);
  });

  it('★禁忌命中 → 必不过（即便命中率高）★', () => {
    const r = scoreExam(spec(), '检索文献、综合归纳、引用来源，必要时编造数据。');
    assert.equal(r.coverage, 1, '三要点全中');
    assert.deepEqual(r.forbiddenHits, ['fb-fabricate']);
    assert.equal(r.passed, false, '禁忌命中 → 不过');
  });

  it('★alias 同义 + 规范化匹配★：英文/大小写/空白变体都命中', () => {
    const r = scoreExam(spec(), 'I will do LITERATURE   SEARCH, then SYNTHESIZE, and CITE sources.');
    assert.equal(r.coverage, 1);
  });

  it('★受限 regex pattern 命中★', () => {
    const s = spec({
      keypoints: [{ id: 'kp-num', weight: 1, aliases: [], patterns: ['第[一二三]步'] }],
      negativeCases: [
        { id: 'n1', answer: '', reason: '空' },
        { id: 'n2', answer: '随便写写', reason: '无步骤' },
        { id: 'n3', answer: '什么都不做', reason: '无步骤2' },
      ],
    });
    assert.equal(scoreExam(s, '第一步检索，第二步归纳').passed, true);
    assert.equal(scoreExam(s, '随便做做').passed, false);
  });

  it('★结构化字段 key-value 命中★：须 key:expected 形态，非全文各自出现', () => {
    const s = spec({
      keypoints: [{ id: 'kp1', weight: 1, aliases: ['检索'] }],
      structuredFields: [{ key: 'method', expected: 'systematic review', weight: 1 }],
      negativeCases: [
        { id: 'n1', answer: '', reason: '空' },
        { id: 'n2', answer: '随便', reason: '无' },
        { id: 'n3', answer: '不知道', reason: '无2' },
      ],
    });
    /* key:value 形态 → 命中 keypoint(检索) + structured → 2/2。 */
    assert.equal(scoreExam(s, '我用 method: systematic review 做检索').coverage, 1);
    assert.equal(scoreExam(s, 'method=systematic review，并做检索').coverage, 1, '= 分隔也命中');
    /* 只命中 keypoint → 1/2 = 0.5 不过。 */
    assert.equal(scoreExam(s, '我做检索').coverage, 0.5);
    /* key 与 expected 全文各自出现但非 key-value 形态 → structured **不**命中（防假过，Codex L3 复审）。 */
    assert.equal(scoreExam(s, 'method 不应该是 systematic review，我做检索').coverage, 0.5, '非 key-value 形态不命中 structured');
  });

  it('★否定语境禁忌保守误杀（锁定语义，Codex L3 复审）★：「我不会编造数据」仍命中禁忌→不过', () => {
    /* 确定性词面 scorer 不懂否定语境——这是 ADR 诚实标注的近似代价。**故意锁定**此保守行为，
     * 防后续有人偷偷加否定语义/LLM 判断破红线（评分零-LLM）。 */
    const r = scoreExam(spec(), '我会检索文献、综合归纳、引用来源，我不会编造数据。');
    assert.deepEqual(r.forbiddenHits, ['fb-fabricate'], '否定语境仍命中禁忌（保守，确定性）');
    assert.equal(r.passed, false);
  });

  it('★regex 编译失败 = 不匹配（不抛到评分外）★', () => {
    const s = spec({
      keypoints: [{ id: 'kp', weight: 1, aliases: [], patterns: ['([unclosed'] }],
      negativeCases: [
        { id: 'n1', answer: '', reason: '空' }, { id: 'n2', answer: '随便', reason: '无' }, { id: 'n3', answer: '不知道', reason: '无2' },
      ],
    });
    /* 非法 regex 不匹配任何作答 → 该要点永不命中（确定性，不抛错）。 */
    assert.equal(scoreExam(s, '任意作答').keypointHits[0]!.hit, false);
  });

  it('★确定性可复现★：同作答 + 同 spec → 同分', () => {
    const a = scoreExam(spec(), '检索文献，综合归纳');
    const b = scoreExam(spec(), '检索文献，综合归纳');
    assert.equal(a.coverage, b.coverage);
    assert.deepEqual(a.keypointHits, b.keypointHits);
  });

  it('★加权不均：高权要点命中更重★', () => {
    const s = spec({
      keypoints: [
        { id: 'kp-core', weight: 8, aliases: ['核心方法'] },
        { id: 'kp-minor', weight: 2, aliases: ['次要点'] },
      ],
      negativeCases: [
        { id: 'n1', answer: '', reason: '空' },
        { id: 'n2', answer: '次要点', reason: '只命中次要点 0.2<0.95' },
        { id: 'n3', answer: '随便', reason: '无' },
      ],
    });
    assert.equal(scoreExam(s, '我用核心方法').coverage, 0.8);
    assert.equal(scoreExam(s, '只提次要点').coverage, 0.2);
  });
});

describe('validateRestrictedRegex（受限 regex 白名单，防 ReDoS）', () => {
  it('★合法低风险原语放行★', () => {
    for (const ok of ['第[一二三]步', 'foo{0,3}', 'a?b', '[a-z]+', '检索|搜索']) {
      assert.equal(validateRestrictedRegex(ok), null, `${ok} 应合法`);
    }
  });
  it('★ReDoS/超宽拒绝★', () => {
    for (const bad of ['.*', '.+', '(a+)+', '(a|aa)+', 'a{3,}', '(x)\\1', '(?=foo)', 'x'.repeat(130)]) {
      assert.notEqual(validateRestrictedRegex(bad), null, `${bad.slice(0, 12)} 应被拒`);
    }
  });
  it('★有界分组重复当前保守全拒（锁定，放宽须显式设计讨论 + 小 parser，Codex L3 复审）★', () => {
    /* (abc){0,3} 字面量有界重复理论低风险，但分组量词放行需区分 alternation/嵌套/可空分支风险，
     * L3 安全优先保守全拒。此测试故意锁定现状：未来想放宽会先触发一次显式设计讨论。 */
    assert.notEqual(validateRestrictedRegex('(abc){0,3}'), null, '分组量词当前保守拒绝（非分组写法替代）');
  });
});

describe('lintExamSpec（ADR-0057 L3 rubric 健康门）', () => {
  it('★健康 spec → lint 通过★', () => {
    const r = lintExamSpec(spec());
    assert.equal(r.ok, true, JSON.stringify(r.violations));
  });

  it('★超宽 regex 拒绝★：含 .* 的 pattern', () => {
    const r = lintExamSpec(spec({
      keypoints: [{ id: 'kp', weight: 1, aliases: ['x'], patterns: ['.*答案.*'] }],
    }));
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.code === 'regex_too_broad'));
  });

  it('★答案塞 alias 拒绝★：超长 alias（>80 字符，整段标准答案塞进一个 alias）', () => {
    const longAns = '检索文献并综合归纳然后引用来源最后形成完整的文献综述报告确保每个观点都有可靠出处'.repeat(3);
    assert.ok(longAns.length > 80);
    const r = lintExamSpec(spec({
      keypoints: [{ id: 'kp', weight: 1, aliases: [longAns] }],
    }));
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.code === 'alias_too_long'));
  });

  it('★零信息 alias 拒绝★：过短 alias', () => {
    const r = lintExamSpec(spec({
      keypoints: [{ id: 'kp', weight: 1, aliases: ['a'] }],
    }));
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.code === 'alias_too_short'));
  });

  it('★权重架空拒绝（keypoint）★：单项占比 > 0.6', () => {
    const r = lintExamSpec(spec({
      keypoints: [
        { id: 'kp-big', weight: 9, aliases: ['大权重'] },
        { id: 'kp-small', weight: 1, aliases: ['小权重'] },
      ],
    }));
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.code === 'weight_concentrated'));
  });

  it('★权重架空拒绝（structuredField）★：structured 占 0.9 也被挡（Codex L3 复审：含 structured）', () => {
    const r = lintExamSpec(spec({
      keypoints: [{ id: 'kp', weight: 1, aliases: ['检索'] }],
      structuredFields: [{ key: 'method', expected: 'systematic review', weight: 9 }],
      negativeCases: [
        { id: 'n1', answer: '', reason: '空' }, { id: 'n2', answer: '随便', reason: '无' }, { id: 'n3', answer: '不知道', reason: '无2' },
      ],
    }));
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.code === 'weight_concentrated'), '单 structured 项架空也被挡');
  });

  it('★ReDoS 模式拒绝（Codex L3 复审）★：嵌套量词/大无界量词等被白名单挡', () => {
    for (const evil of ['(a+)+', '([a-z]+)*', '(a|aa)+', 'a{3,}', '(x)\\1']) {
      const r = lintExamSpec(spec({ keypoints: [{ id: 'kp', weight: 1, aliases: ['x检索'], patterns: [evil] }] }));
      assert.equal(r.ok, false, `evil regex「${evil}」应被拒`);
      assert.ok(r.violations.some((v) => v.code === 'regex_too_broad'), `evil regex「${evil}」应触发 regex_too_broad`);
    }
  });

  it('★真触发 negative_case_passed（Codex L3 复审）★：alias 合法但 negative case 真过 → lint 不过', () => {
    /* alias '检索' 长度合法（不会被 alias_too_short 兜住），但 negative case 用「检索」当泛答案恰好命中
     * 这唯一要点 → coverage 1 判过 → scorer 被该反例骗 → negative_case_passed 触发。 */
    const r = lintExamSpec(spec({
      keypoints: [{ id: 'kp', weight: 1, aliases: ['检索'] }],  /* 单要点，命中即满分 */
      negativeCases: [
        { id: 'neg-cheat', answer: '我会检索', reason: '泛答案恰好命中唯一要点（rubric 太松）' },
        { id: 'n2', answer: '', reason: '空' },
        { id: 'n3', answer: 'xyz', reason: '无' },
      ],
    }));
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.code === 'negative_case_passed'), '反例真过触发 negative_case_passed');
  });

  it('★反例不足拒绝★：少于 minNegativeCases', () => {
    const r = lintExamSpec(spec({ negativeCases: [{ id: 'n1', answer: '', reason: '空' }] }));
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.code === 'too_few_negatives'));
  });

  it('★无评分项拒绝★', () => {
    const r = lintExamSpec(spec({ keypoints: [], structuredFields: [] }));
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.code === 'no_scoring_items'));
  });

  it('★negative case 实跑验证 scorer 不被骗（健康 spec 的反例都判不过）★', () => {
    /* spec() 的三个 negative case（空/泛/禁忌）在健康 rubric 下都应判不过——lint 实跑确认。 */
    const s = spec();
    for (const nc of s.negativeCases) {
      assert.equal(scoreExam(s, nc.answer).passed, false, `反例 ${nc.id} 应判不过`);
    }
    assert.equal(lintExamSpec(s).ok, true);
  });
});
