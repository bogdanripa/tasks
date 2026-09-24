import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  // The app lives under /app; the public site (web/site) is copied to the root of dist at build time.
  base: '/app/',
  build: { outDir: 'dist/app', emptyOutDir: true },
  server: { port: 5180, strictPort: true, proxy: { '/api': api, '/auth': api, '/mcp': api, '/healthz': api } },
});
