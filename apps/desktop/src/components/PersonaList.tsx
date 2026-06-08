import type { PersonaRow } from '@/bridge/tauri-commands';
import { PersonaCard } from './PersonaCard';

export function PersonaList({ personas }: { personas: PersonaRow[] }) {
  if (personas.length === 0) {
    return (
      <div className="flex min-h-[280px] items-center justify-center rounded-xl border border-dashed border-chrono-border bg-chrono-elevated/50 p-8 text-center">
        <p className="text-sm text-chrono-text-secondary">
          No personas yet — sync to get started
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
      {personas.map((persona) => (
        <PersonaCard key={persona.persona_id} persona={persona} />
      ))}
    </div>
  );
}
