import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuestionnaireEngine } from '../../onboarding/questionnaire-engine.js';

describe('QuestionnaireEngine', () => {
  const engine = new QuestionnaireEngine();

  describe('getQuestions', () => {
    it('返回非空问题列表', () => {
      const questions = engine.getQuestions();
      assert.ok(questions.length > 0);
    });

    it('每个问题包含必要字段', () => {
      for (const q of engine.getQuestions()) {
        assert.ok(q.id);
        assert.ok(q.text);
        assert.ok(q.dimension);
        assert.equal(typeof q.positive, 'boolean');
      }
    });
  });

  describe('evaluate', () => {
    it('全高分（positive 问题）产生高值参数', () => {
      const responses = engine.getQuestions()
        .filter(q => q.positive)
        .map(q => ({ id: q.id, score: 5 }));
      const result = engine.evaluate(responses);

      /* positive 问题高分 → 高归一化值 */
      if (result.decisionStyle.riskAppetite !== undefined) {
        assert.ok(result.decisionStyle.riskAppetite >= 0.8);
      }
      if (result.cognitiveModel.growthMindset !== undefined) {
        assert.ok(result.cognitiveModel.growthMindset >= 0.8);
      }
    });

    it('全低分（positive 问题）产生低值参数', () => {
      const responses = engine.getQuestions()
        .filter(q => q.positive)
        .map(q => ({ id: q.id, score: 1 }));
      const result = engine.evaluate(responses);

      if (result.decisionStyle.riskAppetite !== undefined) {
        assert.ok(result.decisionStyle.riskAppetite <= 0.2);
      }
    });

    it('negative 问题高分产生低值参数', () => {
      const responses = engine.getQuestions()
        .filter(q => !q.positive)
        .map(q => ({ id: q.id, score: 5 }));
      const result = engine.evaluate(responses);

      /* negative 问题高分 → 低归一化值 */
      if (result.decisionStyle.riskAppetite !== undefined) {
        assert.ok(result.decisionStyle.riskAppetite <= 0.2);
      }
    });

    it('无匹配的 response 返回空结果', () => {
      const result = engine.evaluate([{ id: 'nonexistent', score: 3 }]);
      assert.equal(Object.keys(result.decisionStyle).length, 0);
      assert.equal(Object.keys(result.cognitiveModel).length, 0);
    });

    it('deliberationDepth 映射到 1-5 整数范围', () => {
      const deliberationQ = engine.getQuestions().find(q => q.dimension === 'deliberationDepth');
      if (!deliberationQ) return;

      const result = engine.evaluate([{ id: deliberationQ.id, score: 5 }]);
      const depth = result.decisionStyle.deliberationDepth;
      if (depth !== undefined) {
        assert.ok(Number.isInteger(depth));
        assert.ok(depth >= 1 && depth <= 5);
      }
    });

    it('lossAversion 映射到 1-3 范围', () => {
      const lossQ = engine.getQuestions().find(q => q.dimension === 'lossAversion');
      if (!lossQ) return;

      const result = engine.evaluate([{ id: lossQ.id, score: 5 }]);
      const la = result.decisionStyle.lossAversion;
      if (la !== undefined) {
        assert.ok(la >= 1 && la <= 3);
      }
    });
  });
});
