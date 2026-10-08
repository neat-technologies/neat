import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The shared NEAT_HOME sandbox (#1308). Nothing here touches the registry
    // today; wiring it everywhere is what keeps that true when something does.
    setupFiles: ['../../vitest.setup.ts'],
  },
})
