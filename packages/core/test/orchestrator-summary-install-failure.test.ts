import { describe, it, expect, vi } from 'vitest'
import { printSummary, type OrchestratorResult } from '../src/orchestrator.js'
import { getGraph, resetGraph } from '../src/graph.js'

// Issue #831 — the one-command summary used to tell the operator "run your app,
// OBSERVED edges fill in" even when the dependency install had failed. When the
// `<pm> install` exits non-zero the OTel SDK never lands, so instrumentation is
// wired into the manifests but inert: nothing would fill in. The summary has to
// be honest about that and hand back the exact command to finish the install.

function baseResult(
  packageManagerInstalls: OrchestratorResult['steps']['apply']['packageManagerInstalls'],
): OrchestratorResult {
  return {
    exitCode: packageManagerInstalls?.some((i) => i.exitCode !== 0) ? 1 : 0,
    steps: {
      discovery: { services: 1, languages: ['javascript'] },
      extraction: { nodesAdded: 0, edgesAdded: 0 },
      gitignore: 'unchanged',
      apply: {
        instrumented: 1,
        alreadyInstrumented: 0,
        libOnly: 0,
        skipped: false,
        packageManagerInstalls,
      },
      daemon: 'spawned',
      browser: 'skipped',
    },
  }
}

function captureSummary(result: OrchestratorResult, daemonLog: string | null): string[] {
  const key = `test-summary-${Math.random().toString(36).slice(2)}`
  resetGraph(key)
  const graph = getGraph(key)
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    lines.push(String(msg ?? ''))
  })
  try {
    printSummary(result, graph, daemonLog)
  } finally {
    spy.mockRestore()
  }
  return lines
}

const CLEAN_LINE = 'OBSERVED edges fill in as it executes'

describe('printSummary is honest when a dependency install failed (#831)', () => {
  it('emits the "not yet active / run <pm> install" summary and omits the clean line', () => {
    const lines = captureSummary(
      baseResult([
        { pm: 'npm', cwd: '/proj/app', args: ['install'], exitCode: 1, stderr: 'boom' },
      ]),
      'neat-out/daemon.log',
    )
    const text = lines.join('\n')

    // Honest: instrumentation wired but inert until deps land.
    expect(text).toContain('NOT yet active')
    expect(text).toMatch(/OBSERVED edges will stay empty/)
    // The exact fix command, per failed install, with its cwd.
    expect(text).toContain('run `npm install` in /proj/app')

    // The clean "run your app, OBSERVED edges fill in" wording must be gone.
    expect(text).not.toContain(CLEAN_LINE)
    expect(text).not.toContain('divergences surface where code and runtime disagree')
  })

  it('lists a fix command for each failed install and uses that install\'s pm/cwd', () => {
    const lines = captureSummary(
      baseResult([
        { pm: 'npm', cwd: '/proj/api', args: ['install'], exitCode: 0, stderr: '' },
        { pm: 'pnpm', cwd: '/proj/web', args: ['install'], exitCode: 1, stderr: 'x' },
        { pm: 'yarn', cwd: '/proj/worker', args: ['install'], exitCode: 127, stderr: 'y' },
      ]),
      'neat-out/daemon.log',
    )
    const text = lines.join('\n')

    // Only the two failed installs are surfaced, each with its own pm + cwd.
    expect(text).toContain('run `pnpm install` in /proj/web')
    expect(text).toContain('run `yarn install` in /proj/worker')
    // The install that succeeded is not listed as needing a fix.
    expect(text).not.toContain('run `npm install` in /proj/api')
    expect(text).not.toContain(CLEAN_LINE)
  })

  it('keeps the clean next-step line when every install succeeded', () => {
    const lines = captureSummary(
      baseResult([
        { pm: 'npm', cwd: '/proj/app', args: ['install'], exitCode: 0, stderr: '' },
      ]),
      'neat-out/daemon.log',
    )
    const text = lines.join('\n')

    expect(text).toContain(CLEAN_LINE)
    expect(text).not.toContain('NOT yet active')
  })

  it('keeps the clean next-step line when there were no installs at all', () => {
    const lines = captureSummary(baseResult(undefined), 'neat-out/daemon.log')
    const text = lines.join('\n')

    expect(text).toContain(CLEAN_LINE)
    expect(text).not.toContain('NOT yet active')
  })

  it('surfaces the failure even when the daemon is not running (no daemon log)', () => {
    const lines = captureSummary(
      baseResult([
        { pm: 'npm', cwd: '/proj/app', args: ['install'], exitCode: 1, stderr: 'boom' },
      ]),
      null,
    )
    const text = lines.join('\n')

    expect(text).toContain('NOT yet active')
    expect(text).toContain('run `npm install` in /proj/app')
    expect(text).not.toContain(CLEAN_LINE)
  })
})

// HN clean first run — local NEAT is CLI-first, the visual dashboard is hosted.
// The summary leads with what works locally (querying the graph from a coding
// agent over MCP, or from this CLI), never advertises a local dashboard URL,
// and points GUI-seekers at hosted NEAT.
describe('printSummary leads with MCP/CLI querying, routes GUI-seekers to hosted', () => {
  it('leads the closing guidance with the MCP server and the CLI query path', () => {
    const lines = captureSummary(
      baseResult([
        { pm: 'npm', cwd: '/proj/app', args: ['install'], exitCode: 0, stderr: '' },
      ]),
      'neat-out/daemon.log',
    )
    const text = lines.join('\n')

    // The primary next step: read the graph from your coding agent over MCP,
    // or ask it straight from the CLI.
    expect(text).toContain('query the graph from your coding agent')
    expect(text).toContain('MCP server')
    expect(text).toContain('skill --apply')
    expect(text).toContain('ask "how does checkout work?"')
  })

  it('never advertises a local dashboard — no URL, no `dashboard:` line, no "open the dashboard"', () => {
    const lines = captureSummary(
      baseResult([
        { pm: 'npm', cwd: '/proj/app', args: ['install'], exitCode: 0, stderr: '' },
      ]),
      'neat-out/daemon.log',
    )
    const text = lines.join('\n')

    // The old headline (`dashboard: <url>`), the dashboard-framed auth line, and
    // the local web URL are all gone.
    expect(text).not.toContain('dashboard: ')
    expect(text).not.toContain('open the dashboard')
    expect(text).not.toMatch(/localhost:\d+/)
  })

  it('points GUI-seekers at hosted NEAT, after the local CLI/MCP lead', () => {
    const lines = captureSummary(
      baseResult([
        { pm: 'npm', cwd: '/proj/app', args: ['install'], exitCode: 0, stderr: '' },
      ]),
      'neat-out/daemon.log',
    )
    const text = lines.join('\n')

    // A visual dashboard is the hosted experience — one pointer at `neat login`.
    expect(text).toMatch(/visual dashboard.*login/)

    // And the local querying guidance leads: it comes before the hosted pointer.
    expect(text.indexOf('query the graph from your coding agent')).toBeLessThan(
      text.indexOf('visual dashboard'),
    )
  })
})
