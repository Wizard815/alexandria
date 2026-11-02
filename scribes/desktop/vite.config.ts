import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
  },
  resolve: {
    alias: {
      '@alexandria/schema': '/home/codebox/workspace/alexandria/packages/schema/src',
      '@alexandria/client': '/home/codebox/workspace/alexandria/packages/client/src',
    },
  },
  base: './',
});
