import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// The live service's security headers (configs/live-service.yaml) also apply in vite preview, so the browser tests run the
// site under the same Content-Security-Policy the public deployment sends and fail on any violation.
const live = JSON.parse(readFileSync(new URL('../configs/live-service.yaml', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  // npm run web:dev talks to a local live-test service (npm run service) through this proxy; the browser tests start their
  // own service and point the proxy at it with TRUSTBENCH_API_PROXY (vite preview uses the same proxy).
  server: { proxy: { '/api': process.env.TRUSTBENCH_API_PROXY ?? 'http://127.0.0.1:8080' } },
  preview: { headers: live.security_headers, proxy: { '/api': process.env.TRUSTBENCH_API_PROXY ?? 'http://127.0.0.1:8080' } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
});
