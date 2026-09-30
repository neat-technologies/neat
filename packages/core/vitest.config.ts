import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Runs before any module loads, so no test can resolve the real ~/.neat.
    // See test/setup-neat-home.ts — this is the guard, not a convenience.
    setupFiles: ['./test/setup-neat-home.ts'],
  },
})
