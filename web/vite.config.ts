import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // npm run web:dev talks to a local live-test service (npm run service) through this proxy.
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
});
