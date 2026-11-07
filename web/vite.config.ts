import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const librarian = process.env.LIBRARIAN_URL ?? 'http://localhost:8090';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@alx/client': fileURLToPath(new URL('../packages/client/src/AlexandriaClient.ts', import.meta.url)) } },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: Object.fromEntries(['/api', '/mcp', '/dav', '/v1', '/health'].map((p) => [p, { target: librarian, changeOrigin: false }])),
  },
  build: { outDir: 'dist', sourcemap: true },
});
