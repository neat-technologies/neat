---
name: connector-config
description: How a built connector turns on. ~/.neat/connectors.json (machine-level, atomic, 0600, sibling to projects.json) holds one entry per connector — provider, optional project, credential, options. A credential is an env-var reference by default ("$SUPABASE_KEY"), resolved to a value only at daemon-read time so no secret sits at rest in the file; plaintext is an explicit opt-in fallback. A data-driven provider dispatch table (connectors/registry.ts) maps provider name to its factory, validator, and required-field schema. neat connector add/list/remove/test is a new top-level command family, not an eleventh query verb; add validates the credential against the provider's auth path by default (--skip-validate to skip). The daemon reads connectors.json at slot bootstrap, resolves env-refs, and populates opts.connectors — the already-built startConnectorPollLoop does the rest.
governs:
  - "packages/core/src/connectors-config.ts"
  - "packages/core/src/connectors/registry.ts"
  - "packages/core/src/cli.ts"
  - "packages/core/src/daemon.ts"
adr: [ADR-130, ADR-124, ADR-048, ADR-131, ADR-073]
enforcement: [review]
---

# Connector configuration contract

Sibling to [`project-registry.md`](./project-registry.md) and [`connectors.md`](./connectors.md). Where `connectors.md` specifies the provider interface (`ObservedConnector`, `poll()`, the shared pull/map/fuse pipeline) and `project-registry.md` specifies how a project gets registered, this contract is the third piece: how a built connector actually gets turned on for a registered project, with real credentials, by a user sitting at a terminal.

The connectors plane already has everything downstream of a credential. `startConnectorPollLoop` (`connectors/index.ts`, wired into the daemon slot at `daemon.ts:553`) drives `poll()` on a cadence, one loop per `opts.connectors` entry; the shared junction layer (`connectors.md`, ADR-131) gives every outbound call its timeout/retry/rate-limit discipline; each provider's `poll()` and signal mapping is built and tested. This contract governs the one path that reaches all of it: `connectors.json` → the daemon reads it → a dispatch table resolves the provider → `opts.connectors` is populated → the loop that already exists mints the edges.

## 1. `~/.neat/connectors.json` — machine-level, atomic, `0600`

Same file family as `~/.neat/projects.json`: per-user, machine-local, never version-controlled, atomic tmp+fsync+rename writes, flock during writes (5s timeout, matching the project registry). One property `projects.json` never needed: **this file references real secrets**, so every write sets file mode `0600` (owner read/write only) explicitly, not inherited from the umask.

```ts
{
  version: 1,
  connectors: Array<{
    id: string,               // addressable handle, auto-slugged from provider
                              // (disambiguated by project when a provider repeats),
                              // used by `remove <id>` / `test <id>`
    provider: string,         // 'supabase' | 'railway' | 'firebase' | 'cloudflare' | 'vercel'
    project?: string,         // matches a projects.json `name` — whose graph the edges
                              // attach to; omitted binds to the project the daemon is
                              // bootstrapping (one daemon per project, ADR-096)
    credential: CredentialRef,          // env-ref by default (see §2)
    options?: Record<string, unknown>,  // provider-shaped non-secret config
                                        // (project ref, service-id mappings, poll cadence)
  }>
}
```

`~/.neat/connectors.json` is never read into the graph or the snapshot — `connectors.md` §6 ("credentials never reach the snapshot") and the `.env`-contents rule (`contracts.md` Rule 13) both hold unchanged. This file is where the config/broker state those clauses already assume actually lives, and even here the default form holds a *pointer*, not the secret itself.

## 2. Credential-at-rest is an env-var reference by default

A `credential` is, by default, an **env-var reference** — a string whose leading `$` marks it as the name of an environment variable (`"$SUPABASE_KEY"`), resolved to a value only when the daemon builds a connector's registration (§6). The secret never sits at rest in the file; `connectors.json` holds the pointer, the environment holds the value.

- **Single-field providers** carry one ref: `"credential": "$RAILWAY_TOKEN"`.
- **Multi-field providers** carry an object mapping each credential field to its own ref: `"credential": { "connectionString": "$SUPABASE_DB_URL", "serviceKey": "$SUPABASE_SERVICE_KEY" }`. Resolution walks the object and substitutes each `$`-prefixed value.
- **Plaintext is the explicit opt-in fallback** — a string (or field value) without a leading `$` is a literal secret, stored as-is. It is documented, guarded by the `0600` mode, and the only form that puts a secret at rest. Env-ref is the default precisely so a user opts *in* to at-rest storage rather than getting it by omission.

**One shape serves both profiles** (`connectors.md` §3). Local — the developer's own environment holds the secret, `connectors.json` holds only the ref. Hosted — the control plane injects the referenced environment variable exactly as it already brokers `NEAT_AUTH_TOKEN` (`one-command-cli.md`, ADR-073), so a tenant's `connectors.json` ships identical and the secret never sits at rest in their config. The env-ref indirection is itself the local↔hosted seam; §8 replaces the earlier hosted-brokering boundary with it.

## 3. `neat connector` is a new top-level command family, not an eleventh query verb

`cli-surface.md` locks a ten-verb query set mirroring the read-only MCP tool allowlist — "an eleventh verb requires a successor ADR." `neat connector` is mutation/config, the same category `init`/`sync`/`deploy` already occupy outside that locked set. It does not touch the ten-verb list.

```
neat connector add <provider> [--project <name>] [--<field> <value> ...] [--skip-validate]
neat connector list [--project <name>]
neat connector remove <id>
neat connector test <id>
```

`add` takes both **interactive prompts and flags**: run bare, it prompts for the provider's required fields (named by the provider's dispatch-table entry, §5); given flags, it skips the prompts for scripting and CI. Either path defaults a credential to an env-ref unless the value is given as a plaintext literal. `list` and `remove` manage entries; `test` re-runs the validation round-trip (§4) against an already-written entry.

## 4. `add` validates against the provider by default; `test` re-runs it

`add` runs a cheap round-trip through the connector's own auth path — via the dispatch-table validator (§5), through the shared junction (ADR-131) — **before** writing the entry, so a wrong credential fails fast and honestly at add-time instead of surfacing quietly at the first poll. `--skip-validate` writes without the round-trip, for the offline or env-not-yet-populated case. `test <id>` runs the identical round-trip against an existing entry on demand.

**An unset env-ref is a resolution error, not a validation failure.** If a credential references `$SUPABASE_KEY` and that variable is unset in the environment at add-time (or test-time), the command fails with `"$SUPABASE_KEY is unset"` — a distinct exit path from a validation failure, which means the credential resolved to a value and the provider rejected it. Conflating the two would tell a user their token is wrong when they only forgot to `export` it. `--skip-validate` also covers the deliberately-set-later case (add now, populate the env before the daemon runs).

## 5. The provider dispatch table is data-driven and the one place a provider registers

`packages/core/src/connectors/registry.ts` maps a `provider` string to its dispatch-table entry: the connector **factory** (`createSupabaseConnector`, `createRailwayConnector`, `createFirebaseConnector`, `createCloudflareConnector`, and future entries), a **validator** (the cheap auth round-trip §4 calls), and the **required-field schema** (which credential/config keys `add` prompts for). Both the CLI and the daemon dispatch through this one table — neither hand-rolls a per-provider `switch`. This is the same principle `compat.json` holds for driver logic (`CLAUDE.md` § Don't do — "don't hardcode driver-specific logic outside `compat.json`; `compat.ts` reads from data"): provider-specific behavior lives in data the table reads, not in scattered branches.

The table is also the normalization seam for the providers' differing factory shapes (some take a graph and a config object, some pair a connector factory with a separate `resolveTarget` factory) — the entry adapts each into the uniform registration the daemon builds in §6. A fifth provider (Vercel's deferred Drains connector, or provider six) adds one entry here; CLI and daemon code do not change.

## 6. The daemon reads `connectors.json` at slot bootstrap

The daemon-read is the load-bearing middle — the CLI only writes the file; this is what turns the file into running poll loops. At **slot bootstrap** (`bootstrapProject`, where `daemon.ts:553` already starts the poll loops from `opts.connectors`), the daemon reads `~/.neat/connectors.json`. For every entry whose `project` matches the project being bootstrapped (or whose `project` is omitted), it:

1. resolves the provider through the dispatch table (§5),
2. resolves the entry's env-ref credential against the environment (§2), failing that project's connector slot loudly if a referenced variable is unset — never silently polling with an empty credential,
3. builds a `ConnectorRegistration` (`connectors/index.ts` — `{ connector, credentials, resolveTarget, intervalMs? }`) with the resolved credential, and
4. hands it to `startConnectorPollLoop`, which is already wired and tested.

The resolved secret exists only in memory, inside the `ConnectorContext` that flows to `poll()` — never written back to disk, never into the snapshot. An entry whose `project` matches no active project is skipped, not errored, the same graceful-skip discipline `project-registry.md` applies to a paused project.

## 7. Least-privilege scoping stays a per-provider concern

This contract specifies where a credential lives and how it reaches a connector — not what shape the value takes. Each provider's own `docs/connectors/<provider>.md` specifies its credential shape (a bearer token, a connection string, an OAuth-scoped token) and its least-privilege grant (`connectors.md` §3, mandatory for the hosted profile); `connectors.json`'s `credential` field just references whatever that provider calls for.

## 8. Hosted-profile brokering reuses the env-ref indirection

The env-ref default (§2) is the hosted seam, not a local-only convenience. NEAT-operated infrastructure brokering a customer's scoped token injects the referenced environment variable exactly as the control plane already injects `NEAT_AUTH_TOKEN` — so a tenant's `connectors.json` is byte-identical to a local one and holds no secret at rest. The broker's own credential store (how the control plane obtains and rotates the value it injects) is separate infrastructure with its own contract; this file format needs no hosted-specific shape.

## Authority

`packages/core/src/connectors-config.ts` owns `~/.neat/connectors.json` read/write and env-ref resolution. `packages/core/src/connectors/registry.ts` owns the provider dispatch table (factory, validator, schema). `cli.ts` owns the `neat connector` verb family. `daemon.ts` owns reading the config at slot bootstrap and populating `opts.connectors`.

## Enforcement

`enforcement: [review]` — this contract lands with ADR-130, ahead of the implementation, so review is the active pillar today. Once the code lands, a `contracts.test.ts` assertion should check: the `0600` permission on every write, the atomic-write/flock behavior matching `project-registry.md`'s test pattern, that env-ref credentials resolve at daemon-read time and never appear resolved on disk, and that the CLI and daemon both dispatch through `registry.ts` rather than a hand-rolled switch. At that point the tag graduates to `[lint, review]`, the same path `connectors.md` took once its scaffold shipped.

Full rationale: [ADR-130](../decisions.md#adr-130--connector-credentials-live-in-a-machine-level-connectorsjson-enabled-via-neat-connector).
