import { useEffect, useState, type JSX } from 'react';
import { spawnPersonaWorker } from '../worker/worker-client.js';

type Status = 'checking' | 'running' | 'unsupported';

/**
 * 端侧内核徽章（ADR-0052 Local Persona Autonomy）：启动时 spawn 端侧人格 worker，跑一次自检
 * （在浏览器 Web Worker 里真的加载 kernel + 跑确定性 value 闭环），向用户证明「人格内核正在你的
 * 设备端侧运行」——断网无云仍可。Worker 不支持时静默降级（不阻塞主页）。
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
  return (
    <p className="edge-badge" aria-live="polite">
      {status === 'checking' ? '正在你的设备端侧启动人格内核…' : '✓ 人格内核正在你的设备端侧运行（断网也在）'}
    </p>
  );
}
