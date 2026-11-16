import { defineConfig, loadEnv } from 'vite';
import { siteLinks } from './src/site-links.js';

export default defineConfig(({ mode }) => {
  const origin = (loadEnv(mode, process.cwd(), 'VITE_MARKCUNE_SITE_URL').VITE_MARKCUNE_SITE_URL || '').trim();
  siteLinks(origin); // Invalid release configuration must fail at build time.
  return {
  root: 'src',
  base: './',
  clearScreen: false,
  define: { 'import.meta.env.VITE_MARKCUNE_SITE_URL': JSON.stringify(origin) },
  server: { port: 1420, strictPort: true },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 2000,
  },
  };
});
