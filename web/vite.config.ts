import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true, proxy: { '/api': api, '/auth': api, '/mcp': api, '/healthz': api } },
});
