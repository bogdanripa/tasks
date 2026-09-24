import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  // The app lives under /app; the public site (web/site) is copied to the root of dist at build time.
  base: '/app/',
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
    // Hex hashes: pironman's static host serves names like index-1a2b3c4d.js as immutable (cached for a year).
    rollupOptions: { output: { hashCharacters: 'hex' } },
  },
  server: { port: 5180, strictPort: true, proxy: { '/api': api, '/auth': api, '/mcp': api, '/healthz': api } },
});
