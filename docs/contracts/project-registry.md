---
name: project-registry
description: Single file ~/.neat/projects.json, per-user, machine-local. Atomic writes via tmp+rename. flock during writes. Path-normalized to prevent duplicate entries.
governs:
  - "packages/core/src/registry.ts"
  - "packages/core/src/cli.ts"
  - "packages/core/src/daemon.ts"
adr: [ADR-048, ADR-046, ADR-049]
enforcement: [lint, review]
---

# Machine-level project registry contract

The third of four v0.2.5 distribution-layer contracts. Sibling contracts: [`init.md`](./init.md), [`sdk-install.md`](./sdk-install.md), [`daemon.md`](./daemon.md).

The registry is what makes the daemon possible. Without a machine-level "what projects has the user registered," the daemon has nothing to watch.

## Single source of truth

`~/.neat/projects.json` — per-user, machine-local. Not synced. Not version-controlled.

## Shape

```ts
{
  version: 1,
  projects: Array<{
    name: string,
    path: string,                  // resolved absolute
    registeredAt: ISO8601,
    lastSeenAt?: ISO8601,
    languages: string[],
    status: 'active' | 'paused' | 'broken',
  }>
}
```

`version: z.literal(1)`.

## Atomicity

Writes go through `writeAtomically(path, contents)` — tmp + fsync + rename. No torn writes if daemon and `init` race.

## Lock file

Writes acquire exclusive flock on `~/.neat/projects.json.lock`. 5s timeout; failure is loud.

## Status semantics

| Status | Meaning |
|--------|---------|
| `active` | daemon watching; OTel ingest accepting spans |
| `paused` | registered but daemon ignores |
| `broken` | last operation failed (e.g. path missing) |

## Removal

`neat uninstall <name>` removes the entry. **Does not** delete `neat-out/`, `policy.json`, or user files. Reverses SDK-install patch via `neat-rollback.patch` if user opts in.

## Pruning dead-path entries

Ephemeral tmp-dir projects leave entries whose `path` no longer exists on disk. The registry keeps itself clean rather than carrying those entries forever.

Pruning is removal of user-facing state, so it is conservative on two axes:

- **Definite ENOENT only.** An entry is a prune candidate only when stat on its `path` returns `ENOENT` — the directory is genuinely gone. A transient stat failure (`EACCES`, `EBUSY`, an unmounted drive) leaves the entry untouched. An `active` project whose path still exists is never a candidate.
- **Staleness gate on auto-prune.** The daemon prunes on boot and on `SIGHUP` reload. There it drops a gone-path entry only once its `lastSeenAt` (falling back to `registeredAt`) is older than `NEAT_REGISTRY_PRUNE_TTL_MS` (default 7 days). A recently-active project whose path is briefly unavailable survives; the TTL is the safety margin before removal. Below the TTL, a gone-path entry is still marked `broken` as before.

`neat prune` is an explicit one-shot cleanup. As deliberate user intent it drops every gone-path entry immediately, regardless of TTL, and prints what it removed (`--json` emits the removed list). Entries whose paths still exist are kept.

Both paths go through the same lock + atomic tmp+rename write as every other mutation — pruning is never a raw rewrite, so the atomicity invariant holds. Authority lives in `pruneRegistry()` in `registry.ts`.

## Path normalization

Stored as resolved absolute path. Two `init` calls from different relative paths to the same dir don't create two entries.

## Multi-machine sync deferred

Per-machine for MVP.

## Authority

`packages/core/src/registry.ts`. CLI commands and daemon call into it. Daemon reads on boot and on `SIGHUP`.

## Enforcement

`it.todo` for v0.2.5 #119. Regression test: registry path is `~/.neat/projects.json` and no other module reads/writes it.

Full rationale: [ADR-048](../decisions.md#adr-048--machine-level-project-registry-contract).
