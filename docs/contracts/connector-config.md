---
name: connector-config
description: Connector credentials live in ~/.neat/connectors.json — machine-level, atomic writes, 0600 permissions. A provider dispatch table (connectors/registry.ts) maps provider name to factory. neat connector add/list/remove/enable/disable is a new top-level command family, not an eleventh query verb. The daemon reads connectors.json on boot and on the existing registry-reload path, starting one poll loop per enabled, project-matched entry.
governs:
  - "packages/core/src/connectors-config.ts"
  - "packages/core/src/connectors/registry.ts"
  - "packages/core/src/cli.ts"
  - "packages/core/src/daemon.ts"
adr: [ADR-130, ADR-124, ADR-048]
enforcement: [review]
---

# Connector configuration contract

Sibling to [`project-registry.md`](./project-registry.md) and [`connectors.md`](./connectors.md). Where `connectors.md` specifies the provider interface (`ObservedConnector`, `poll()`, the shared pull/map/fuse pipeline) and `project-registry.md` specifies how a project gets registered, this contract is the missing third piece: how a connector actually gets turned on for a registered project, with real credentials, by a user sitting at a terminal.

## 1. `~/.neat/connectors.json` — machine-level, atomic, `0600`

Same file family as `~/.neat/projects.json`: per-user, machine-local, never version-controlled, atomic tmp+fsync+rename writes, flock during writes (5s timeout, same as the project registry). One property `projects.json` never needed: **this file holds real secrets** — a bearer token, a connection string — so every write sets file mode `0600` (owner read/write only) explicitly, not inherited from the umask.

```ts
{
  version: 1,
  connectors: Array<{
    id: string,                            // user-chosen or auto-slugged, e.g. "supabase-prod"
    project: string,                       // matches a projects.json `name`
    provider: string,                      // 'supabase' | 'railway' | 'firebase' | 'cloudflare' | 'vercel'
    credentials: Record<string, unknown>,  // provider-shaped secret material
    config: Record<string, unknown>,       // provider-shaped non-secret config
    enabled: boolean,
    addedAt: string,                       // ISO8601
  }>
}
```

`~/.neat/connectors.json` is never read into the graph or the snapshot — `connectors.md` §6 ("credentials never reach the snapshot") holds unchanged; this file is where the config/broker state that clause already assumed actually lives.

## 2. `neat connector` is a new top-level command family, not an eleventh query verb

`cli-surface.md` locks a ten-verb query set mirroring the MCP read-only tool allowlist — "adding an eleventh verb requires a successor ADR." `neat connector add/list/remove/enable/disable` is mutation/config, the same category `init`/`sync`/`deploy` already occupy outside that locked set. It does not touch the ten-verb list and does not require amending its lock.

```
neat connector add <provider> --project <name> [--credential key=value ...]
neat connector list [--project <name>]
neat connector remove <id>
neat connector enable <id>
neat connector disable <id>
```

`add` without `--credential` flags prompts interactively per provider's own required-field spec (each provider module names its required credential/config keys — this contract doesn't hardcode a per-provider prompt list, it dispatches to whatever the provider factory declares it needs).

## 3. The provider dispatch table is the one place a new provider registers

`packages/core/src/connectors/registry.ts` maps a `provider` string to its connector factory (`createSupabaseConnector`, `createRailwayConnector`, `createFirebaseConnector`, `createCloudflareConnector`, and future entries). Both the CLI (`neat connector add`, to validate a provider name and know what fields to prompt for) and the daemon (to instantiate a configured connector) dispatch through this one table — neither hand-rolls its own provider switch statement. A fifth provider (Vercel's deferred Drains connector, or provider six) adds one entry here; CLI and daemon code don't change.

## 4. Daemon wiring reuses the existing registry-reload path

On boot and on the same `SIGHUP`/registry-reload trigger `project-registry.md` already documents, the daemon reads `~/.neat/connectors.json`. For every entry where `enabled` is true and `project` matches an active registered project, it resolves the provider via the dispatch table and calls `startConnectorPollLoop` with a `ConnectorContext` built from that entry's `credentials`/`config`. An entry whose `project` doesn't match any active project is skipped, not errored — the same graceful-skip discipline `project-registry.md` uses for a `paused` project, not a startup failure.

## 5. Least-privilege scoping is a per-provider concern, unchanged

This contract only specifies where a credential value lives and how it reaches a connector — not what shape that value takes. Each provider's own `docs/connectors/<provider>.md` already specifies its credential shape (a bearer token, a connection string, an OAuth-scoped token); `connectors.json`'s `credentials` field just holds whatever that provider calls for.

## 6. Hosted-profile credential brokering is out of scope

This contract covers the local-profile shape only — a developer running `neat connector add` on their own machine with their own credentials. NEAT-operated infrastructure brokering a customer's scoped token on their behalf, for the hosted profile, is separate infrastructure with its own credential store; this file format doesn't need to anticipate its shape.

## Authority

`packages/core/src/connectors-config.ts` owns `~/.neat/connectors.json` read/write. `packages/core/src/connectors/registry.ts` owns the provider dispatch table. `cli.ts` owns the `neat connector` verb family. `daemon.ts` owns reading the config on boot/reload and starting poll loops.

## Enforcement

`enforcement: [review]` — no code has landed yet (this contract lands with ADR-130, ahead of the implementation). Once built, a `contracts.test.ts` assertion should check the `0600` permission write, the atomic-write/flock behavior matching `project-registry.md`'s own test pattern, and that the CLI/daemon both dispatch through `registry.ts` rather than a hand-rolled switch — at that point this contract's enforcement tag should move to `[lint, review]`, the same graduation `connectors.md` itself took once its scaffold shipped.

Full rationale: [ADR-130](../decisions.md#adr-130--connector-credentials-live-in-a-machine-level-connectorsjson-enabled-via-neat-connector).
