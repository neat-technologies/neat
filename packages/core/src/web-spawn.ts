/**
 * Web UI spawn helper (ADR-059, ADR-096).
 *
 * A project's daemon brings up the REST API + OTel receivers, then calls
 * `spawnWebUI(restPort)` to make its dashboard reachable. Lifecycle is
 * parent-tied: SIGTERM/SIGINT on the daemon cascades to the web child via
 * `stop()`.
 *
 * Per-project ports (ADR-096 §5). The dashboard binds its own port and points
 * at its own REST API, both read from the project's
 * `<projectRoot>/neat-out/daemon.json` — the single source of truth for "where
 * is this project's daemon" (project-daemon contract §2). The `restPort`
 * argument is tolerated as a fallback so callers that still pass it keep
 * working, but `daemon.json` wins when present. A missing or malformed
 * `daemon.json` falls back to the canonical `6328`/`8080`; the read never
 * throws.
 *
 * Lazy spawn (ADR-096 §7). The web port is bound up front by a thin listener,
 * but the heavyweight Next.js server is not started until someone actually
 * opens the dashboard. A daemon that nobody is looking at keeps no web process
 * resident — this matters once there's one daemon per project and the cost
 * would otherwise multiply by N.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export const DEFAULT_WEB_PORT = 6328
export const DEFAULT_REST_PORT = 8080

export interface WebHandle {
  /** The Next.js child once it's been lazily spawned; null until first open. */
  readonly child: ChildProcess | null
  port: number
  /** True once the underlying Next.js server has actually been spawned. */
  started: () => boolean
  stop: () => Promise<void>
}

// The slice of daemon.json we read. Other fields exist (pid, status, …) but the
// web UI only needs the ports, so we narrow to those and tolerate the rest.
interface DaemonPortsShape {
  rest?: unknown
  web?: unknown
}
interface DaemonRecordShape {
  ports?: DaemonPortsShape
}

function asValidPort(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/**
 * Resolve the project root whose `neat-out/daemon.json` describes this
 * daemon. `NEAT_SCAN_PATH` is the canonical project-root env (the REST server
 * reads the same name); `process.cwd()` is the fallback for a daemon launched
 * from inside the project.
 */
function projectRoot(): string {
  const fromEnv = process.env.NEAT_SCAN_PATH
  return path.resolve(fromEnv && fromEnv.length > 0 ? fromEnv : process.cwd())
}

/**
 * Read `<projectRoot>/neat-out/daemon.json` and pull out the web + REST ports.
 * Bulletproof: a missing file, unreadable file, bad JSON, or a malformed port
 * all resolve to `null` for that field — never a throw. Authoritative when
 * present (project-daemon contract §2), so its ports take precedence over the
 * `restPort` argument and over `NEAT_WEB_PORT`.
 */
export async function readDaemonPorts(
  root: string,
): Promise<{ web: number | null; rest: number | null }> {
  try {
    const raw = await fsp.readFile(path.join(root, 'neat-out', 'daemon.json'), 'utf8')
    const parsed = JSON.parse(raw) as DaemonRecordShape
    const ports = parsed?.ports ?? {}
    return { web: asValidPort(ports.web), rest: asValidPort(ports.rest) }
  } catch {
    return { web: null, rest: null }
  }
}

/**
 * Pure port resolution, factored out so it's testable without binding a
 * socket. `daemon.json` is the source of truth (ADR-096 §2); `NEAT_WEB_PORT`
 * and the `restPort` argument are fallbacks for installs predating the file.
 */
export function resolveWebPorts(args: {
  daemonWeb: number | null
  daemonRest: number | null
  webPortEnv: string | undefined
  apiUrlEnv: string | undefined
  restPortArg: number
}): { webPort: number; apiUrl: string } {
  const { daemonWeb, daemonRest, webPortEnv, apiUrlEnv, restPortArg } = args

  const portFromEnv = webPortEnv && webPortEnv.length > 0 ? Number.parseInt(webPortEnv, 10) : null
  if (portFromEnv !== null && (!Number.isFinite(portFromEnv) || portFromEnv <= 0 || portFromEnv > 65535)) {
    throw new Error(`neatd: invalid NEAT_WEB_PORT="${webPortEnv}"`)
  }
  const webPort = daemonWeb ?? portFromEnv ?? DEFAULT_WEB_PORT

  const restPort = daemonRest ?? asValidPort(restPortArg) ?? DEFAULT_REST_PORT
  const apiUrl = apiUrlEnv ?? `http://localhost:${restPort}`

  return { webPort, apiUrl }
}

/**
 * Best-effort port collision check before binding. Binds, closes, returns. A
 * race between the check and the real bind is acceptable — the placeholder's
 * own `listen` will then fail loudly and the parent exits.
 */
async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tester = net.createServer()
    tester.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `neatd: web UI port ${port} in use; set NEAT_WEB_PORT to override or stop the conflicting process`,
          ),
        )
      } else {
        reject(err)
      }
    })
    tester.once('listening', () => {
      tester.close(() => resolve())
    })
    tester.listen(port, '127.0.0.1')
  })
}

/**
 * Resolve the web package directory. In a global install
 * (`npm install -g neat.is`) the package lives at
 * `node_modules/@neat.is/web/`; in the monorepo it's `packages/web/`.
 * `require.resolve` finds whichever one Node has on its search path.
 */
function resolveWebPackageDir(): string {
  const req = (typeof require !== 'undefined'
    ? require
    : // ESM fallback — daemon CJS bundle has `require`, but typecheck wants this
      (eval('require') as NodeRequire))
  const pkgJsonPath = req.resolve('@neat.is/web/package.json')
  return path.dirname(pkgJsonPath)
}

/**
 * Locate the standalone server.js inside the web package. ADR-064 #2 — the
 * tarball ships `.next/standalone/packages/web/server.js` (path preserved
 * relative to the monorepo tracing root). Missing means the package was
 * published without `next build` having run, which the smoke-test gate
 * catches at publish time.
 */
function resolveStandaloneServerEntry(webDir: string): string {
  return path.join(webDir, '.next/standalone/packages/web/server.js')
}

// Find a free loopback port for the lazily-spawned Next server to listen on,
// behind the public web port. `listen(0)` lets the OS pick.
async function pickInternalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('neatd: could not pick an internal web port')))
      }
    })
  })
}

/**
 * Test-only seams. Production callers pass `spawnWebUI(restPort)` untouched —
 * the orchestrator's call signature is unchanged (ADR-096 scope). Tests inject
 * an alternate server entry (a throwaway script) so they can exercise the lazy
 * spawn and the proxy handoff without a real Next build on disk.
 */
export interface SpawnWebUIOptions {
  serverEntry?: string
  skipBuildCheck?: boolean
}

export async function spawnWebUI(
  restPort: number,
  opts: SpawnWebUIOptions = {},
): Promise<WebHandle> {
  const root = projectRoot()
  const fromDaemon = await readDaemonPorts(root)

  // daemon.json is authoritative; NEAT_WEB_PORT / NEAT_API_URL / the restPort
  // argument are fallbacks for installs predating per-project daemon.json.
  const { webPort: port, apiUrl } = resolveWebPorts({
    daemonWeb: fromDaemon.web,
    daemonRest: fromDaemon.rest,
    webPortEnv: process.env.NEAT_WEB_PORT,
    apiUrlEnv: process.env.NEAT_API_URL,
    restPortArg: restPort,
  })

  await assertPortFree(port)

  const serverEntry =
    opts.serverEntry ?? resolveStandaloneServerEntry(resolveWebPackageDir())
  // ADR-064 — fail loudly if the standalone build is missing. v0.3.0 shipped
  // without it; the symptom on the user side was `next start` aborting with
  // `Could not find a production build in the '.next' directory`. We check at
  // bind time, before anyone opens the dashboard, so the operator learns about
  // a broken install at start rather than on first visit.
  if (!opts.skipBuildCheck) {
    try {
      require.resolve(serverEntry)
    } catch {
      throw new Error(
        `neatd: web UI standalone build missing at ${serverEntry}. ` +
          `The published @neat.is/web tarball should include it; if you're running from a ` +
          `monorepo checkout, run \`npm run build --workspace @neat.is/web\` first, or set ` +
          `NEAT_WEB_DISABLED=1 to skip the web UI.`,
      )
    }
  }

  let child: ChildProcess | null = null
  let internalPort = 0
  let starting: Promise<void> | null = null
  let stopped = false

  // ADR-096 §7 — bring up the real Next server the first time the dashboard is
  // opened. Idempotent: concurrent first connections share one spawn.
  function ensureStarted(): Promise<void> {
    if (starting) return starting
    starting = (async () => {
      internalPort = await pickInternalPort()
      // ADR-059 #6 — the child inherits NEAT_API_URL pointing at this project's
      // REST server, unless the operator pre-configured it.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: String(internalPort),
        HOSTNAME: '127.0.0.1',
        NEAT_API_URL: apiUrl,
      }
      // The standalone bundle is self-contained — its own `node_modules` and
      // `package.json` sit alongside `server.js`. Spawn `node` against it
      // directly; no `next start` (which needs the source tree + build cache)
      // and no `npm exec` (which is monorepo-only in practice).
      // `detached: false` keeps the child in our process group so signals reach it.
      child = spawn(process.execPath, [serverEntry], {
        cwd: path.dirname(serverEntry),
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: false,
      })
      child.on('error', (err) => {
        console.error(`neatd: web UI spawn error — ${err.message}`)
      })
      await waitForListening(internalPort)
      console.log(`neatd: web UI ready on http://localhost:${port}`)
    })()
    return starting
  }

  // The public listener on the web port. It costs nothing until visited; the
  // first connection triggers ensureStarted(), then every socket is piped
  // through to the internal Next server. A raw TCP proxy forwards SSE and any
  // other streaming response transparently.
  const front = net.createServer((socket) => {
    socket.on('error', () => socket.destroy())
    ensureStarted()
      .then(() => {
        if (stopped) {
          socket.destroy()
          return
        }
        const upstream = net.connect(internalPort, '127.0.0.1')
        upstream.on('error', () => socket.destroy())
        socket.pipe(upstream)
        upstream.pipe(socket)
        socket.on('close', () => upstream.destroy())
        upstream.on('close', () => socket.destroy())
      })
      .catch((err) => {
        console.error(`neatd: web UI failed to start — ${(err as Error).message}`)
        socket.destroy()
      })
  })

  await new Promise<void>((resolve, reject) => {
    front.once('error', reject)
    front.listen(port, '127.0.0.1', () => resolve())
  })

  console.log(`neatd: web UI listening on http://localhost:${port} (starts on first open)`)

  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    await new Promise<void>((resolve) => front.close(() => resolve()))
    if (!child || !child.pid) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    // Give the child up to 3s to exit gracefully, then SIGKILL.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child?.kill('SIGKILL')
        } catch {
          /* gone */
        }
        resolve()
      }, 3000)
      child?.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  return {
    get child() {
      return child
    },
    port,
    started: () => child !== null,
    stop,
  }
}

// Poll the internal port until the Next server accepts a connection, so the
// first proxied socket doesn't race the child's bind. Bounded so a child that
// never comes up doesn't hang the request forever.
async function waitForListening(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => {
        s.destroy()
        resolve(true)
      })
      s.once('error', () => {
        s.destroy()
        resolve(false)
      })
    })
    if (ok) return
    if (Date.now() > deadline) {
      throw new Error(`neatd: web UI did not start listening on :${port} within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}
