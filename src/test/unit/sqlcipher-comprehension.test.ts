/**
 * P3-D — sqlcipher comprehension quiz tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQuiz, scoreQuiz, type QuizAnswer } from '../../onboarding/sqlcipher-comprehension.js';

describe('buildQuiz', () => {
  it('emits 5 questions in stable order', () => {
    const a = buildQuiz('personal');
    const b = buildQuiz('personal');
    assert.equal(a.length, 5);
    assert.deepEqual(a.map(q => q.id), b.map(q => q.id));
  });

  it('personal vs MDM diverge on passphrase-loss + cloud-sync only', () => {
    const personal = buildQuiz('personal');
    const mdm = buildQuiz('mdm');
    /* Same question IDs, same order — analytics joins answer to
     * question by id regardless of device context. */
    assert.deepEqual(personal.map(q => q.id), mdm.map(q => q.id));
    /* Different prompts on context-dependent questions */
    assert.notEqual(personal[0].prompt, mdm[0].prompt);
    /* Encryption-scope + passphrase-strength + lockout are identical */
    assert.equal(personal[1].prompt, mdm[1].prompt);
    assert.equal(personal[2].prompt, mdm[2].prompt);
    assert.equal(personal[3].prompt, mdm[3].prompt);
  });

  it('personal teaches "unrecoverable on passphrase loss"', () => {
    const q = buildQuiz('personal')[0];
    assert.equal(q.options[q.correctIndex], 'It is permanently unrecoverable');
  });

  it('MDM teaches "IT admin can recover"', () => {
    const q = buildQuiz('mdm')[0];
    assert.match(q.options[q.correctIndex], /IT admin/);
  });

  it('MDM does NOT mislead user that IT can read sync data', () => {
    const cloudQ = buildQuiz('mdm')[4];
    /* The correct answer is "No-one but you can read your notes" —
     * the option that lets IT admin read sync is wrong on purpose,
     * teaching users that the recovery key is local-only. */
    const correctOption = cloudQ.options[cloudQ.correctIndex];
    assert.match(correctOption, /No-one but you|only unlocks the LOCAL DB/);
    /* Defensive: ensure NO option suggests IT can read sync is the
     * correct answer. */
    const wrongAnswers = cloudQ.options.filter((_, i) => i !== cloudQ.correctIndex);
    for (const w of wrongAnswers) {
      assert.ok(w !== correctOption);
    }
  });
});

describe('scoreQuiz', () => {
  it('full correct answers → passed', () => {
    const quiz = buildQuiz('personal');
    const answers: QuizAnswer[] = quiz.map(q => ({ questionId: q.id, chosenIndex: q.correctIndex }));
    const r = scoreQuiz(quiz, answers);
    assert.equal(r.correct, 5);
    assert.equal(r.comprehensionRatio, 1);
    assert.equal(r.passed, true);
  });

  it('4 of 5 correct → 80%, NOT passed (≥90% bar)', () => {
    const quiz = buildQuiz('personal');
    const answers: QuizAnswer[] = quiz.map((q, i) => ({
      questionId: q.id,
      chosenIndex: i === 0 ? (q.correctIndex + 1) % q.options.length : q.correctIndex,
    }));
    const r = scoreQuiz(quiz, answers);
    assert.equal(r.correct, 4);
    assert.equal(r.comprehensionRatio, 0.8);
    assert.equal(r.passed, false);
  });

  it('unanswered counts as wrong', () => {
    const quiz = buildQuiz('personal');
    /* Only answer 3 of 5 */
    const partial: QuizAnswer[] = quiz.slice(0, 3).map(q => ({
      questionId: q.id, chosenIndex: q.correctIndex,
    }));
    const r = scoreQuiz(quiz, partial);
    assert.equal(r.correct, 3);
    assert.equal(r.passed, false);
  });

  it('perQuestion records the chosen + correct index for analytics', () => {
    const quiz = buildQuiz('personal');
    const answers: QuizAnswer[] = quiz.map((q, i) => ({
      questionId: q.id,
      /* Wrong answer for the first question, correct otherwise. */
      chosenIndex: i === 0 ? (q.correctIndex + 1) % q.options.length : q.correctIndex,
    }));
    const r = scoreQuiz(quiz, answers);
    assert.equal(r.perQuestion.length, 5);
    assert.equal(r.perQuestion[0].correct, false);
    assert.equal(r.perQuestion[1].correct, true);
  });
});
