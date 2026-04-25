import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['data/**', 'node_modules/**'],
    server: {
      deps: {
        external: [/^node:/],
      },
    },
  },
});
