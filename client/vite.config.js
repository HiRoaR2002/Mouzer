import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const HOST = process.env.MOUZER_HOST || 'http://localhost:7331';

export default defineConfig({
  plugins: [react()],
  // Relative base so the built bundle works regardless of the mount path the
  // host serves it from.
  base: './',
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: HOST, changeOrigin: true },
      '/ws': { target: HOST.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
  },
});
