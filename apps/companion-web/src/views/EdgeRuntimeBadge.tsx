import { useEffect, useState, type JSX } from 'react';
import { spawnPersonaWorker } from '../worker/worker-client.js';

type Status = 'checking' | 'running' | 'unsupported';

/**
 * 端侧内核徽章（ADR-0052 Local Persona Autonomy）：启动时 spawn 端侧人格 worker，跑一次自检
 * （在浏览器 Web Worker 里真的加载 kernel + 跑确定性 value 闭环）。**诚实文案**（Codex 复审）：自检
 * 跑的是临时 synthetic 闭环，**不是**加载当前用户真实 persona snapshot——故只宣称「本设备支持端侧
 * 人格内核运行」，不宣称「你的人格已端侧化」（真实 persona snapshot 端侧加载需 Edge-P3 持久化 + 下发，
 * 是后续）。Worker 不支持时静默降级（不阻塞主页）。
 */
export function EdgeRuntimeBadge(): JSX.Element | null {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    if (typeof Worker === 'undefined') { setStatus('unsupported'); return; }
    let client: ReturnType<typeof spawnPersonaWorker> | null = null;
    let cancelled = false;
    try {
      client = spawnPersonaWorker();
      /* 自检：端侧 worker 里跑一条 kernel value 闭环。 */
      void client.send({ kind: 'addValue', label: '端侧自检', weight: 0.5 })
        .then((r) => { if (!cancelled) setStatus(r.values.length >= 1 ? 'running' : 'unsupported'); })
        .catch(() => { if (!cancelled) setStatus('unsupported'); });
    } catch {
      setStatus('unsupported');
    }
    return () => { cancelled = true; client?.close(); };
  }, []);

  if (status === 'unsupported') return null;
  /* P3 试点：从手写 .edge-badge class 迁到 Tailwind utility。颜色/圆角/间距/字号均用 arbitrary value
   * 直接引 companion token（var(--c-*)）——单一事实源不复制值，工具链验证 OK。 */
  return (
    <p
      className="mb-[var(--c-space-1)] rounded-[var(--c-radius-sm)] bg-[var(--c-surface-2)] px-[var(--c-space-3)] py-[var(--c-space-2)] text-center text-[length:var(--c-text-sm)] text-[var(--c-pos)]"
      aria-live="polite"
    >
      {status === 'checking' ? '正在做端侧内核自检…' : '✓ 本设备支持端侧人格内核运行（确定性核，可离线）'}
    </p>
  );
}
