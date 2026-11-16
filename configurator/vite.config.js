import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// GLBs are served from ./public, e.g. /Window_V3_cfg.glb.
// Override with GLB_DIR=<folder> to serve test files from elsewhere.
export default defineConfig({
  plugins: [vue()],
  publicDir: process.env.GLB_DIR || 'public',
});
