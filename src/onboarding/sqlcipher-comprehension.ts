/**
 * sqlcipher UX 5-question comprehension quiz.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §5.2 P3-D
 *
 * Acceptance criteria from plan: "≥90% completion + ≥90% comprehension".
 * The "completion" half is UI work (people finish all 5 questions);
 * the "comprehension" half is **this** — for each participant, did
 * they answer ≥90% correctly? That requires a stable question bank
 * with canonical answers AND a path-aware variant set:
 *
 *   - personal device: emphasises "if you lose your passphrase your
 *     data is unrecoverable"
 *   - MDM-managed device: emphasises "the IT recovery key exists; ask
 *     your admin if you forget"
 *
 * Both copy paths must teach the same load-bearing fact (encryption
 * at rest is on; passphrase is the only key) without misleading the
 * MDM user into thinking nothing is encrypted.
 */

export type DeviceContext = 'personal' | 'mdm';

export interface QuizQuestion {
  /** Stable id; analytics joins answers to questions by this. */
  id: string;
  /** The question text presented to the user. */
  prompt: string;
  /** Multiple-choice options (index → text). */
  options: readonly string[];
  /** Index of the correct option. */
  correctIndex: number;
  /** Why this question matters — surfaced as an explanation when wrong. */
  explanation: string;
}

/**
 * Build the 5-question quiz for the device context. Returns the same 5
 * questions in the same order every time (analytics relies on
 * order-stability for question-by-question comprehension breakdowns).
 */
export function buildQuiz(context: DeviceContext): QuizQuestion[] {
  const passphraseLossQ: QuizQuestion = context === 'personal' ? {
    id: 'sqlcipher.passphrase-loss',
    prompt: 'You forget your passphrase. What happens to your local data?',
    options: [
      'It is recoverable through ChronoSynth support',
      'It is permanently unrecoverable',
      'It auto-restores from cloud backup',
      'You can re-derive the passphrase from your email',
    ],
    correctIndex: 1,
    explanation: 'On personal devices we have no recovery channel — the passphrase IS the key. If you forget it the encrypted database cannot be opened by anyone, including us. Use a password manager.',
  } : {
    id: 'sqlcipher.passphrase-loss',
    prompt: 'You forget your passphrase on your work-managed laptop. What is the recovery path?',
    options: [
      'Contact your IT admin; the MDM-managed recovery key can re-derive your passphrase',
      'It is permanently unrecoverable',
      'ChronoSynth support can reset it',
      'Reinstall the app to skip the passphrase',
    ],
    correctIndex: 0,
    explanation: 'MDM-managed devices have an organisation recovery key escrowed by your IT admin. They (not us) can release it after their identity-verification process.',
  };

  const encryptionScopeQ: QuizQuestion = {
    id: 'sqlcipher.encryption-scope',
    prompt: 'What is encrypted at rest by sqlcipher?',
    options: [
      'Only sensitive fields the app marks as PII',
      'The entire local database file',
      'Only data that has been synced to the cloud',
      'Nothing — encryption only happens during transport',
    ],
    correctIndex: 1,
    explanation: 'sqlcipher encrypts every page of the SQLite file. Even a forensic disk image without the passphrase yields ciphertext only.',
  };

  const passphraseStrengthQ: QuizQuestion = {
    id: 'sqlcipher.passphrase-strength',
    prompt: 'Which of these passphrases best protects your local database?',
    options: [
      'Your name + birth year',
      '12 random words from a passphrase generator',
      'The same password you use elsewhere',
      'A 4-digit PIN',
    ],
    correctIndex: 1,
    explanation: '12 random words from a generator gives ~150 bits of entropy — uncrackable. Reused passwords are vulnerable to credential-stuffing attacks against breach lists.',
  };

  const lockoutQ: QuizQuestion = {
    id: 'sqlcipher.lockout',
    prompt: 'After 5 wrong passphrase attempts in a row, the app:',
    options: [
      'Wipes the local database immediately',
      'Locks the database for a cool-down window (5 minutes the first time, doubling)',
      'Sends you a recovery email',
      'Continues accepting attempts forever',
    ],
    correctIndex: 1,
    explanation: 'Exponential backoff prevents brute-force without destroying data on a fat-finger streak. Five attempts in a row is unusual enough to justify the friction.',
  };

  const cloudSyncQ: QuizQuestion = context === 'personal' ? {
    id: 'sqlcipher.cloud-sync',
    prompt: 'Does cloud sync send your passphrase to ChronoSynth servers?',
    options: [
      'Yes — that is how multi-device sync works',
      'No — the passphrase never leaves the device; sync uses a separate key',
      'Only the first time you set it up',
      'Only the hash of your passphrase is sent',
    ],
    correctIndex: 1,
    explanation: 'Passphrase stays local. Sync uses an unrelated per-device key derived during onboarding; the server cannot read your encrypted data even if it sees your sync traffic.',
  } : {
    id: 'sqlcipher.cloud-sync',
    prompt: 'On your MDM-managed device, when you sync to the cloud:',
    options: [
      'Your IT admin can read your encrypted notes via the recovery key',
      'Only ChronoSynth backend can read your sync stream',
      'No-one but you can read your notes; the recovery key only unlocks the LOCAL DB, not sync',
      'Sync is disabled on MDM devices',
    ],
    correctIndex: 2,
    explanation: 'The IT recovery key opens the local sqlcipher database only; it has no cryptographic relationship to the per-device sync key. Your IT admin cannot read your sync history.',
  };

  return [passphraseLossQ, encryptionScopeQ, passphraseStrengthQ, lockoutQ, cloudSyncQ];
}

export interface QuizAnswer {
  questionId: string;
  chosenIndex: number;
}

export interface QuizResult {
  totalQuestions: number;
  correct: number;
  /** correct/total, range [0, 1]. */
  comprehensionRatio: number;
  /** Whether the participant met the ≥90% comprehension bar. */
  passed: boolean;
  /** Per-question outcome — analytics-friendly. */
  perQuestion: Array<{ questionId: string; chosenIndex: number; correctIndex: number; correct: boolean }>;
}

/**
 * Score a participant's answers. Unanswered questions count as wrong
 * (so partial completion doesn't game the comprehension ratio).
 */
export function scoreQuiz(quiz: QuizQuestion[], answers: readonly QuizAnswer[]): QuizResult {
  const byId = new Map<string, QuizAnswer>();
  for (const a of answers) byId.set(a.questionId, a);

  const perQuestion = quiz.map(q => {
    const ans = byId.get(q.id);
    const chosenIndex = ans?.chosenIndex ?? -1;
    return {
      questionId: q.id,
      chosenIndex,
      correctIndex: q.correctIndex,
      correct: chosenIndex === q.correctIndex,
    };
  });
  const correct = perQuestion.filter(r => r.correct).length;
  const ratio = quiz.length === 0 ? 0 : correct / quiz.length;
  return {
    totalQuestions: quiz.length,
    correct,
    comprehensionRatio: ratio,
    /* ≥90% bar per plan acceptance. */
    passed: ratio >= 0.9,
  /* eslint-disable-next-line @typescript-eslint/no-unsafe-assignment */
    perQuestion,
  };
}
