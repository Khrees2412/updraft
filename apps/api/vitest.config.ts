import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['data/**', 'node_modules/**', 'dist/**'],
    server: {
      deps: {
        external: [/^node:/],
      },
    },
  },
});
