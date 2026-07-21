import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { OTEL_INIT_CJS, OTEL_INIT_ESM, renderNodeOtelInit } from '../src/installers/templates.js'

// #820 — instrumentation is ambient and must never break the host app. When the
// @opentelemetry packages aren't installed — a package-manager install that
// failed (e.g. an unparseable yarn.lock) or simply hasn't run yet — the
// generated CJS otel-init must degrade to running WITHOUT OBSERVED rather than
// crashing the process on a missing module. Before the fix, `neat <path>` on a
// repo whose instrumentation install failed left the app unbootable:
// `Error: Cannot find module '@opentelemetry/sdk-node'` thrown from the top of
// the generated file, which index.js requires on its first line.
describe('#820 — generated otel-init survives missing @opentelemetry deps', () => {
  it('warns and exits cleanly instead of throwing "Cannot find module"', () => {
    const rendered = renderNodeOtelInit(OTEL_INIT_CJS, 'svc-under-test', 'proj', [])
    // The SDK require is still present — this is the exact line that used to
    // take the host process down when the dep was absent.
    expect(rendered).toContain("require('@opentelemetry/sdk-node')")

    // A temp dir under the OS tmpdir (outside the worktree's node_modules tree)
    // so `@opentelemetry/*` is genuinely unresolvable — the failed-install state.
    const dir = mkdtempSync(join(tmpdir(), 'neat-otel-820-'))
    const file = join(dir, 'otel-init.cjs')
    writeFileSync(file, rendered)

    const res = spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8' })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`

    // The host process must NOT crash on the missing module.
    expect(res.status).toBe(0)
    expect(out).not.toMatch(/Cannot find module|MODULE_NOT_FOUND/)
    // And it must say so clearly, so the operator knows OBSERVED is off and why.
    expect(out).toMatch(/OpenTelemetry is not active|without OBSERVED/)
  })

  it('does the same for the ESM flavor instead of failing during static import linking', () => {
    const rendered = renderNodeOtelInit(OTEL_INIT_ESM, 'esm-svc-under-test', 'proj', [])
    expect(rendered).toContain("await import('@opentelemetry/sdk-node')")

    const dir = mkdtempSync(join(tmpdir(), 'neat-otel-830-'))
    const file = join(dir, 'otel-init.mjs')
    writeFileSync(file, rendered)

    const res = spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8' })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`

    expect(res.status).toBe(0)
    expect(out).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find package/)
    expect(out).toMatch(/OpenTelemetry is not active|without OBSERVED/)
  })
})
