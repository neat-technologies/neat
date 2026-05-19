#!/usr/bin/env node
/**
 * `neatd` — distribution-layer daemon CLI (ADR-049).
 *
 * Subcommands:
 *   neatd start [--foreground]    boot the daemon and watch the registry
 *   neatd stop                    signal the running daemon to shut down
 *   neatd reload                  signal the running daemon to re-read the registry
 *   neatd status                  print PID + per-project last-seen timestamps
 *
 * MVP runs in foreground only. Backgrounding is the supervisor's job
 * (launchd / systemd / nohup) — `neatd start` blocks until SIGINT/SIGTERM.
 *
 * v0.2.10: also brings up the web UI on port 6328 by default (ADR-059).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { startDaemon } from './daemon.js'
import { BindAuthorityError } from './auth.js'
import { listProjects, registryPath } from './registry.js'
import { spawnWebUI, DEFAULT_WEB_PORT, type WebHandle } from './web-spawn.js'
import { checkVersionSkew } from './version-skew.js'

// Resolve the running @neat.is/core version from the bundled package.json.
// Lockstep publishing (ADR-052) keeps this in step with the `neat.is` meta
// package, which is what the operator installs globally. Tests stub by
// setting NEAT_LOCAL_VERSION.
function localVersion(): string {
  if (process.env.NEAT_LOCAL_VERSION && process.env.NEAT_LOCAL_VERSION.length > 0) {
    return process.env.NEAT_LOCAL_VERSION
  }
  try {
    const req = createRequire(import.meta.url)
    const pkg = req('../package.json') as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function neatHome(): string {
  if (process.env.NEAT_HOME && process.env.NEAT_HOME.length > 0) {
    return path.resolve(process.env.NEAT_HOME)
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return path.join(home, '.neat')
}

async function readPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(path.join(neatHome(), 'neatd.pid'), 'utf8')
    const n = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function usage(): void {
  console.log('usage: neatd <start|stop|reload|status> [--foreground]')
}

function restPortFromEnv(): number {
  const raw = process.env.PORT
  return raw && raw.length > 0 ? Number.parseInt(raw, 10) : 8080
}

async function cmdStart(): Promise<void> {
  let handle: Awaited<ReturnType<typeof startDaemon>>
  try {
    handle = await startDaemon()
  } catch (err) {
    if (err instanceof BindAuthorityError) {
      // ADR-073 §3 — refuse to bind on a public interface without a token.
      // Clean stderr line, exit 1 — no stack trace; the operator wants the
      // single-line directive, not a Node.js Error dump.
      console.error(`neatd: ${err.message}`)
      process.exit(1)
    }
    throw err
  }
  console.log(`neatd: started, PID ${process.pid}, ${handle.slots.size} project(s)`)
  console.log(`neatd: registry at ${registryPath()}`)
  // ADR-063 — surface the bound addresses so the operator can sanity-check
  // the documented happy path without grepping startup logs.
  if (handle.restAddress) console.log(`neatd: REST  → ${handle.restAddress}`)
  if (handle.otlpAddress) console.log(`neatd: OTLP  → ${handle.otlpAddress}`)

  // Version-skew advisory — non-fatal, fail-open. Surfaces the gap when the
  // operator's globally installed `neat.is` binary lags the published
  // version. Set NEAT_DISABLE_VERSION_CHECK=1 to silence the check (e.g. in
  // air-gapped environments).
  if (process.env.NEAT_DISABLE_VERSION_CHECK !== '1') {
    void checkVersionSkew({ localVersion: localVersion() }).catch(() => {
      // Fail-open: any thrown error from the helper resolves silently. The
      // helper already catches its own internals; this catches anything
      // exotic the Promise chain bubbles up.
    })
  }

  // ADR-059 — bring up the web UI alongside the daemon. Failure here aborts
  // start with the clear-error pattern from ADR-049 instead of silently
  // running headless.
  const skipWeb = process.env.NEAT_WEB_DISABLED === '1'
  let web: WebHandle | null = null
  if (!skipWeb) {
    try {
      web = await spawnWebUI(restPortFromEnv())
    } catch (err) {
      console.error((err as Error).message)
      await handle.stop().catch(() => {})
      process.exit(3)
    }
  } else {
    console.log('neatd: web UI disabled (NEAT_WEB_DISABLED=1)')
  }

  console.log('neatd: SIGHUP reloads, SIGTERM/SIGINT stops')

  let stopping = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    console.log(`neatd: ${signal} received, stopping…`)
    void Promise.allSettled([handle.stop(), web ? web.stop() : Promise.resolve()])
      .catch((err) => console.error(`neatd: shutdown error — ${(err as Error).message}`))
      .finally(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Block forever — supervisors keep us in the foreground.
  await new Promise<void>(() => {})
}

async function cmdStop(): Promise<void> {
  const pid = await readPid()
  if (pid === null) {
    console.error('neatd: no running daemon found (no PID file)')
    process.exit(1)
  }
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`neatd: SIGTERM sent to PID ${pid}`)
  } catch (err) {
    console.error(`neatd: failed to signal PID ${pid} — ${(err as Error).message}`)
    process.exit(1)
  }
}

async function cmdReload(): Promise<void> {
  const pid = await readPid()
  if (pid === null) {
    console.error('neatd: no running daemon found (no PID file)')
    process.exit(1)
  }
  try {
    process.kill(pid, 'SIGHUP')
    console.log(`neatd: SIGHUP sent to PID ${pid}`)
  } catch (err) {
    console.error(`neatd: failed to signal PID ${pid} — ${(err as Error).message}`)
    process.exit(1)
  }
}

async function cmdStatus(): Promise<void> {
  const pid = await readPid()
  console.log(`pid:      ${pid ?? '(not running)'}`)
  console.log(`registry: ${registryPath()}`)
  const webPort = process.env.NEAT_WEB_PORT
    ? Number.parseInt(process.env.NEAT_WEB_PORT, 10)
    : DEFAULT_WEB_PORT
  console.log(`web ui:   http://localhost:${webPort}`)
  const projects = await listProjects().catch(() => [])
  if (projects.length === 0) {
    console.log('projects: (none)')
    return
  }
  console.log('projects:')
  for (const p of projects) {
    const seen = p.lastSeenAt ?? 'never'
    console.log(`  ${p.name}\t${p.status}\t${p.path}\tlast-seen=${seen}`)
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage()
    process.exit(cmd ? 0 : 2)
  }

  if (cmd === 'start') return cmdStart()
  if (cmd === 'stop') return cmdStop()
  if (cmd === 'reload') return cmdReload()
  if (cmd === 'status') return cmdStatus()

  console.error(`neatd: unknown command "${cmd}"`)
  usage()
  process.exit(1)
}

const entry = process.argv[1] ?? ''
if (/[\\/]neatd\.(?:cjs|js)$/.test(entry) || entry.endsWith('/neatd')) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
