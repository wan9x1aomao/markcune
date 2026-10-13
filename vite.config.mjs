import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 2000,
  },
});
