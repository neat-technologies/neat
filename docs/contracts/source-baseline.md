---
name: source-baseline
description: Hosted source commit evidence is per bound repository, process-local, invalidated by static writes, and ready only after that repository's complete extraction.
governs:
  - 'packages/types/src/responses.ts'
  - 'packages/core/src/extract/source-baseline.ts'
  - 'packages/core/src/extract/index.ts'
  - 'packages/core/src/connectors/hosted-repos.ts'
  - 'packages/core/src/api.ts'
  - 'packages/core/src/ingest.ts'
  - 'packages/core/test/source-baseline.test.ts'
adr: [ADR-233]
enforcement: [lint, review]
---

# Hosted source baseline evidence

Refs #1309. Remediation needs evidence that the graph's extracted source matches
its pinned checkout. Runtime observation does not establish a source revision.

`GET /graph` adds `sourceBaselines` beside the unchanged `nodes` and `edges`,
one entry per bound repository the daemon holds evidence for, sorted by
repository:

```json
{
  "sourceBaselines": [
    { "status": "ready", "repository": "owner/repo", "sha": "<40 lowercase hex characters>" },
    { "status": "unavailable", "repository": "owner/other" }
  ]
}
```

The other per-entry status is `syncing`. Only `ready` carries a SHA. A consumer
reads the entry for the repository it was dispatched for and requires `ready`
and an exact commit match before model spend. A missing entry, an empty list,
or an older daemon without the field is unverified. One repository's status
never stands in for another's.

Evidence lives in memory per graph, outside node/edge attributes and snapshots.
Restarted or loaded graphs begin with an empty list. Clone URLs, credentials,
source, paths, prompts, test output and error messages never enter this field.
HTTP reads are synchronous with graph serialization, and returned metadata is a
copy.

## What makes an entry ready

A hosted pass is scoped to its repository (`source: owner/name`, ADR-233), so its
writes and its ghost-retire sweep stay inside that repository's files. That
scoping is what makes evidence per repository meaningful: an entry is only
recorded for a pass whose `sourceCommit.repository` is its own `source`.

The hosted clone resolves its actual Git HEAD. The extraction producer records
that commit only after a complete pass with zero extraction errors and zero
intentional unparsed source skips. Missing or invalid commit identity never
becomes ready. Asking for a new pass of a repository drops that repository's
old evidence straight away. Passes on one graph run in turn, so a pass only
counts as concurrent once it starts, not while it waits in the queue (#1331).

Node ids carry a service name, not a repository (ADR-233 leaves repository
identity open). Two bound repositories whose files belong to the same service
share nodes, so neither one's evidence describes them alone: both entries are
`unavailable` while the overlap lasts.

## What drops evidence

- For every entry: a pass scoped to no repository (it may rewrite any
  repository's nodes), an incoming snapshot merge, or a failed or unreadable
  repo list. A pass running at that moment cannot restore its claim.
  OBSERVED ingestion leaves source evidence alone, and incoming snapshot fields
  cannot establish or restore readiness.
- For one entry: a failed clone or source pass of that repository, the control
  plane reporting it `failed`, or a newer pass of it.
- An entry disappears when its repository is no longer bound. A row the daemon
  doesn't recognise is not synced and gets no entry; it does not affect other
  repositories' evidence.

A steady-state pass that skips a successfully synced repository preserves its
existing in-process evidence; a control-plane `synced` value by itself never
creates evidence.

Completeness decides this field and nothing else. A parser failure or
intentionally skipped source leaves the baseline `unavailable` until a later
complete pass, normally the repo's next push; it does not re-clone the same
commit or hold the boot resync open (connectors.md §3a). After restart,
`ready` still requires a fresh complete pass and a real Git HEAD; a restored
snapshot or remembered control-plane status cannot provide that evidence.

This field proves which source extraction completed, not that runtime was
deployed at that revision, nor that a patch fixes an incident.
