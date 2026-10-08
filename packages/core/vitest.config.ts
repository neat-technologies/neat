import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Runs before any module loads, so no test can resolve the real ~/.neat.
    // Shared with every other package from the repo root (#1308) — see
    // ../../vitest.setup.ts. This is the guard, not a convenience.
    setupFiles: ['../../vitest.setup.ts'],
  },
})
