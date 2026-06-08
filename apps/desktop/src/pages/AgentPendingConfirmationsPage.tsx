/**
 * 待审批的工具调用 (F3 — desktop parity).
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiNotConfiguredError, apiFetch } from '@/bridge/http-client';

interface PendingConfirmation {
  invocationId: string;
  toolId: string;
  personaId: string;
  invokerType: 'mcp' | 'internal' | 'admin';
  confirmationTokenId: string | null;
  invokedAt: number;
  inputHash: string;
  status: string;
}

interface Envelope<T> { data: T }

function formatTs(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}

export function AgentPendingConfirmationsPage() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['agentConfirmations', 'pending'],
    queryFn: async () => {
      const r = await apiFetch<Envelope<PendingConfirmation[]>>(
        '/api/v1/agent/confirmations/pending?limit=20',
      );
      return r.data;
    },
    refetchInterval: 30_000,
  });

  const reject = useMutation({
    mutationFn: async ({ tokenId, reason }: { tokenId: string; reason: string }) => {
      await apiFetch<Envelope<{ rejected: boolean }>>(
        `/api/v1/agent/confirmations/${tokenId}/reject`,
        { method: 'POST', body: { reason } },
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agentConfirmations'] }),
  });

  const [activeApproval, setActiveApproval] = useState<PendingConfirmation | null>(null);

  const isApiMissing = list.error instanceof ApiNotConfiguredError;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">待我审批</h1>
        <p className="mt-1 text-sm text-chrono-text-muted">
          高风险工具调用必须经过你的二次确认才会真正执行；30 秒内可撤销整个授权。
        </p>
      </header>

      {isApiMissing && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          未配置 chrono-synth-os API；在 Settings → API 中填入 base URL 和 JWT。
        </div>
      )}

      {list.isLoading && <p className="text-sm text-chrono-text-muted">加载中…</p>}
      {list.error && !isApiMissing && (
        <p className="text-sm text-red-300">加载失败：{(list.error as Error).message}</p>
      )}
      {!list.isLoading && !list.error && (list.data ?? []).length === 0 && (
        <p className="text-sm text-chrono-text-muted">没有待审批的工具调用。</p>
      )}

      {!list.isLoading && (list.data ?? []).length > 0 && (
        <ul className="space-y-3">
          {list.data!.map((c) => (
            <li
              key={c.invocationId}
              className="rounded-xl border border-chrono-border bg-chrono-elevated p-4 space-y-2"
            >
              <header className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{c.toolId}</span>
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-200">
                    待确认
                  </span>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="rounded bg-blue-500/30 px-3 py-1 text-xs text-blue-50 hover:bg-blue-500/50"
                    onClick={() => setActiveApproval(c)}
                  >
                    审批
                  </button>
                  <button
                    type="button"
                    className="text-xs text-red-300 hover:underline"
                    disabled={reject.isPending}
                    onClick={() => {
                      if (!c.confirmationTokenId) return;
                      const reason = window.prompt('拒绝原因（可选）') ?? 'user_rejected';
                      reject.mutate({ tokenId: c.confirmationTokenId, reason });
                    }}
                  >
                    拒绝
                  </button>
                </div>
              </header>
              <div className="grid grid-cols-2 gap-2 text-xs text-chrono-text-muted">
                <div>Persona：<span className="font-mono">{c.personaId}</span></div>
                <div>Invoker：<span className="font-mono">{c.invokerType}</span></div>
                <div>触发：{formatTs(c.invokedAt)}</div>
                <div>Input hash：<span className="font-mono">{c.inputHash.slice(0, 16)}…</span></div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {activeApproval && (
        <ApproveDialog
          item={activeApproval}
          onClose={() => setActiveApproval(null)}
          onSuccess={() => {
            setActiveApproval(null);
            void queryClient.invalidateQueries({ queryKey: ['agentConfirmations'] });
          }}
        />
      )}
    </div>
  );
}

interface ApproveDialogProps {
  item: PendingConfirmation;
  onClose: () => void;
  onSuccess: () => void;
}

function ApproveDialog({ item, onClose, onSuccess }: ApproveDialogProps) {
  const [argsJson, setArgsJson] = useState('{\n  \n}');
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!item.confirmationTokenId) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(argsJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('arguments 必须是 JSON 对象');
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'JSON 解析失败');
      return;
    }
    setParseError(null);
    setSubmitError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/v1/agent/confirmations/${item.confirmationTokenId}/approve`, {
        method: 'POST',
        body: { arguments: parsed },
      });
      onSuccess();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl border border-chrono-border bg-chrono-elevated p-4 space-y-3">
        <h2 className="text-base font-semibold">审批工具调用</h2>
        <div className="text-sm space-y-1">
          <p><strong>Tool：</strong> <span className="font-mono">{item.toolId}</span></p>
          <p><strong>Persona：</strong> <span className="font-mono">{item.personaId}</span></p>
          <p className="text-xs text-chrono-text-muted">
            后端为隐私保护不会持久化 arguments；请粘贴最初触发本次调用的参数 JSON。
          </p>
        </div>
        <textarea
          className={clsx(
            'w-full rounded border border-chrono-border bg-chrono-surface px-2 py-1 font-mono text-xs',
          )}
          rows={8}
          value={argsJson}
          onChange={(e) => setArgsJson(e.target.value)}
        />
        {parseError && <p className="text-xs text-red-300">{parseError}</p>}
        {submitError && <p className="text-xs text-red-300">提交失败：{submitError}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm text-chrono-text-muted hover:bg-chrono-border/30"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded bg-blue-500/40 px-3 py-1.5 text-sm text-white hover:bg-blue-500/60 disabled:opacity-60"
            disabled={submitting}
            onClick={handleSubmit}
          >
            {submitting ? '执行中…' : '执行'}
          </button>
        </div>
      </div>
    </div>
  );
}
