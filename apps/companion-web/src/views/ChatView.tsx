import { useState, type JSX } from 'react';
import { chat, ApiAuthError } from '../api.js';

/** 一条对话消息（用户或数字人）。 */
interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'persona';
  readonly text: string;
  /** persona 消息的 meta 标签（按回应类型，透明展示回应来源）。 */
  readonly meta?: string;
}

const MAX_LEN = 2000;
let seq = 0;
const nextId = (): string => `m${seq++}`;

/** 按回应类型给 meta 标签（不同 kind 来源不同，避免一律标「我还不了解这个」）。 */
function metaForKind(kind: string, groundedCount: number): string {
  switch (kind) {
    case 'self_identity': return '这是我自己';
    case 'self_intro': return '我介绍我自己';
    case 'summary': return '我归纳的';
    case 'response_template': return '我学过的';
    case 'knowledge_grounded': return '据我记得的';
    case 'boundary_block':
    case 'boundary_escalate': return '这个我不方便聊';
    default: return groundedCount > 0 ? '据我记得的' : '我还不了解这个';
  }
}

/**
 * 「跟 TA 聊聊」：跟你的数字人对话。回应**运行时零 LLM**——由确定性离线回应器据人格叙事 + 数字人
 * 自己沉淀的记忆生成（关键词检索 grounding）。离线/无云仍能聊；无相关记忆时诚实告知，不瞎编。
 */
export function ChatView(): JSX.Element {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= MAX_LEN && !sending;

  async function onSend(): Promise<void> {
    if (!canSend) return;
    const userMsg: ChatMessage = { id: nextId(), role: 'user', text: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setText('');
    setError(null);
    setSending(true);
    try {
      const res = await chat(trimmed);
      setMessages((prev) => [...prev, {
        id: nextId(), role: 'persona', text: res.reply, meta: metaForKind(res.kind, res.groundedMemoryCount),
      }]);
    } catch (err) {
      if (err instanceof ApiAuthError) {
        setError(err.status === 403 ? '当前账号无法使用对话（companion 面向个人版账号）' : '请重新登录');
        return;
      }
      setError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="view">
      <div className="card">
        <h2 className="card__title">跟 TA 聊聊</h2>
        <p className="muted">
          跟你的数字人对话。它的回应只来自你教过它的、它自己记住的——离线也能聊；没听过的会如实告诉你。
        </p>
      </div>

      <div className="chat__log" aria-live="polite">
        {messages.length === 0 ? (
          <p className="muted chat__empty">说点什么吧。试试问它你和它聊过、教过的事。</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`chat__bubble chat__bubble--${m.role}`}>
              <p className="chat__text">{m.text}</p>
              {m.role === 'persona' && (
                <span className="chat__meta">{m.meta ?? ''}</span>
              )}
            </div>
          ))
        )}
      </div>

      <div className="card chat__composer">
        <textarea
          className="perceive__input"
          aria-label="对数字人说的话"
          placeholder="跟你的数字人说点什么……"
          value={text}
          maxLength={MAX_LEN}
          rows={2}
          disabled={sending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void onSend(); } }}
        />
        <div className="perceive__actions">
          <span className="muted">{text.length}/{MAX_LEN}</span>
          <button type="button" className="perceive__submit" disabled={!canSend} onClick={() => { void onSend(); }}>
            {sending ? '思考中…' : '发送'}
          </button>
        </div>
        {error && <p className="perceive__hint perceive__hint--error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
