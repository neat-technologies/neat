// What `vitest` resolves to when it is run from the repo root (#1308).
//
// Vitest reads its config from the directory it is invoked in. Every package
// that runs tests has its own `vitest.config.ts`, and there was nothing at the
// root — so `npx vitest run packages/core/test/…` from the repo root, which is
// the default in an agent session or any editor rooted at the workspace, loaded
// no config at all. No `include`, and more to the point no `setupFiles`, so the
// `NEAT_HOME` sandbox never ran and the suite read and wrote the developer's
// real `~/.neat/projects.json`.
//
// That was not only a hazard to real state. It is what made the core suite look
// flaky: every registry-reading assertion (the ADR-049 watch block, ADR-231's
// sibling statuses, ADR-074's sync verb, ADR-051's `/projects` shape) was
// racing every other run on the machine, and reading whatever a previous run had
// left behind. Same tree, same commit: from the root, 9 failures across four
// runs with four different failure sets; from `packages/core`, 2980 passed and
// none. A red suite that means nothing trains everyone to re-run rather than
// read, which is #1244's complaint.
//
// Listing the projects here makes a root invocation resolve to each package's
// own config, so it behaves exactly like `turbo test` does. `turbo test` itself
// is unaffected: it runs `vitest run` with the package as cwd, and vitest looks
// for a workspace file relative to that root, not this one.
export default [
  'packages/core',
  'packages/mcp',
  'packages/web',
  'packages/types',
  'packages/vscode',
  'packages/instrumentation-registry',
]
