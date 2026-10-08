// The OTLP settings the source-edit otel-init used to set before the SDK
// started (installers/templates.ts — OTEL_OTLP_HEADERS_JS, OTEL_OTLP_PROTOCOL_JS,
// OTEL_ENDPOINT_RESOLVER_*). Attachment has no generated init, so the preload
// applies them itself, before NodeSDK reads the environment.
import { readFileSync } from 'node:fs'
import path from 'node:path'

type Env = Record<string, string | undefined>

// Walks up from `cwd` to the nearest `neat-out/daemon.json` and returns the
// project-scoped traces URL its daemon serves. Under one daemon per project the
// OTLP port is allocated at start (4318, stepping when a sibling holds it), so
// a fixed endpoint would send a second project's spans to the first project's
// daemon (#879). The record's project name scopes the route.
export function endpointFromDaemonRecord(
  cwd: string,
  fallbackProject?: string,
  readFile: (file: string, enc: 'utf8') => string = readFileSync,
): string | undefined {
  let dir = cwd
  for (let i = 0; i < 8; i++) {
    try {
      const rec = JSON.parse(readFile(path.join(dir, 'neat-out', 'daemon.json'), 'utf8')) as {
        project?: unknown
        ports?: { otlp?: unknown }
      }
      if (rec && rec.ports && typeof rec.ports.otlp === 'number') {
        const project = (typeof rec.project === 'string' && rec.project) || fallbackProject
        return project
          ? `http://localhost:${rec.ports.otlp}/projects/${project}/v1/traces`
          : `http://localhost:${rec.ports.otlp}/v1/traces`
      }
    } catch {
      // No record here (or an unreadable one); keep walking.
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

// Precedence matches the generated init: an explicit endpoint wins (a platform
// or collector owns the target); then the project daemon's own record; then the
// canonical 4318 route for the project `.env.neat` names. Never throws — this
// runs inside the user's app before it boots.
export function applyNeatEnv(env: Env = process.env, cwd: string = process.cwd()): void {
  try {
    if (env.NEAT_OTEL_TOKEN && !env.OTEL_EXPORTER_OTLP_HEADERS) {
      env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer ' + env.NEAT_OTEL_TOKEN
    }
    if (!env.OTEL_EXPORTER_OTLP_PROTOCOL) env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json'
    if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT) return
    const resolved =
      endpointFromDaemonRecord(cwd, env.NEAT_PROJECT) ??
      (env.NEAT_PROJECT ? `http://localhost:4318/projects/${env.NEAT_PROJECT}/v1/traces` : undefined)
    if (resolved) env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = resolved
  } catch {
    // A resolution fault leaves the SDK on its defaults rather than failing boot.
  }
}
