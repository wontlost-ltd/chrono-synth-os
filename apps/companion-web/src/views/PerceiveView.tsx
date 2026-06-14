import { useEffect, useState, type JSX } from 'react';
import type { CompanionPerceiveResultV1 } from '@chrono/contracts';
import { perceive, ApiAuthError } from '../api.js';
import { useSpeechRecognition } from '../useSpeechRecognition.js';

/** representation 上限（与后端契约 PERCEIVE_REPRESENTATION_MAX_LEN 一致）。 */
const MAX_LEN = 4000;

type Status = 'idle' | 'perceiving' | 'ok' | 'error';

/**
 * 「让 TA 听一段」：用户把一段经历交给数字人，人格用确定性感知蒸馏器沉淀为记忆，并以第一人称
 * 反馈「我记住了什么」。
 *
 * 输入两路：① 直接打字；② 点麦克风**说**——浏览器设备端 ASR（useSpeechRecognition）把语音转成
 * 文字填进同一个输入框，用户可二次编辑再提交。论点红线（ADR-0051）：原始音频不离开浏览器，
 * 服务端只收转写后的文本表征。不支持 Web Speech 的环境自动隐藏麦克风，只留文字输入（渐进增强）。
 */
export function PerceiveView(): JSX.Element {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompanionPerceiveResultV1 | null>(null);
  const speech = useSpeechRecognition();

  /* 听写时实时文本驱动输入框——用户边说边看到文字出现。 */
  useEffect(() => {
    if (speech.listening) setText(speech.transcript);
  }, [speech.listening, speech.transcript]);

  const trimmed = text.trim();
  const tooLong = text.length > MAX_LEN;
  const canSubmit = trimmed.length > 0 && !tooLong && status !== 'perceiving' && !speech.listening;

  async function onSubmit(): Promise<void> {
    if (!canSubmit) return;
    setStatus('perceiving');
    setError(null);
    setResult(null);
    try {
      const res = await perceive({ modality: 'audio', representation: trimmed });
      setResult(res);
      setStatus('ok');
      setText('');
    } catch (err) {
      if (err instanceof ApiAuthError) {
        /* 401 未登录：App 会话订阅切回登录页；403 是 plan/权限（companion 面向个人版），
         * 文案区分——不把 403 误导成登录问题（Codex 复审）。 */
        setStatus('error');
        setError(err.status === 403 ? '当前账号无法使用感知（companion 面向个人版账号）' : '请重新登录');
        return;
      }
      setStatus('error');
      setError(err instanceof Error ? err.message : '感知失败');
    }
  }

  return (
    <section className="view">
      <div className="card">
        <h2 className="card__title">让 TA 听一段</h2>
        <p className="muted">
          把一段经历交给你的数字人——它会以自己的视角理解，并把它记住。之后聊天时它能引用这段经历。
        </p>
        <textarea
          className="perceive__input"
          aria-label="要让数字人感知的经历"
          placeholder={speech.supported ? '打字，或点麦克风说给 TA 听……' : '例如：今天开会很累，但我没和别人说……'}
          value={text}
          maxLength={MAX_LEN}
          rows={4}
          disabled={status === 'perceiving' || speech.listening}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="perceive__actions">
          <span className="muted">{text.length}/{MAX_LEN}</span>
          <div className="perceive__buttons">
            {speech.supported && (
              <button
                type="button"
                className={`perceive__mic${speech.listening ? ' perceive__mic--on' : ''}`}
                disabled={status === 'perceiving'}
                aria-pressed={speech.listening}
                aria-label={speech.listening ? '停止说话' : '点击说给数字人听'}
                onClick={() => { if (speech.listening) speech.stop(); else speech.start(); }}
              >
                {speech.listening ? '● 停止' : '🎙 说'}
              </button>
            )}
            <button
              type="button"
              className="perceive__submit"
              disabled={!canSubmit}
              onClick={() => { void onSubmit(); }}
            >
              {status === 'perceiving' ? '我正在听…' : '让 TA 听'}
            </button>
          </div>
        </div>
        {speech.listening && <p className="perceive__hint muted" role="status">我正在听你说……（说完点「停止」）</p>}
        {speech.error && <p className="perceive__hint perceive__hint--error" role="alert">{speech.error}</p>}
        {tooLong && <p className="perceive__hint perceive__hint--error">这段太长了，请精简到 {MAX_LEN} 字以内。</p>}
        {status === 'error' && error && <p className="perceive__hint perceive__hint--error" role="alert">{error}</p>}
      </div>

      {status === 'ok' && result && (
        <div className="card" aria-live="polite">
          {result.perceivedMemories.length === 0 ? (
            <p className="muted">我没有从这段里听出可以记住的事。</p>
          ) : (
            <>
              <h3 className="card__title">我记住了</h3>
              <ul className="perceive__memories">
                {result.perceivedMemories.map((m) => (
                  <li key={m.id} className="perceive__memory">{m.content}</li>
                ))}
              </ul>
              {result.pendingApprovalCount > 0 && (
                <p className="muted">
                  这段经历可能影响我对你的理解，但我不会自己改变——有 {result.pendingApprovalCount} 处会等你确认。
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
