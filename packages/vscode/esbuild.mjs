// Single CommonJS bundle for the VS Code extension host.
//
// This package is the documented exception to NEAT's "every package emits ESM +
// CJS + DTS via tsup" rule (ADR-171): nothing imports an extension, the editor
// host loads one CommonJS entry. So we bundle one file with esbuild, mark
// `vscode` external (the host provides it), and emit no ESM and no types.

import esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // The host injects the `vscode` module at runtime; it must not be bundled.
  external: ['vscode'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
})
