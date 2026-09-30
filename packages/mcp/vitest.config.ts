import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The MCP server resolves its graph through core, which resolves `~/.neat`
    // per call — so these tests can reach the developer's real registry exactly
    // like core's can. This package had no config at all, which meant no
    // sandbox however it was invoked (#1308).
    setupFiles: ['../../vitest.setup.ts'],
  },
})
