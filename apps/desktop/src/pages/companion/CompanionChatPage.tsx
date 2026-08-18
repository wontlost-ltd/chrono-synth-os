/**
 * 「跟 TA 聊聊」——桌面版数字人对话页（ADR-0047 零-LLM 对话 C 端补全）。
 *
 * 回应**运行时零 LLM**：由确定性离线回应器据人格叙事 + 数字人自己沉淀的记忆（关键词检索 grounding）
 * 生成第一人称回应。单机模式经内嵌 sidecar；离线/无云仍能聊；无相关记忆时诚实告知，不瞎编。
 *
 * 教它成长：聊天中的**陈述句**会被后端沉淀成记忆（如「你叫小明」它会记住并第一人称认领）；**问句**
 * 不沉淀。这是它与普通聊天机器人的区别——记住经历、逐步长出人格。
 */

import { useRef, useState, type JSX } from 'react';
import { chatWithCompanion, CHAT_MESSAGE_MAX_LEN } from '@/companion/chat-data';
import { ApiNotConfiguredError, ApiHttpError } from '@/bridge/http-client';

interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'persona';
  readonly text: string;
  /** persona 消息的来源标签（按回应 kind，透明展示回应有据/无据）。 */
  readonly meta?: string;
}

let seq = 0;
const nextId = (): string => `m${seq++}`;

/** 按回应类型给来源标签——不同 kind 来源不同，避免一律标「我还不了解这个」。 */
function metaForKind(kind: string, groundedCount: number): string {
  switch (kind) {
    case 'self_identity': return '这是我自己';
    case 'self_intro': return '我介绍我自己';
    case 'relationship': return '关于你我';
    case 'summary': return '我归纳的';
    case 'response_template': return '我学过的';
    case 'knowledge_grounded': return '据我记得的';
    case 'boundary_block':
    case 'boundary_escalate': return '这个我不方便聊';
    default: return groundedCount > 0 ? '据我记得的' : '我还不了解这个';
  }
}

/** 把各类错误转成用户可读的一句话。 */
function readableError(err: unknown): string {
  if (err instanceof ApiNotConfiguredError) return '本地引擎尚未就绪，请稍候再试。';
  if (err instanceof ApiHttpError) {
    if (err.status === 403) return '当前账号无法使用对话（对话面向个人版）。';
    if (err.status === 429) return '对话有点频繁，歇一下再聊。';
    return `发送失败（HTTP ${err.status}）。`;
  }
  /* 网络错（TypeError，WebKit 原生 message 是「Load failed」）——本地引擎可能刚重连，端口变了；
   * 已自动重试一次仍失败 → 给可操作提示而非原始「Load failed」。 */
  if (err instanceof TypeError) return '连不上本地引擎（可能刚重连）——请再发一次。';
  return err instanceof Error ? err.message : '发送失败';
}

export function CompanionChatPage(): JSX.Element {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= CHAT_MESSAGE_MAX_LEN && !sending;

  async function onSend(): Promise<void> {
    if (!canSend) return;
    const userMsg: ChatMessage = { id: nextId(), role: 'user', text: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setText('');
    setError(null);
    setSending(true);
    try {
      const res = await chatWithCompanion(trimmed);
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'persona', text: res.reply, meta: metaForKind(res.kind, res.groundedMemoryCount) },
      ]);
      /* 回应到达后滚到底。scrollIntoView 在 jsdom/无 DOM 环境不存在 → 守卫（否则微任务里抛未捕获
       * 异常，测试环境会判失败）。 */
      queueMicrotask(() => {
        const el = listEndRef.current;
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth' });
        }
      });
    } catch (err) {
      setError(readableError(err));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    /* Enter 发送，Shift+Enter 换行。 */
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="rounded-2xl border border-chrono-border bg-chrono-elevated p-6">
        <p className="text-sm text-chrono-text-muted">跟 TA 聊聊</p>
        <h1 className="mt-1 text-2xl font-bold text-chrono-text-primary">和你的数字人对话</h1>
        <p className="mt-2 text-sm text-chrono-text-secondary">
          它的回应只来自你教过它的、它自己记住的——离线也能聊，没听过的会如实告诉你。
          说陈述句（比如「你叫小明」）它会记住；问句不沉淀。
        </p>
      </header>

      {/* 消息列表 */}
      <section
        className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-chrono-border bg-chrono-surface p-4"
        aria-label="对话记录"
      >
        {messages.length === 0 ? (
          <p className="text-sm text-chrono-text-muted">
            还没有对话。打个招呼，或者教它点什么吧——比如给它起个名字。
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={
                  m.role === 'user'
                    ? 'max-w-[80%] rounded-2xl rounded-br-sm bg-chrono-primary px-4 py-2 text-sm text-white'
                    : 'max-w-[80%] rounded-2xl rounded-bl-sm border border-chrono-border bg-chrono-elevated px-4 py-2 text-sm text-chrono-text-primary'
                }
              >
                <p className="whitespace-pre-wrap">{m.text}</p>
                {m.meta && (
                  <p className="mt-1 text-[11px] text-chrono-text-muted">{m.meta}</p>
                )}
              </div>
            </div>
          ))
        )}
        <div ref={listEndRef} />
      </section>

      {error && (
        <p role="alert" className="text-sm text-chrono-error">
          {error}
        </p>
      )}

      {/* 输入区 */}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          maxLength={CHAT_MESSAGE_MAX_LEN}
          placeholder="跟你的数字人说点什么…（Enter 发送，Shift+Enter 换行）"
          aria-label="消息输入"
          className="flex-1 resize-none rounded-xl border border-chrono-border bg-chrono-elevated px-3 py-2 text-sm text-chrono-text-primary placeholder:text-chrono-text-muted focus:border-chrono-primary focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void onSend()}
          disabled={!canSend}
          className={
            canSend
              ? 'rounded-xl bg-chrono-primary px-5 py-2 text-sm font-semibold text-white transition hover:bg-chrono-primary/90'
              : 'cursor-not-allowed rounded-xl bg-chrono-border px-5 py-2 text-sm font-semibold text-chrono-text-secondary'
          }
        >
          {sending ? '…' : '发送'}
        </button>
      </div>
    </div>
  );
}
