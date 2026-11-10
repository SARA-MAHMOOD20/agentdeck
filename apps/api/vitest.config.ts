import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC (not esbuild) so NestJS decorator metadata is emitted in tests.
export default defineConfig({
  test: { globals: true, include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'] },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
