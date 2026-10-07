import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// GitHub Pages serves a project site under /<repo>/; override with BIMGO_BASE for other hosts (e.g. the add-in fallback)
export default defineConfig({
  base: process.env.BIMGO_BASE ?? '/BimGo/',
  define: {
    __BIMGO_VERSION__: JSON.stringify(pkg.version)
  },
  server: {
    // Dev only: lets ?model=/BimGo/@fs/<path> open the local test models kept outside the repo (../../test-models)
    fs: { allow: ['.', '../../test-models'] }
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
});
