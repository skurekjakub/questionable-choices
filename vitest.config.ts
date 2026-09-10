import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.tsx` reaches only the component suites under `test/web`. They opt into a
    // DOM with a `@vitest-environment jsdom` docblock of their own, so every
    // other file keeps the node environment this default names.
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
