import { useQuery } from '@tanstack/react-query';
import { getSyncState } from '@/bridge/tauri-commands';

export function useSyncState() {
  return useQuery({
    queryKey: ['syncState'],
    queryFn: getSyncState,
    refetchInterval: 2_000,
    staleTime: 1_000,
  });
}
