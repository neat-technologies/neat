#!/usr/bin/env tsx
// Drives Brief's API with a small set of synthetic user journeys so the OTel
// SDK on Brief's side emits enough variety of spans for neatd's OBSERVED tier
// to materialize. Not a load tester — the goal is span shape coverage, not
// throughput.

const BRIEF_BASE = process.env.BRIEF_BASE ?? 'http://localhost:8081'
const N = Number.parseInt(process.env.LOAD_N ?? '20', 10)
const JITTER_MS = Number.parseInt(process.env.LOAD_JITTER_MS ?? '50', 10)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Journey = {
  name: string
  // Returns true on a response that's "valid for our purposes" — i.e. Brief
  // produced a span, even if the response was a 4xx (invalid credentials,
  // captcha required). The point is to emit spans, not to validate Brief.
  run: () => Promise<boolean>
}

async function probe(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BRIEF_BASE}${path}`, init)
}

const journeys: Journey[] = [
  {
    name: 'health',
    run: async () => {
      const r = await probe('/health')
      return r.status === 200
    },
  },
  {
    name: 'signup',
    run: async () => {
      const email = `e2e-${Math.floor(Math.random() * 1e9)}@neat.test`
      const r = await probe('/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct horse battery staple', username: 'e2e' }),
      })
      // 202 = confirmation_required (expected for an unverified email)
      // 400 = supabase rejected (rate limit, format) — still a real span
      return r.status < 500
    },
  },
  {
    name: 'login',
    run: async () => {
      // Intentionally wrong creds. Want the auth-flow span, not a session.
      const r = await probe('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'missing@neat.test', password: 'nope' }),
      })
      return r.status < 500
    },
  },
  {
    name: 'community-threads',
    run: async () => {
      const topics = ['Macro', 'Tech', 'Markets', 'All']
      const topic = topics[Math.floor(Math.random() * topics.length)]
      const r = await probe(`/community/threads?topic=${encodeURIComponent(topic)}`)
      return r.status < 500
    },
  },
  {
    name: 'briefing-today',
    run: async () => {
      // 500 is fine for our purposes — the route still touched prisma + emit-
      // ted a CALLS span before failing. We're not asserting Brief's correctness.
      const r = await probe('/briefing/today')
      return r.status < 600
    },
  },
]

async function main(): Promise<void> {
  const start = Date.now()
  const totals: Record<string, { ok: number; fail: number }> = {}
  for (const j of journeys) totals[j.name] = { ok: 0, fail: 0 }

  for (let i = 0; i < N; i++) {
    for (const j of journeys) {
      try {
        const ok = await j.run()
        totals[j.name][ok ? 'ok' : 'fail']++
      } catch (err) {
        totals[j.name].fail++
        console.error(`[load] ${j.name} threw:`, (err as Error).message)
      }
      await sleep(JITTER_MS + Math.floor(Math.random() * JITTER_MS))
    }
  }

  const elapsed = Date.now() - start
  console.log(`[load] drove ${journeys.length} journeys x ${N} iterations in ${elapsed}ms`)
  for (const [name, t] of Object.entries(totals)) {
    console.log(`  ${name}: ${t.ok} ok, ${t.fail} fail`)
  }
}

main().catch((err) => {
  console.error('[load] fatal:', err)
  process.exit(1)
})
