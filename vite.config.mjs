import { defineConfig, loadEnv } from 'vite';
import { siteLinks } from './src/site-links.js';
import { readFileSync } from 'node:fs';

export default defineConfig(({ mode }) => {
  const releaseSite = readFileSync(new URL('./scripts/release.conf', import.meta.url), 'utf8').match(/^SITE_ORIGIN="([^"\r\n]*)"[ \t\r]*$/m)?.[1] || '';
  const origin = (loadEnv(mode, process.cwd(), 'VITE_MARKCUNE_SITE_URL').VITE_MARKCUNE_SITE_URL ?? releaseSite).trim();
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
