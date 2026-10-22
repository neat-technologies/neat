---
name: project-registry
description: Single file ~/.neat/registry.json, per-user, machine-local, keyed by projectId (ADR-273) and rebuildable from the .neat/project.json files at known paths. Atomic writes via tmp+rename. flock during writes. Path-normalized. Names may repeat; projectId is the key. The pre-273 ~/.neat/projects.json is read once to migrate and never written again.
governs:
  - "packages/core/src/registry.ts"
  - "packages/core/src/cli.ts"
  - "packages/core/src/daemon.ts"
adr: [ADR-048, ADR-046, ADR-049, ADR-130, ADR-231, ADR-273]
enforcement: [lint, review]
---

# Machine-level project registry contract

The third of four v0.2.5 distribution-layer contracts. Sibling contracts: [`init.md`](./init.md), [`sdk-install.md`](./sdk-install.md), [`daemon.md`](./daemon.md).

The registry is what makes the daemon possible. Without a machine-level "what projects has the user registered," the daemon has nothing to watch.

## Single source of truth — an index, not the identity

`~/.neat/registry.json` — per-user, machine-local. Not synced. Not version-controlled. Since [ADR-273](../decisions.md#adr-273--a-projects-identity-is-committed-in-the-repo-and-its-locality-is-a-per-project-binding) the registry is an **index**: a project's identity lives in its own committed `<repo>/.neat/project.json` ([`project-identity.md`](./project-identity.md)), and the registry records where this machine has seen each one. Losing the file costs nothing that can't be rebuilt: `neat list --rebuild` (and the daemon on boot) re-reads `.neat/project.json` at every known path.

## Shape

```ts
{
  version: 2,
  projects: Array<{
    projectId: string,             // prj_<ULID>, from <path>/.neat/project.json — the key
    name: string,                  // display; may repeat across rows
    path: string,                  // resolved absolute
    binding: 'local' | 'hosted',   // from <path>/.neat/binding.json, 'local' when absent
    org?: string,                  // when hosted
    daemon?: { pid: number, port: number, startedAt: ISO8601 } | null,
    registeredAt: ISO8601,
    lastSeenAt?: ISO8601,
    languages: string[],
    status: 'active' | 'paused' | 'broken',
  }>
}
```

`version: z.literal(2)`. One row per `projectId` per path; two checkouts of the same repo on one machine are two rows with the same `projectId` and different paths, and `neat list` shows both.

## Migrating from `~/.neat/projects.json`

The pre-273 file (`version: 1`, keyed by unique `name`) is read once, on the first registry read that finds no `registry.json`. Each row whose path still holds a `.neat/project.json` is imported under that file's `projectId`. A row whose path has none is imported as a **legacy** row (`projectId` absent, `legacy: true`): it still resolves by name, with a notice, until `neat init` gives it an identity (project-identity.md §3 level 4). `projects.json` is left untouched on disk and never written again, so a rollback (`NEAT_LEGACY_ROUTING=1`) still finds it.

## Atomicity

Writes go through `writeAtomically(path, contents)` — tmp + fsync + rename. No torn writes if daemon and `init` race.

## Lock file

Writes acquire exclusive flock on `~/.neat/projects.json.lock`. 5s timeout; failure is loud.

## Status semantics

| Status | Meaning |
|--------|---------|
| `active` | daemon watching; OTel ingest accepting spans |
| `paused` | set by an operator with `neat pause <name>`, never as a side effect of another project's run (ADR-231). The legacy registry daemon routes no spans to it; a per-project daemon (ADR-096) does not read it |
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

## Orphans and duplicates

`neat list` reconciles the registry with the filesystem and running processes. A `neat-out/` directory with no `.neat/project.json` beside it is an **orphan** and is flagged, never treated as an active project. A name that several rows share is shown with each `projectId` and path; it is no longer an error, because the name is not the key.

## Multi-machine sync deferred

Per-machine for MVP.

## Authority

`packages/core/src/registry.ts`. CLI commands and daemon call into it. Daemon reads on boot and on `SIGHUP`.

## Enforcement

`it.todo` for v0.2.5 #119. Regression test: registry path is `~/.neat/registry.json`, `projects.json` is only ever read (for migration), and no other module reads/writes either.

Full rationale: [ADR-048](../decisions.md#adr-048--machine-level-project-registry-contract).
