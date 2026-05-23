import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 10000,
    exclude: ['web/**', 'node_modules/**', 'dist/**'],
  },
});
