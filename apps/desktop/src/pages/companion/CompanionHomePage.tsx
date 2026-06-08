/**
 * ChronoCompanion ·「我的数字人」主页 (ADR-0046 Phase 2.4a)。
 *
 * 渲染**本地** SQLCipher 数据（离线可用）：主 persona（display_name + growth_index）+ 最近记忆。
 * 与企业版 PersonaListPage 不同——这里只关心「我和我的数字人」，不暴露 reputation/wallet/visibility
 * 等治理字段。映射尽量薄，复杂语义（如成长方向）交给 /growth。
 */

import { useQuery } from '@tanstack/react-query';
import { queryMemories, queryPersonas, type PersonaRow } from '@/bridge/tauri-commands';

/** 最近记忆默认条数。 */
const RECENT_MEMORIES_LIMIT = 8;

/** 选「主」persona：取 growth_index 最高的一个（数字人成长程度最高 = 最主要的陪伴对象）。 */
function pickPrimaryPersona(rows: readonly PersonaRow[]): PersonaRow | null {
  return rows.reduce<PersonaRow | null>(
    (best, row) => (best === null || row.growth_index > best.growth_index ? row : best),
    null,
  );
}

function formatTimestamp(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function CompanionHomePage() {
  const personas = useQuery({ queryKey: ['companion', 'home', 'personas'], queryFn: queryPersonas });
  const primary = pickPrimaryPersona(personas.data ?? []);

  /* 记忆查询依赖主 persona——选出来之后才查（enabled 门控避免无 persona 时空查）。 */
  const memories = useQuery({
    queryKey: ['companion', 'home', 'memories', primary?.persona_id ?? null],
    queryFn: () => queryMemories(primary?.persona_id, RECENT_MEMORIES_LIMIT),
    enabled: primary !== null,
  });

  if (personas.isLoading) {
    return (
      <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-4 text-sm">加载中…</div>
    );
  }

  if (personas.isError) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"
      >
        读取本地数据失败：{personas.error instanceof Error ? personas.error.message : '未知错误'}
      </div>
    );
  }

  if (!primary) {
    return (
      <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-6 text-center text-sm text-chrono-text-muted">
        <p className="text-base text-chrono-text-primary">还没有数字人 🌱</p>
        <p className="mt-2">等第一次同步完成，你的数字人就会出现在这里。</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-chrono-border bg-chrono-elevated p-6">
        <p className="text-sm text-chrono-text-muted">我的数字人</p>
        <h1 className="mt-1 text-3xl font-bold text-chrono-text-primary">{primary.display_name}</h1>
        <div className="mt-3 flex items-center gap-2 text-sm text-chrono-text-secondary">
          <span>成长度</span>
          <span
            aria-label={`成长度 ${(primary.growth_index * 100).toFixed(0)}%`}
            className="h-2 w-40 overflow-hidden rounded-full bg-chrono-border"
          >
            <span
              className="block h-full rounded-full bg-chrono-primary"
              style={{ width: `${Math.round(Math.min(1, Math.max(0, primary.growth_index)) * 100)}%` }}
            />
          </span>
          <span className="tabular-nums">{(primary.growth_index * 100).toFixed(0)}%</span>
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-chrono-text-primary">最近的记忆</h2>
        {memories.isLoading && <p className="text-sm text-chrono-text-muted">加载中…</p>}
        {memories.isError && (
          <p role="alert" className="text-sm text-red-200">
            读取记忆失败：{memories.error instanceof Error ? memories.error.message : '未知错误'}
          </p>
        )}
        {memories.data && memories.data.length === 0 && (
          <p className="text-sm text-chrono-text-muted">还没有记忆。和你的数字人多聊聊吧。</p>
        )}
        {memories.data && memories.data.length > 0 && (
          <ul className="space-y-2">
            {memories.data.map((m) => (
              <li key={m.id} className="rounded-xl border border-chrono-border bg-chrono-elevated p-3">
                <p className="text-sm text-chrono-text-primary">{m.content}</p>
                <p className="mt-1 text-xs text-chrono-text-muted">{formatTimestamp(m.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
