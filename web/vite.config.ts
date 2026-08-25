import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'react-vendor';
        },
      },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787', '/generated': 'http://127.0.0.1:8787' },
  },
});
