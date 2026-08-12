import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Per-file environment is set with a docblock comment at the top of each
    // test file. The server package MUST run in `node` so its browser-guard is
    // exercised honestly; the embed package needs `jsdom`.
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'examples/**/*.test.ts'],
  },
})
