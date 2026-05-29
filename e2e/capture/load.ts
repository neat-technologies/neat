#!/usr/bin/env tsx
// Drives the capture sample service so each instrumentation tier emits spans.
// Not a load test — the goal is one clean span per tier, repeated enough that
// the OBSERVED edges materialise and grade above the weak floor.

const APP_BASE = process.env.CAPTURE_APP_BASE ?? 'http://127.0.0.1:8082'
const N = Number.parseInt(process.env.LOAD_N ?? '8', 10)
const JITTER_MS = Number.parseInt(process.env.LOAD_JITTER_MS ?? '50', 10)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Each route exercises a tier; a non-5xx response means the span was emitted
// (the route returns 200 even when the underlying call fails at connect/auth —
// the span is what we're after, not the call's success).
const routes = ['/sync-pg', '/http', '/floor', '/fetch', '/prisma', '/aws'] as const

async function hit(path: string): Promise<boolean> {
  try {
    const r = await fetch(`${APP_BASE}${path}`)
    return r.status < 500
  } catch (err) {
    console.error(`[load] ${path} threw:`, (err as Error).message)
    return false
  }
}

async function main(): Promise<void> {
  const start = Date.now()
  const totals: Record<string, { ok: number; fail: number }> = {}
  for (const r of routes) totals[r] = { ok: 0, fail: 0 }

  for (let i = 0; i < N; i++) {
    for (const route of routes) {
      const ok = await hit(route)
      totals[route][ok ? 'ok' : 'fail']++
      await sleep(JITTER_MS)
    }
  }

  const elapsed = Date.now() - start
  console.log(`[load] drove ${routes.length} tiers x ${N} iterations in ${elapsed}ms`)
  for (const [name, t] of Object.entries(totals)) {
    console.log(`  ${name}: ${t.ok} ok, ${t.fail} fail`)
  }
}

main().catch((err) => {
  console.error('[load] fatal:', err)
  process.exit(1)
})
