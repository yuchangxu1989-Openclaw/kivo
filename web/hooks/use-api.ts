import useSWR, { type SWRConfiguration } from 'swr';
import { apiFetch } from '@/lib/client-api';

export function useApi<T>(url: string | null, config?: SWRConfiguration<T, Error>) {
  return useSWR<T, Error>(url, (resource: string) => apiFetch<T>(resource), {
    revalidateOnFocus: false,
    ...config,
  });
}
