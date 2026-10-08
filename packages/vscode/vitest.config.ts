import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Same shared NEAT_HOME sandbox as every other package (#1308). This one had
    // no config, so it ran with vitest's defaults wherever it was invoked from.
    setupFiles: ['../../vitest.setup.ts'],
  },
})
