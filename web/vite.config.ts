import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const librarian = process.env.LIBRARIAN_URL ?? 'http://localhost:8090';
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@alx/client': here('../packages/client/src/AlexandriaClient.ts') } },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: Object.fromEntries(['/api', '/mcp', '/dav', '/v1', '/health'].map((p) => [p, { target: librarian, changeOrigin: false }])),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The Owlbear Rodeo extension's two pages (src/owlbear), served by the librarian at /owlbear/.
    rollupOptions: { input: { main: here('index.html'), 'owlbear-popover': here('owlbear/popover.html'), 'owlbear-background': here('owlbear/background.html') } },
  },
});
