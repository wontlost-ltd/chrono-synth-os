/**
 * 「学习」——桌面版数字人成长页（ADR-0047「LLM 当老师」C 端）。
 *
 * 三块（成长期用 LLM 老师；运行时 chat 仍零-LLM）：
 *   1. 接 LLM 老师：选 provider（openai/anthropic/ollama）+ 可选自定义端点/模型/API key。
 *      - 官方 API key（BYOK）/ 自定义端点（接兼容网关/订阅代理）/ 本机 ollama（零凭据）。
 *   2. 自主学习（反思）：让数字人反思已学记忆 → 蒸馏门 → 内化成长。
 *   3. 喂料学习（感知）：喂一段文字/转写，LLM 老师解读 → 蒸馏门 → 沉淀为记忆。
 *
 * LLM 的输出**永不直接回给用户**——都经蒸馏门变成人格的记忆/价值观，聊天时人格再从这些确定性
 * 知识里检索作答。
 */

import { useEffect, useState, type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getLlmSettings, putLlmSettings, resetLlmSettings, reflect, perceive,
  type LlmProvider, type PerceiveModality, PERCEIVE_MAX_LEN,
} from '@/companion/learning-data';
import { ApiNotConfiguredError, ApiHttpError } from '@/bridge/http-client';

function readableError(err: unknown): string {
  if (err instanceof ApiNotConfiguredError) return '本地引擎尚未就绪，请稍候再试。';
  if (err instanceof ApiHttpError) {
    if (err.status === 403) return '当前账号无法使用（面向个人版）。';
    if (err.status === 429) return '有点频繁，歇一下再试。';
    return `操作失败（HTTP ${err.status}）。`;
  }
  return err instanceof Error ? err.message : '操作失败';
}

const PROVIDERS: readonly { value: LlmProvider; label: string; hint: string }[] = [
  { value: 'openai', label: 'OpenAI', hint: '官方 API key（BYOK），或填自定义端点接兼容网关/订阅代理' },
  { value: 'anthropic', label: 'Anthropic', hint: '官方 API key（BYOK），或自定义端点' },
  { value: 'ollama', label: 'Ollama（本机）', hint: '本机开源模型，零 key 零订阅；端点默认 http://127.0.0.1:11434' },
];

function LlmTeacherSection(): JSX.Element {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['companion', 'llm-settings'], queryFn: getLlmSettings });

  const [provider, setProvider] = useState<LlmProvider>('ollama');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  /* 载入已存配置到表单（provider 非法值回退 ollama）。 */
  useEffect(() => {
    const d = settings.data;
    if (!d) return;
    const p = (['openai', 'anthropic', 'ollama'] as const).includes(d.activeProvider as LlmProvider)
      ? (d.activeProvider as LlmProvider) : 'ollama';
    setProvider(p);
    setBaseUrl(d.baseUrl ?? '');
    setModel(d.model ?? '');
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => putLlmSettings({
      provider,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      /* apiKey 留空 → 省略（不动既有 key）；填了 → 存。 */
      ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
    }),
    onSuccess: async () => {
      setApiKey('');
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ['companion', 'llm-settings'] });
    },
  });

  const reset = useMutation({
    mutationFn: resetLlmSettings,
    onSuccess: async () => { setSaved(false); await qc.invalidateQueries({ queryKey: ['companion', 'llm-settings'] }); },
  });

  /* 显式撤销已存 key（apiKey=''）——保留 provider/端点偏好，只删 key（Codex 复审：需明确撤销入口，
   * 「切 ollama/恢复默认」不等价于删库里的旧 key）。 */
  const revokeKey = useMutation({
    mutationFn: () => putLlmSettings({ provider, baseUrl: baseUrl.trim(), model: model.trim(), apiKey: '' }),
    onSuccess: async () => { setApiKey(''); await qc.invalidateQueries({ queryKey: ['companion', 'llm-settings'] }); },
  });

  const canStoreKey = settings.data?.canStoreApiKey ?? false;
  const hasKey = settings.data?.hasApiKey ?? false;
  const hint = PROVIDERS.find((p) => p.value === provider)?.hint ?? '';

  return (
    <section className="space-y-3 rounded-2xl border border-chrono-border bg-chrono-elevated p-6">
      <h2 className="text-lg font-semibold text-chrono-text-primary">接一个 LLM 老师</h2>
      <p className="text-sm text-chrono-text-secondary">
        老师只在**学习/成长**时用（反思、消化材料）；跟数字人聊天永远是零-LLM 的确定性回应。
      </p>

      <div className="space-y-3">
        <label className="block text-xs font-medium text-chrono-text-secondary">
          老师来源
          <select
            value={provider}
            onChange={(e) => { setProvider(e.target.value as LlmProvider); setSaved(false); }}
            className="mt-1 w-full rounded-lg border border-chrono-border bg-chrono-surface px-3 py-2 text-sm text-chrono-text-primary"
          >
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        <p className="text-xs text-chrono-text-muted">{hint}</p>

        <label className="block text-xs font-medium text-chrono-text-secondary">
          自定义端点 baseURL（可选——接兼容网关/订阅代理/本机 ollama）
          <input
            type="text" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setSaved(false); }}
            placeholder={provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://your-gateway.example.com/v1'}
            className="mt-1 w-full rounded-lg border border-chrono-border bg-chrono-surface px-3 py-2 text-sm text-chrono-text-primary placeholder:text-chrono-text-muted"
          />
        </label>

        <label className="block text-xs font-medium text-chrono-text-secondary">
          模型名（可选，留空用默认）
          <input
            type="text" value={model} onChange={(e) => { setModel(e.target.value); setSaved(false); }}
            placeholder={provider === 'ollama' ? 'llama3.1' : 'gpt-4o / claude-3-5-sonnet'}
            className="mt-1 w-full rounded-lg border border-chrono-border bg-chrono-surface px-3 py-2 text-sm text-chrono-text-primary placeholder:text-chrono-text-muted"
          />
        </label>

        {provider !== 'ollama' && (
          <label className="block text-xs font-medium text-chrono-text-secondary">
            API key（{hasKey ? '已配置——留空保持不变，或填新值覆盖' : '可选'}）
            <input
              type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setSaved(false); }}
              disabled={!canStoreKey}
              placeholder={canStoreKey ? (hasKey ? '••••（已存，留空不变）' : 'sk-…') : '本机未启用凭据加密，无法存 key'}
              className="mt-1 w-full rounded-lg border border-chrono-border bg-chrono-surface px-3 py-2 text-sm text-chrono-text-primary placeholder:text-chrono-text-muted disabled:opacity-50"
            />
          </label>
        )}
        {provider !== 'ollama' && !canStoreKey && (
          <p className="text-xs text-orange-300">
            本机未启用凭据加密——无法保存 API key。可改用 Ollama（本机零凭据），或填一个**无需鉴权**的自定义端点。
          </p>
        )}
      </div>

      {save.isError && <p role="alert" className="text-sm text-red-200">{readableError(save.error)}</p>}
      {saved && !save.isPending && <p className="text-sm text-green-300">已保存。</p>}

      <div className="flex gap-2">
        <button
          type="button" onClick={() => save.mutate()} disabled={save.isPending}
          className="rounded-lg bg-chrono-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-chrono-primary/90 disabled:opacity-50"
        >
          {save.isPending ? '保存中…' : '保存老师配置'}
        </button>
        <button
          type="button" onClick={() => reset.mutate()} disabled={reset.isPending}
          className="rounded-lg border border-chrono-border px-4 py-2 text-sm font-medium text-chrono-text-secondary transition hover:bg-chrono-surface disabled:opacity-50"
        >
          恢复默认
        </button>
        {hasKey && (
          <button
            type="button" onClick={() => revokeKey.mutate()} disabled={revokeKey.isPending}
            className="rounded-lg border border-red-500/40 px-4 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/10 disabled:opacity-50"
          >
            {revokeKey.isPending ? '撤销中…' : '撤销已存 key'}
          </button>
        )}
      </div>
      {settings.data && (
        <p className="text-xs text-chrono-text-muted">
          当前生效：{settings.data.activeProvider}
          {settings.data.baseUrl ? `（${settings.data.baseUrl}）` : ''}
          {settings.data.hasApiKey ? ' · 已配 key' : ''}
        </p>
      )}
    </section>
  );
}

function ReflectSection(): JSX.Element {
  const run = useMutation({ mutationFn: reflect });
  const r = run.data;
  return (
    <section className="space-y-3 rounded-2xl border border-chrono-border bg-chrono-elevated p-6">
      <h2 className="text-lg font-semibold text-chrono-text-primary">自主学习（反思）</h2>
      <p className="text-sm text-chrono-text-secondary">
        让数字人反思它已经学到的记忆，自己内化出成长（价值观强化 / 记忆关联 / 自我叙事）。需要先接一个 LLM 老师。
      </p>
      <button
        type="button" onClick={() => run.mutate()} disabled={run.isPending}
        className="rounded-lg bg-chrono-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-chrono-primary/90 disabled:opacity-50"
      >
        {run.isPending ? '反思中…' : '让它反思一次'}
      </button>
      {run.isError && <p role="alert" className="text-sm text-red-200">{readableError(run.error)}</p>}
      {r && (
        <p className="text-sm text-green-300">
          {r.reason === 'no_material' ? '还没有可反思的记忆——先跟它聊聊或喂点材料。'
            : r.reason === 'no_values' ? '还没有价值内核可强化。'
            : `产出 ${r.candidatesIngested} 条成长候选（自动内化 ${r.compiled ?? 0}，待审批 ${r.pending ?? 0}）。`}
        </p>
      )}
    </section>
  );
}

function FeedSection(): JSX.Element {
  const [modality, setModality] = useState<PerceiveModality>('audio');
  const [text, setText] = useState('');
  const run = useMutation({ mutationFn: () => perceive(modality, text.trim()) });
  const trimmed = text.trim();
  const canFeed = trimmed.length > 0 && trimmed.length <= PERCEIVE_MAX_LEN && !run.isPending;
  const r = run.data;
  return (
    <section className="space-y-3 rounded-2xl border border-chrono-border bg-chrono-elevated p-6">
      <h2 className="text-lg font-semibold text-chrono-text-primary">喂料学习</h2>
      <p className="text-sm text-chrono-text-secondary">
        喂一段文字/转写/描述，LLM 老师解读后**沉淀成数字人的记忆**（经蒸馏门）。之后聊天它就能据此作答。
      </p>
      <label className="block text-xs font-medium text-chrono-text-secondary">
        材料类型
        <select
          value={modality} onChange={(e) => setModality(e.target.value as PerceiveModality)}
          className="mt-1 w-full rounded-lg border border-chrono-border bg-chrono-surface px-3 py-2 text-sm text-chrono-text-primary"
        >
          <option value="audio">听到的/文字内容（转写）</option>
          <option value="video">看到的场景/图片（描述）</option>
        </select>
      </label>
      <textarea
        value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={PERCEIVE_MAX_LEN}
        placeholder="粘贴一段材料——一段笔记、一次对话转写、一段场景描述…"
        aria-label="喂料输入"
        className="w-full resize-none rounded-lg border border-chrono-border bg-chrono-surface px-3 py-2 text-sm text-chrono-text-primary placeholder:text-chrono-text-muted"
      />
      <button
        type="button" onClick={() => run.mutate()} disabled={!canFeed}
        className="rounded-lg bg-chrono-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-chrono-primary/90 disabled:opacity-50"
      >
        {run.isPending ? '消化中…' : '喂给它'}
      </button>
      {run.isError && <p role="alert" className="text-sm text-red-200">{readableError(run.error)}</p>}
      {r && (
        <div className="text-sm">
          <p className="text-green-300">
            沉淀了 {r.perceivedMemories.length} 条记忆
            {r.perceivedBy === 'teacher' ? '（真 LLM 老师解读）' : '（确定性回退——未接 LLM 老师，非真语义）'}
          </p>
          {r.perceivedMemories.length > 0 && (
            <ul className="mt-2 space-y-1">
              {r.perceivedMemories.map((m) => (
                <li key={m.id} className="rounded-lg border border-chrono-border bg-chrono-surface p-2 text-chrono-text-primary">
                  {m.content}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function CompanionLearningPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-chrono-border bg-chrono-elevated p-6">
        <p className="text-sm text-chrono-text-muted">学习</p>
        <h1 className="mt-1 text-2xl font-bold text-chrono-text-primary">教你的数字人成长</h1>
        <p className="mt-2 text-sm text-chrono-text-secondary">
          接一个 LLM 老师，让数字人反思已学、消化你喂的材料——学到的都会蒸馏进它的确定性内核。
          聊天时它只从这些学过的知识作答，永远零-LLM。
        </p>
      </header>
      <LlmTeacherSection />
      <ReflectSection />
      <FeedSection />
    </div>
  );
}
