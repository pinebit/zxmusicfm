import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    exclude: ['dist/**', 'node_modules/**', 'tests/e2e/**'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
