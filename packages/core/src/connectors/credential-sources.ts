// Credential-source dispatch — the one place a *refreshable* credential kind
// registers (docs/contracts/connector-config.md §9, ADR-223), parallel to the
// provider dispatch table (registry.ts) that registers a connector.
//
// A static env-ref credential resolves to a fixed value once (connectors-config.ts
// `resolveCredential`). A refreshable credential resolves to a `CredentialSource`
// instead: an async factory the poll loop calls each tick to mint/refresh a
// short-lived cloud token behind its own cache (connectors/index.ts). This file
// maps a credential `kind` string to the factory that builds that source, so the
// daemon-read path (registry.ts `resolveEntryCredentials`) and the add-time
// validator dispatch through one table rather than a per-kind switch — the same
// data-driven discipline the provider dispatch holds.

import { resolveCredentialValue, type RefreshableCredentialRef } from '../connectors-config.js'
import { createGcpTokenSource, mintGcpAccessToken, parseServiceAccountKey } from './gcp-auth.js'
import type { CredentialSource } from './types.js'

// The narrowest read scope the GCP connectors (cloud-run, firebase, gcp-lb) need
// — Cloud Logging read only (`roles/logging.viewer` carries it). Overridable per
// entry via `credential.scope` for a connector that reads a wider GCP surface.
const GCP_DEFAULT_SCOPE = 'https://www.googleapis.com/auth/logging.read'

/**
 * Build the durable-secret + params for a `gcp-service-account` credential into
 * a live token source. `keyJson` is an env-ref (default) or plaintext to the
 * service-account key JSON; `scope` is an optional non-secret override. Throws
 * `EnvRefUnsetError` (from `resolveCredentialValue`) when the key env-ref is
 * unset — kept distinct so the caller reports "you forgot to export" apart from
 * "your key is malformed", exactly as the static path does.
 */
// Resolve the durable-secret env-ref + scope for a gcp-service-account credential
// against the *given* env (the same env `buildRegistration`/`validateConnectorEntry`
// resolve every credential through), never a second copy of process.env — so a
// test env and the daemon's env both land here. Throws `EnvRefUnsetError` (from
// `resolveCredentialValue`) when the key ref is unset, kept distinct from a
// malformed key exactly as the static path keeps it.
function readGcpServiceAccountRef(
  ref: RefreshableCredentialRef,
  env: NodeJS.ProcessEnv,
): { key: ReturnType<typeof parseServiceAccountKey>; scope: string } {
  const keyJsonRef = ref['keyJson']
  if (typeof keyJsonRef !== 'string' || keyJsonRef.length === 0) {
    throw new Error('gcp-service-account credential: missing keyJson')
  }
  const key = parseServiceAccountKey(resolveCredentialValue(keyJsonRef, env))
  const scope = typeof ref['scope'] === 'string' && ref['scope'].length > 0 ? ref['scope'] : GCP_DEFAULT_SCOPE
  return { key, scope }
}

/**
 * One credential-kind's build-and-validate pair. `build` produces the live
 * source the poll loop calls; `validate` runs the same durable-secret resolution
 * plus one real mint, so `neat connector add`/`test` proves the key works before
 * the entry is written (the refreshable analog of a provider's auth probe). Both
 * receive the caller's `env` so the durable-secret env-ref resolves against the
 * same environment every other credential does.
 */
export interface CredentialSourceDispatch {
  build(ref: RefreshableCredentialRef, env: NodeJS.ProcessEnv): CredentialSource
  validate(ref: RefreshableCredentialRef, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<void>
}

export const CREDENTIAL_SOURCE_DISPATCH: Record<string, CredentialSourceDispatch> = {
  'gcp-service-account': {
    build(ref, env) {
      const { key, scope } = readGcpServiceAccountRef(ref, env)
      return createGcpTokenSource(key, scope)
    },
    async validate(ref, env, fetchImpl) {
      const { key, scope } = readGcpServiceAccountRef(ref, env)
      // One real token mint through the JWT-bearer flow — the honest round-trip
      // that confirms the key signs and Google accepts it.
      await mintGcpAccessToken(key, scope, fetchImpl ? { fetchImpl } : {})
    },
  },
}

export function getCredentialSourceDispatch(kind: string): CredentialSourceDispatch | undefined {
  return CREDENTIAL_SOURCE_DISPATCH[kind]
}

/** The kinds a refreshable credential's `kind` may name — for error messages and tests. */
export function refreshableCredentialKinds(): string[] {
  return Object.keys(CREDENTIAL_SOURCE_DISPATCH).sort()
}
