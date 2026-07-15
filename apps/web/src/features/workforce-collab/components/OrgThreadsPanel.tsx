import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '../../../components/ui/Skeleton';
import { EmptyState } from '../../../components/ui/EmptyState';
import { ApiError } from '../../../api/client';
import {
  useThreads, useThreadMessages, useCreateThread, usePostMessage, useCloseThread,
  type OrgConversationThread, type ThreadType, type MessageType,
} from '../../../api/queries/workforce-collab';

/** org 级讨论线程（B1）：线程列表 + 建线程 + 选线程看消息/发消息/关线程。admin-gated。 */
export function OrgThreadsPanel({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const threads = useThreads(orgId);
  const [selected, setSelected] = useState<string>('');

  return (
    <div className="grid gap-6 md:grid-cols-[280px_1fr]">
      {/* 线程列表 + 建线程 */}
      <div className="space-y-4">
        <NewThreadForm orgId={orgId} />
        <div>
          <h3 className="mb-2 text-sm font-medium text-text-secondary">{t('collab.threads.heading')}</h3>
          {threads.isLoading ? <Skeleton variant="table" /> : threads.error ? (
            <p role="alert" className="text-sm text-error">{errMsg(t, threads.error)}</p>
          ) : !threads.data?.length ? (
            <EmptyState title={t('collab.threads.empty')} message={t('collab.threads.emptyHint')} />
          ) : (
            <ul className="space-y-1">
              {threads.data.map((th: OrgConversationThread) => (
                <li key={th.id}>
                  <button onClick={() => setSelected(th.id)}
                    className={`w-full rounded-lg border p-2 text-left text-xs ${selected === th.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-neutral-1'}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-text-primary">{t(`collab.threadType.${th.threadType}`)}</span>
                      <span className="text-text-secondary">{t(`collab.threadStatus.${th.status}`, th.status)}</span>
                    </div>
                    {th.taskId && <span className="text-text-secondary">task: {th.taskId}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 消息面板 */}
      <div>
        {selected ? <ThreadMessages orgId={orgId} threadId={selected}
          thread={threads.data?.find(x => x.id === selected)} /> : (
          <EmptyState title={t('collab.threads.selectTitle')} message={t('collab.threads.selectHint')} />
        )}
      </div>
    </div>
  );
}

function errMsg(t: (k: string) => string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return t('collab.errors.rateLimited');
    if (err.status === 409) return t('collab.errors.threadGovernance');
    return err.messageId ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const THREAD_TYPES: ThreadType[] = ['delegation', 'report', 'handoff', 'coordination'];
const MESSAGE_TYPES: MessageType[] = ['note', 'request', 'response', 'report', 'escalation'];

function NewThreadForm({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const create = useCreateThread(orgId);
  const [threadType, setThreadType] = useState<ThreadType>('coordination');
  const [createdByWorkerId, setCreatedByWorkerId] = useState('');
  const [taskId, setTaskId] = useState('');

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <h3 className="text-sm font-medium text-text-primary">{t('collab.threads.new')}</h3>
      <select value={threadType} onChange={e => setThreadType(e.target.value as ThreadType)} className="w-full rounded border border-border px-2 py-1 text-xs">
        {THREAD_TYPES.map(x => <option key={x} value={x}>{t(`collab.threadType.${x}`)}</option>)}
      </select>
      <input value={createdByWorkerId} onChange={e => setCreatedByWorkerId(e.target.value)} placeholder={t('collab.createdByWorkerId')} className="w-full rounded border border-border px-2 py-1 text-xs" />
      <input value={taskId} onChange={e => setTaskId(e.target.value)} placeholder={t('collab.threads.taskIdOptional')} className="w-full rounded border border-border px-2 py-1 text-xs" />
      <button disabled={!createdByWorkerId.trim() || create.isPending}
        onClick={() => create.mutate({ threadType, createdByWorkerId: createdByWorkerId.trim(), taskId: taskId.trim() || undefined }, { onSuccess: () => setTaskId('') })}
        className="rounded bg-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50">{create.isPending ? t('common.loading') : t('collab.threads.create')}</button>
      {create.error && <p role="alert" className="text-xs text-error">{errMsg(t, create.error)}</p>}
    </div>
  );
}

function ThreadMessages({ orgId, threadId, thread }: { orgId: string; threadId: string; thread?: OrgConversationThread }) {
  const { t } = useTranslation();
  const messages = useThreadMessages(orgId, threadId);
  const post = usePostMessage(orgId, threadId);
  const close = useCloseThread(orgId);
  const [fromWorkerId, setFromWorkerId] = useState('');
  const [messageType, setMessageType] = useState<MessageType>('note');
  const [content, setContent] = useState('');

  const canPost = fromWorkerId.trim() && content.trim() && !post.isPending;
  const isOpen = thread?.status === 'open';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text-secondary">{t('collab.threads.messages')}</h3>
        {isOpen && (
          <button disabled={close.isPending} onClick={() => { if (window.confirm(t('collab.threads.confirmClose'))) close.mutate(threadId); }}
            className="rounded border border-border px-2 py-1 text-xs text-error disabled:opacity-50">{t('collab.threads.close')}</button>
        )}
      </div>

      {messages.isLoading ? <Skeleton variant="table" /> : messages.error ? (
        <p role="alert" className="text-sm text-error">{errMsg(t, messages.error)}</p>
      ) : !messages.data?.length ? (
        <p className="text-xs text-text-secondary">{t('collab.threads.noMessages')}</p>
      ) : (
        <ul className="space-y-2">
          {messages.data.map(m => (
            <li key={m.id} className="rounded-lg border border-border p-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium text-text-primary">{m.fromWorkerId}</span>
                <span className="rounded bg-neutral-1 px-1.5 py-0.5 text-text-secondary">{t(`collab.messageType.${m.messageType}`)}</span>
              </div>
              <p className="mt-1 text-text-secondary">{m.content}</p>
            </li>
          ))}
        </ul>
      )}

      {isOpen && (
        <div className="space-y-2 border-t border-border pt-3">
          <input value={fromWorkerId} onChange={e => setFromWorkerId(e.target.value)} placeholder={t('collab.fromWorkerId')} className="w-full rounded border border-border px-2 py-1 text-xs" />
          <select value={messageType} onChange={e => setMessageType(e.target.value as MessageType)} className="w-full rounded border border-border px-2 py-1 text-xs">
            {MESSAGE_TYPES.map(x => <option key={x} value={x}>{t(`collab.messageType.${x}`)}</option>)}
          </select>
          <textarea value={content} onChange={e => setContent(e.target.value)} rows={2} maxLength={4000} placeholder={t('collab.threads.messagePlaceholder')} className="w-full rounded border border-border px-2 py-1 text-xs" />
          <button disabled={!canPost} onClick={() => post.mutate({ fromWorkerId: fromWorkerId.trim(), messageType, content: content.trim() }, { onSuccess: () => setContent('') })}
            className="rounded bg-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50">{post.isPending ? t('common.loading') : t('collab.threads.send')}</button>
          {post.error && <p role="alert" className="text-xs text-error">{errMsg(t, post.error)}</p>}
        </div>
      )}
    </div>
  );
}
