import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

export function TitleBar() {
  return (
    <header className="relative flex h-11 shrink-0 items-center justify-center border-b border-chrono-border bg-chrono-surface px-4">
      <div className="absolute left-3 z-10 flex items-center gap-2">
        <button
          type="button"
          aria-label="Close window"
          onClick={() => void appWindow.close()}
          className="h-3.5 w-3.5 rounded-full bg-red-500 transition hover:brightness-110"
        />
        <button
          type="button"
          aria-label="Minimize window"
          onClick={() => void appWindow.minimize()}
          className="h-3.5 w-3.5 rounded-full bg-yellow-400 transition hover:brightness-110"
        />
        <button
          type="button"
          aria-label="Maximize window"
          onClick={() => void appWindow.toggleMaximize()}
          className="h-3.5 w-3.5 rounded-full bg-green-500 transition hover:brightness-110"
        />
      </div>

      <div
        data-tauri-drag-region
        className="absolute inset-0 flex items-center justify-center"
        aria-hidden="true"
      />

      <div className="pointer-events-none relative flex items-center gap-2">
        <span className="h-4 w-4 rounded-full bg-chrono-primary shadow-sm shadow-chrono-primary/40" />
        <span className="text-sm font-semibold text-chrono-text-primary">ChronoSynth</span>
      </div>
    </header>
  );
}
