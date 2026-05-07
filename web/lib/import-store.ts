import type { ImportJob } from '@/app/api/v1/imports/route';

const STORE_KEY = '__kivo_import_jobs__';

type GlobalWithStore = typeof globalThis & {
  [STORE_KEY]?: Map<string, ImportJob>;
};

export function getImportStore() {
  const scope = globalThis as GlobalWithStore;
  if (!scope[STORE_KEY]) {
    scope[STORE_KEY] = new Map<string, ImportJob>();
  }
  return scope[STORE_KEY]!;
}
