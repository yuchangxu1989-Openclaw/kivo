export const BASE_PATH = '/kivo';

export function withBasePath(path: string) {
  if (!path) return BASE_PATH;
  return `${BASE_PATH}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? (payload as { error?: { message?: string } }).error?.message
      : undefined;
    throw new Error(message || `API error: ${response.status}`);
  }

  return payload as T;
}
