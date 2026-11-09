// `neat project promote --org <org>` — move a LOCAL project to hosted on this
// machine (ADR-273, WO-1.1, Phase 1). It is a migration, done in order and made
// atomic by flipping the binding LAST:
//
//   1. register the project with the control plane, reusing its committed
//      projectId (POST /me/projects/register {neatProjectId, name}). The CP
//      mints its OWN id and returns it; every later /me/projects/:id/* call
//      takes that CP id, not ours.
//   2. re-key the project's connectors into the CP — REFS ONLY, never resolved
//      secret values, and only from the per-project .neat/connectors.json (never
//      the machine-level ~/.neat file, which can still hold plaintext).
//   3. flip .neat/binding.json to hosted — LAST, so any failure in 1 or 2 leaves
//      the project local and never half-migrated.
//
// The graph snapshot is NOT pushed: the CP has no snapshot-ingest endpoint and
// whether the hosted side re-extracts or accepts a push is an unmade CP decision
// (filed to orch/GTM). Every side effect (fetch, the binding write) is reachable
// through injected deps so the whole flow is testable against a local CP stub.

import { readProjectIdentity, writeProjectBinding } from './project-identity.js'
import { resolveCpUrl } from './login-sso.js'
import { isCredentialRef, readProjectConnectors } from './connectors-config.js'

export interface PromoteDeps {
  // The control plane base URL and the caller's NEAT api key (neat_pat_…).
  cpUrl: string
  apiKey: string
  // Injected so tests drive a local stub and never touch api.neat.is.
  fetchImpl?: typeof fetch
}

export interface PromoteOutcome {
  ok: boolean
  // Human-readable lines for what happened, in order — printed by the CLI.
  steps: string[]
  // The CP's own project id, on success.
  cpProjectId?: string
  // Set when the migration stopped; the binding is still local.
  error?: string
}

// cpUrl + the api key, the two creds promote needs. Unlike `neat connect`, it
// needs NO hosted project id — register is what creates the hosted project. The
// login profile will supply the key durably; env is the interim source.
export function resolvePromoteCreds(
  env: NodeJS.ProcessEnv = process.env,
): { cpUrl: string; apiKey: string } | { error: string } {
  const apiKey = env.NEAT_API_KEY
  if (!apiKey || apiKey.length === 0) {
    return { error: 'not logged in — run `neat login`, or set NEAT_API_KEY (a neat_pat_… key)' }
  }
  return { cpUrl: resolveCpUrl(env), apiKey }
}

export async function promoteProject(
  root: string,
  org: string,
  deps: PromoteDeps,
): Promise<PromoteOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const steps: string[] = []
  const identity = await readProjectIdentity(root)
  if (!identity) {
    return { ok: false, steps, error: 'no .neat/project.json here — run `neat init` first' }
  }
  const headers = {
    authorization: `Bearer ${deps.apiKey}`,
    'content-type': 'application/json',
  }

  // 1. Register. A failure here returns before the binding is touched, so the
  // project stays local.
  let cpProjectId: string
  try {
    const res = await fetchImpl(`${deps.cpUrl}/me/projects/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ neatProjectId: identity.projectId, name: identity.name }),
    })
    if (!res.ok) {
      return { ok: false, steps, error: `registering with ${org} failed (HTTP ${res.status})` }
    }
    // Register is idempotent (neat-infra#215): 201 with a fresh row the first
    // time, 200 with the SAME row on a retry — both carry the CP's own id. The
    // CP mints that id (prj_ + 20 hex) and every later /me/projects/:id/* call
    // takes it, never our ULID. The response is the bare project object.
    const body = (await res.json()) as { id?: unknown }
    if (typeof body.id !== 'string' || body.id.length === 0) {
      return { ok: false, steps, error: 'the control plane returned no project id' }
    }
    cpProjectId = body.id
  } catch (e) {
    return {
      ok: false,
      steps,
      error: `could not reach the control plane: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  steps.push(`registered ${identity.name} (${identity.projectId}) in ${org}`)

  // 2. Re-key connectors — REFS ONLY, from the project file alone. The reader
  // returns refs by construction; the guard is belt-and-suspenders so a plaintext
  // value can never leave the machine even if the file were hand-edited.
  const connectors = await readProjectConnectors(root)
  for (const entry of connectors.connectors) {
    if (!isCredentialRef(entry.credential)) {
      return {
        ok: false,
        steps,
        error: `refusing to push connector ${entry.id}: its credential is a plaintext value, not a ref`,
      }
    }
    const res = await fetchImpl(
      `${deps.cpUrl}/me/projects/${encodeURIComponent(cpProjectId)}/connections`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: entry.id,
          provider: entry.provider,
          credential: entry.credential,
          ...(entry.options ? { options: entry.options } : {}),
        }),
      },
    )
    if (!res.ok) {
      return { ok: false, steps, error: `re-keying connector ${entry.id} failed (HTTP ${res.status})` }
    }
    steps.push(`re-keyed connector ${entry.id} (${entry.provider})`)
  }

  // 3. Flip the binding LAST — everything remote has already succeeded.
  await writeProjectBinding(root, { binding: 'hosted', org })
  steps.push(`binding is now hosted@${org}`)
  return { ok: true, steps, cpProjectId }
}
