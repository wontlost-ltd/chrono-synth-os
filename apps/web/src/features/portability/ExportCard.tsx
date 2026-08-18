import { useExportFlow } from '../../hooks/usePortability';

export function ExportCard() {
  const { state, start, reset } = useExportFlow();
  /* 下载**始终**走同源 API 端点，而不是把 downloadUrl 原样渲染成 href：
   *   - 默认的本地对象存储返回的是 `file://<服务器路径>`，浏览器既取不到，
   *     还会把服务端目录结构暴露给用户；
   *   - 配了 S3 时该端点会 302 到预签名 URL，行为不变；
   *   - 同源地址无需协议白名单，也就没有伪协议注入面。
   * downloadUrl 仍用于判断「是否已有可下载产物」。 */
  /* 同时要求 exportId 与 downloadUrl 存在，收窄成非空字符串供 href 直接使用。 */
  const downloadHref = state.exportId !== null && state.downloadUrl !== null
    ? `/api/v1/privacy/export/${encodeURIComponent(state.exportId)}/download`
    : null;

  return (
    <div className="rounded-xl border border-border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-text-primary">Export Your Data</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Download a portable backup of all your personas, memories, and timeline data.
      </p>

      <div className="mt-4">
        {state.phase === 'idle' && (
          <button
            type="button"
            onClick={() => void start()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-active focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Start Export
          </button>
        )}

        {state.phase === 'starting' && (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Spinner /> Preparing export…
          </div>
        )}

        {state.phase === 'polling' && (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Spinner /> Export in progress — this may take a few minutes.
          </div>
        )}

        {state.phase === 'ready' && downloadHref && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-success font-medium">✓ Export complete</p>
            <div className="flex gap-2">
              <a
                href={downloadHref}
                download
                className="inline-flex items-center gap-1.5 rounded-lg bg-success px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Download Pack
              </a>
              <button
                type="button"
                onClick={reset}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-elevated"
              >
                New Export
              </button>
            </div>
          </div>
        )}

        {/* partial：导出完成但有数据缺失。既给下载入口，也必须把缺了什么讲清楚——
            当作 ready 会让用户误以为数据完整，当作 error 又会藏起已可用的部分。 */}
        {state.phase === 'partial' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-warning">⚠ Export completed with warnings</p>
            <ul className="list-disc pl-5 text-sm text-warning">
              {state.warnings.map((w) => (
                <li key={w.code}>{w.messageId}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              {downloadHref && (
                <a
                  href={downloadHref}
                  download
                  className="inline-flex items-center gap-1.5 rounded-lg bg-warning px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Download Partial Pack
                </a>
              )}
              <button
                type="button"
                onClick={reset}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-elevated"
              >
                New Export
              </button>
            </div>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-error">
              Export failed{state.errorMessage ? `: ${state.errorMessage}` : '.'}
            </p>
            <button
              type="button"
              onClick={reset}
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
