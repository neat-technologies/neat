import { databaseId, localDatabaseId } from '@neat.is/types'
import { canonicalEngine } from '../compat.js'

// One place that builds a DatabaseNode id, called by both the static extractor
// (extract/databases) and OTel ingest (ingest/database, ingest/peer), so the two
// sides cannot spell the id differently and twin the node (ADR-276, identity.md,
// #1641 option B). The canonicalisation it holds is engine aliasing; it reads the
// compat matrix through compat.ts (compat.json is core data, so this stays in
// core). Node creation and attribute merging stay with the callers (ADR-030).

// A networked DatabaseNode: the engine canonicalised through the compat matrix,
// then `database:<engine>:<host>`. Returns the canonical engine too, since the
// callers set it on the node.
export function databaseIdentity(engine: string | undefined, host: string): { id: string; engine: string } {
  const canonical = canonicalEngine(engine)
  return { id: databaseId(canonical, host), engine: canonical }
}

// An in-process / embedded DatabaseNode (SQLite, an in-memory store): service-
// scoped, with no engine in the id (ADR-118).
export function localDatabaseIdentity(service: string, name: string): { id: string } {
  return { id: localDatabaseId(service, name) }
}
