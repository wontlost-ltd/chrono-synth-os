import { useExportFlow } from '../../hooks/usePortability';

export function ExportCard() {
  const { state, start, reset } = useExportFlow();

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Export Your Data</h2>
      <p className="mt-1 text-sm text-gray-500">
        Download a portable backup of all your personas, memories, and timeline data.
      </p>

      <div className="mt-4">
        {state.phase === 'idle' && (
          <button
            type="button"
            onClick={() => void start()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            Start Export
          </button>
        )}

        {state.phase === 'starting' && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Spinner /> Preparing export…
          </div>
        )}

        {state.phase === 'polling' && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Spinner /> Export in progress — this may take a few minutes.
          </div>
        )}

        {state.phase === 'ready' && state.downloadUrl && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-green-700 font-medium">✓ Export complete</p>
            <div className="flex gap-2">
              <a
                href={state.downloadUrl}
                download
                className="inline-flex items-center gap-1.5 rounded-lg bg-success px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Download Pack
              </a>
              <button
                type="button"
                onClick={reset}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                New Export
              </button>
            </div>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-red-600">
              Export failed{state.errorMessage ? `: ${state.errorMessage}` : '.'}
            </p>
            <button
              type="button"
              onClick={reset}
              className="w-fit rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
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
      className="h-4 w-4 animate-spin text-gray-400"
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
