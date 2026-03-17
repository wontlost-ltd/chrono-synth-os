/**
 * 自适应问卷引擎 — 薄适配器，委托 kernel 领域逻辑
 */

import { QUESTIONS, evaluateQuestionnaire } from '@chrono/kernel';
import type { Question, QuestionResponse, InferredParameters } from '@chrono/kernel';

export type { Question, QuestionResponse, InferredParameters };

export class QuestionnaireEngine {
  /** 获取所有可用问题 */
  getQuestions(): readonly Question[] {
    return QUESTIONS;
  }

  /** 评估用户答案，推断 L2/L3 参数 */
  evaluate(responses: readonly QuestionResponse[]): InferredParameters {
    return evaluateQuestionnaire(responses);
  }
}
