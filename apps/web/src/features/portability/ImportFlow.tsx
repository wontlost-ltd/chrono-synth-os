import { useRef, useState, type ChangeEvent } from 'react';
import { useImportFlow } from '../../hooks/usePortability';

export function ImportFlow() {
  const { state, validate, confirmCommit, reset } = useImportFlow();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tokenInput, setTokenInput] = useState('');

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        void validate(reader.result);
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="rounded-xl border border-border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-text-primary">Import Data</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Restore from a previously exported portable pack.
      </p>

      <div className="mt-4">
        {state.phase === 'idle' && (
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".json"
              className="sr-only"
              onChange={handleFileChange}
              aria-label="Select export pack file"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-elevated"
            >
              Select Export Pack
            </button>
          </div>
        )}

        {state.phase === 'validating' && (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Spinner /> Validating pack…
          </div>
        )}

        {state.phase === 'review' && state.report && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-border bg-surface-elevated p-4 text-sm">
              <p className="font-medium text-text-primary">Validation Report</p>
              <ul className="mt-2 space-y-1 text-text-secondary">
                <li>Entities to import: <span className="font-semibold">{state.report.entityCount}</span></li>
                <li>
                  Conflicts:{' '}
                  <span className={state.report.conflicts.length > 0 ? 'font-semibold text-warning' : 'font-semibold'}>
                    {state.report.conflicts.length}
                  </span>
                </li>
              </ul>
              {state.report.warnings.length > 0 && (
                <ul className="mt-2 list-disc list-inside text-warning text-xs">
                  {state.report.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
              {state.report.conflicts.length > 0 && (
                <ul className="mt-2 list-disc list-inside text-warning text-xs">
                  {state.report.conflicts.map((c) => (
                    <li key={c.entityRef}>{c.entityRef}: {c.reason}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="import-token" className="text-sm font-medium text-text-primary">
                Import Token
                <span className="ml-1 text-xs text-text-secondary">(provided by your admin)</span>
              </label>
              <input
                id="import-token"
                type="password"
                autoComplete="off"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="one-time import token"
                className="rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={!tokenInput.trim() || !state.report.valid}
                onClick={() => void confirmCommit(tokenInput.trim())}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-active disabled:cursor-not-allowed disabled:opacity-50"
              >
                Confirm Import
              </button>
              <button
                type="button"
                onClick={() => { reset(); setTokenInput(''); }}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-elevated"
              >
                Cancel
              </button>
            </div>

            {!state.report.valid && (
              <p className="text-xs text-error">Pack validation failed — import not available.</p>
            )}
          </div>
        )}

        {state.phase === 'committing' && (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Spinner /> Importing data…
          </div>
        )}

        {state.phase === 'done' && state.result && (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-success">✓ Import complete</p>
            <ul className="text-sm text-text-secondary space-y-1">
              <li>Imported: <span className="font-semibold">{state.result.importedCount}</span></li>
              <li>Skipped: <span className="font-semibold">{state.result.skippedCount}</span></li>
            </ul>
            <button
              type="button"
              onClick={() => { reset(); setTokenInput(''); }}
              className="w-fit rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-elevated"
            >
              Done
            </button>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-error">
              {state.errorMessage ?? 'An error occurred.'}
            </p>
            <button
              type="button"
              onClick={() => { reset(); setTokenInput(''); }}
              className="w-fit rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-elevated"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-text-secondary"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
