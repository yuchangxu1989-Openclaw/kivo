import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    exclude: ['web/**', 'node_modules/**', 'dist/**'],
  },
});
