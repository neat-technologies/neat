import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The attachment tests spawn real node processes; give them room.
    testTimeout: 30000,
  },
})
