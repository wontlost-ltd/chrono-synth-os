import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { PersonaList } from '@/components/PersonaList';
import { forceSync } from '@/bridge/tauri-commands';
import { usePersonas } from '@/hooks/usePersonas';
import { useSyncState } from '@/hooks/useSyncState';

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-chrono-border bg-chrono-elevated p-4">
      <div className="flex gap-3">
        <div className="h-11 w-11 animate-pulse rounded-full bg-chrono-border" />
        <div className="flex-1 space-y-3">
          <div className="h-4 w-2/3 animate-pulse rounded bg-chrono-border" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-chrono-border" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-chrono-border" />
        </div>
      </div>
    </div>
  );
}

export function PersonaListPage() {
  const queryClient = useQueryClient();
  const personas = usePersonas();
  const syncState = useSyncState();
  const isSyncing =
    syncState.data?.state === 'syncing' || syncState.data?.state === 'initial_sync';

  const forceSyncMutation = useMutation({
    mutationFn: forceSync,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['personas'] }),
        queryClient.invalidateQueries({ queryKey: ['syncState'] }),
      ]);
    },
  });

  function renderPersonaContent() {
    if (personas.isError) {
      return (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          Failed to load personas — database may not be open yet.
        </div>
      );
    }
    if (personas.isLoading) {
      return (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <SkeletonCard key={index} />
          ))}
        </div>
      );
    }
    return <PersonaList personas={personas.data ?? []} />;
  }

  return (
    <section>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-chrono-text-primary">
            Personas
          </h1>
          <p className="mt-1 text-sm text-chrono-text-secondary">
            Local persona identities synced with ChronoSynth OS.
          </p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => forceSyncMutation.mutate()}
            disabled={isSyncing || forceSyncMutation.isPending}
            className={clsx(
              'rounded-lg px-4 py-2 text-sm font-semibold transition',
              isSyncing || forceSyncMutation.isPending
                ? 'cursor-not-allowed bg-chrono-border text-chrono-text-secondary'
                : 'bg-chrono-primary text-white hover:bg-chrono-primary/90',
            )}
          >
            {isSyncing || forceSyncMutation.isPending ? 'Syncing…' : 'Force Sync'}
          </button>
          {forceSyncMutation.isError ? (
            <p className="text-xs text-red-300">Sync failed — check connection.</p>
          ) : null}
        </div>
      </div>

      {renderPersonaContent()}
    </section>
  );
}
