import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [
    // styled-jsx's `<style jsx>` tags are normally compiled away by Next's
    // own SWC pipeline. Vitest never runs that pipeline, so without this
    // Babel plugin the literal `jsx` prop reaches the DOM `<style>` element
    // and React warns about a non-boolean attribute (components/logo-animation.tsx).
    react({ babel: { plugins: ['styled-jsx/babel'] } }),
  ],
  resolve: {
    // Mirrors the `@/*` alias in tsconfig so client components that use
    // shadcn's import shape resolve under vitest.
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
  },
})
