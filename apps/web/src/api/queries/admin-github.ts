/**
 * GitHub App 连接管理 API hooks（安装入口产品化的前端接线）。
 *
 * 对应后端 src/server/routes/admin-github.ts 的三个 admin 端点。
 * **私钥只在 POST body 里上行，服务端绝不回显**——故本文件的响应类型里没有私钥字段。
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

/** 一条 installation 映射（GitHub App 装在哪个组织/账号下）。 */
export interface GithubInstallation {
  installationId: string;
  account: string | null;
  repos: string | null;
  /** 暂停时刻（毫秒 epoch）；null = 未暂停。 */
  suspendedAt: number | null;
}

/** 连接状态。**不含私钥**——服务端只返 appId/gheBaseUrl/installations。 */
export interface GithubAppStatus {
  configured: boolean;
  appId?: string;
  gheBaseUrl?: string | null;
  installations: GithubInstallation[];
}

/** 录入凭据请求体（私钥只经此上行）。 */
export interface ConnectGithubAppInput {
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
  gheBaseUrl?: string;
}

const STATUS_KEY = ['admin', 'github', 'app'] as const;

/** 查 GitHub App 连接状态（仅 admin 可调；非 admin 传 enabled=false 跳过请求）。 */
export function useGithubAppStatus(enabled = true) {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch<GithubAppStatus>('/api/v1/admin/github/app'),
    enabled,
  });
}

/** 录入 App 凭据（私钥加密落库，响应不回显）。 */
export function useConnectGithubApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ConnectGithubAppInput) =>
      apiFetch<{ appId: string; configured: boolean }>('/api/v1/admin/github/app', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: STATUS_KEY }); },
  });
}

/** 断开连接（删凭据；installation 映射由 GitHub 卸载事件清理）。 */
export function useDisconnectGithubApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ disconnected: boolean }>('/api/v1/admin/github/app', { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: STATUS_KEY }); },
  });
}
