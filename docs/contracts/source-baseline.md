---
name: source-baseline
description: Hosted source commit evidence is process-local, invalidated by static writes, and ready only after complete extraction of a single bound repository.
governs:
  - 'packages/types/src/responses.ts'
  - 'packages/core/src/extract/source-baseline.ts'
  - 'packages/core/src/extract/index.ts'
  - 'packages/core/src/connectors/hosted-repos.ts'
  - 'packages/core/src/api.ts'
  - 'packages/core/src/ingest.ts'
  - 'packages/core/test/source-baseline.test.ts'
enforcement: [lint, review]
---

# Hosted source baseline evidence

Refs #1309. Remediation needs evidence that the graph's extracted source matches
its pinned checkout. Runtime observation does not establish a source revision.

`GET /graph` adds `sourceBaseline` beside the unchanged `nodes` and `edges`:

```json
{
  "sourceBaseline": {
    "status": "ready",
    "repository": "owner/repo",
    "sha": "<40 lowercase hex characters>"
  }
}
```

Other statuses are `unverified`, `syncing`, and `unavailable`; they never carry a
SHA. A syncing response may name the repository. Consumers require `ready`, an
exact repository match, and an exact commit match before model spend. Older
daemons without this field are unverified.

Evidence lives in memory per graph, outside node/edge attributes and snapshots.
Restarted or loaded graphs begin unverified. Clone URLs, credentials, source,
paths, prompts, test output and error messages never enter this field. HTTP reads
are synchronous with graph serialization, and returned metadata is a copy.

The hosted clone resolves its actual Git HEAD. The extraction producer records
that commit only after a complete pass with zero extraction errors and zero
intentional unparsed source skips. Missing or invalid commit identity never
becomes ready. A new extraction invalidates old evidence before any work; a
concurrent extraction or incoming snapshot merge prevents an earlier extraction
from restoring its stale claim. OBSERVED ingestion leaves source evidence alone.
Incoming snapshot fields cannot establish or restore readiness.

The first cut permits exactly one bound repository because hosted extraction
has no repository namespace yet. A failed/unreadable repo list, failed source
pass, zero bound repositories, changed binding, or multiple bound repositories
invalidates the claim. A steady-state pass that skips the same successfully
synced repository preserves its existing in-process evidence; a control-plane
`synced` value by itself never creates evidence.

This field proves which source extraction completed, not that runtime was
deployed at that revision, nor that a patch fixes an incident.
