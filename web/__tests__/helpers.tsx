import { vi } from 'vitest';

export function mockUseApi<T>(data: T, meta?: Record<string, unknown>) {
  return {
    data: { data, meta },
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
    isValidating: false,
  };
}

export function mockUseApiLoading() {
  return {
    data: undefined,
    isLoading: true,
    error: undefined,
    mutate: vi.fn(),
    isValidating: false,
  };
}

export function mockUseApiError(message = 'Network error') {
  return {
    data: undefined,
    isLoading: false,
    error: new Error(message),
    mutate: vi.fn(),
    isValidating: false,
  };
}
