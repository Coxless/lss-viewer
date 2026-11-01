import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative paths, so the site works under a GitHub Pages project subpath.
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { include: ['test/**/*.test.ts'] },
});
