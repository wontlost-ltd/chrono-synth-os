import { useQuery } from '@tanstack/react-query';
import { queryPersonas } from '@/bridge/tauri-commands';

export function usePersonas() {
  return useQuery({
    queryKey: ['personas'],
    queryFn: queryPersonas,
    refetchInterval: 5_000,
    staleTime: 3_000,
  });
}
