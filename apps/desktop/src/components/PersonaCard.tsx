import clsx from 'clsx';
import type { PersonaRow } from '@/bridge/tauri-commands';

const statusClasses: Record<string, string> = {
  active: 'border-green-500/30 bg-green-500/10 text-green-300',
  restricted: 'border-yellow-400/30 bg-yellow-400/10 text-yellow-200',
  deceased: 'border-gray-400/30 bg-gray-400/10 text-gray-300',
};

function formatWalletBalance(balance: number | null): string | null {
  if (balance === null) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(balance);
}

export function PersonaCard({ persona }: { persona: PersonaRow }) {
  const initial = persona.display_name.trim().charAt(0).toUpperCase() || '?';
  const walletBalance = formatWalletBalance(persona.wallet_balance);

  return (
    <article className="group rounded-xl border border-chrono-border bg-chrono-elevated p-4 shadow-sm transition duration-150 hover:-translate-y-0.5 hover:border-chrono-primary/60 hover:shadow-lg hover:shadow-black/20">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-chrono-primary text-sm font-bold text-white shadow-sm">
          {initial}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-chrono-text-primary">
              {persona.display_name}
            </h3>
            <span
              className={clsx(
                'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                statusClasses[persona.status] ??
                  'border-chrono-border bg-chrono-surface text-chrono-text-secondary',
              )}
            >
              {persona.status}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-chrono-text-secondary">
            <span className="font-medium text-chrono-text-primary">
              ↑ {Math.round(persona.growth_index).toLocaleString()}
            </span>
            <span>Rep {Math.round(persona.reputation).toLocaleString()}</span>
            {walletBalance ? <span>{walletBalance}</span> : null}
          </div>

          <div className="mt-3 text-[11px] text-chrono-text-secondary">
            Updated {new Date(persona.updated_at).toLocaleString()}
          </div>
        </div>
      </div>
    </article>
  );
}
