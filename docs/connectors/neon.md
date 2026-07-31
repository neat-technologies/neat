# Neon connector

Neon joins the pull connectors plane through Postgres's own `pg_stat_statements`
view (ADR-156). It turns cumulative statement-count changes into OBSERVED calls to
the same `infra:sql-table:<name>` nodes the SQLAlchemy and Django ORM extractors
produce.

## Scope and evidence

Neon's management and consumption APIs expose project, branch, compute, and aggregate
usage data, but no table-grained query telemetry. The connector therefore opens a
short-lived Postgres connection and reads telemetry the database already records. It
never executes application traffic, resets statistics, or writes database state.

`pg_stat_statements.calls` is cumulative. The first poll establishes a baseline and
emits no signal; later polls emit only positive deltas. A counter reset or an evicted
statement also starts a fresh baseline. The connector reports no error count because
the view does not provide one, and uses the poll snapshot time as the time the increase
was observed. That is not claimed to be the original execution time.

Only statements with one conservatively-resolvable target are table-attributed. Joins,
subqueries with multiple `FROM` clauses, system objects, and unparsable statements stay
unresolved rather than being assigned to a guessed table.

## Least-privilege credential

Use a dedicated login role. Run this once as a project owner, choosing a strong password:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE ROLE neat_observer LOGIN PASSWORD '<generated-password>';
GRANT pg_read_all_stats TO neat_observer;
REVOKE ALL ON SCHEMA public FROM neat_observer;
GRANT USAGE ON SCHEMA public TO neat_observer;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM neat_observer;
ALTER ROLE neat_observer SET default_transaction_read_only = on;
```

Store its Neon connection string in an environment variable. The connector also issues
`SET default_transaction_read_only = on` on every session as defense in depth. The hosted
profile brokers this scoped value; an owner or `neon_superuser` connection string is not
the recommended hosted credential.

```bash
export NEON_OBSERVER_URL='postgresql://neat_observer:...@ep-...neon.tech/neondb?sslmode=require'
neat connector add neon \
  --credential '$NEON_OBSERVER_URL' \
  --project-id '<neon-project-id>' \
  --service-name '<manifest-service-name>'
```

The stored connector entry keeps only the `$NEON_OBSERVER_URL` pointer. `projectId` is a
non-secret account key for rate limiting and diagnostics; `serviceName` identifies the NEAT
service that issues the observed queries.

## Fusion

A statement that unambiguously targets `orders` resolves with
`infraId('sql-table', 'orders')`. That is exactly the identity helper and kind used by the
existing SQLAlchemy and Django ORM extractors. If one EXTRACTED file edge from the configured
service reaches that node, the shared connector pipeline attributes the OBSERVED edge to that
file. Zero or multiple static candidates stay service-grained.

If no static producer has declared the table, the generic ingest-authority path creates the
same canonical InfraNode and the service-grained observation surfaces as missing-extracted.
The provider resolver itself never mutates the graph.

## Polling and status

The connector uses the standard connector registration, poll loop, on-demand poll endpoint,
and status tracker. `GET /connectors` reports its latest outcome; `POST
/:project/connectors/:id/poll` runs the same baseline/delta/fuse path immediately. Database
calls pass through the shared DB junction, which applies the common timeout, retry,
per-project rate limit, and bounded elapsed-time behavior.

Polling can wake a scaled-to-zero compute and consumes one short-lived connection. The default
query is capped at the 500 busiest statements; configure a smaller `statementLimit` where
compute wakeups or telemetry cost need tighter bounds.

## Verification

The repository proof uses a faithful `pg_stat_statements` row shape and two consecutive
snapshots: the first establishes a baseline and the second increases the counter. It asserts
that the resulting OBSERVED edge and a pre-existing EXTRACTED ORM edge share the exact
`infraId('sql-table', 'orders')` target and that unique static attribution lands both at the
same file source. No Neon credential is available in the test environment, so no live-provider
claim is made by this change.
