import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['core/test/**/*.test.ts', 'server/test/**/*.test.ts', 'tests/**/*.test.ts', 'examples/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
