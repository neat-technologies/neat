# Run #2 — harvest report

Built NEAT from `574-port-bind-host` (Node 20), scaffolded a 2-service Express app (`harvest-api` + `harvest-ledger`, better-sqlite3) with 4 planted bugs, drove 225 requests across all routes. The #574 fix worked — the allocator stepped past held 8080/4318 and bound 8081/4319/6329.

## Planted bugs: 1 caught, 3 missed

- **Caught — missing-extracted (dynamic dispatch).** `handlers[action]()` hid an outbound call from static analysis; runtime produced `missing-extracted` on `file:harvest-api:src/ledger-client.js → service:harvest-ledger` (callCount 44, conf 0.78), file-grained, accurate "likely dynamic dispatch" recommendation. **NEAT's one clean win — the fusion thesis working.**
- **Missed — host-mismatch.** config declares `postgres://…@pg.prod.internal:5432`, app opens local SQLite. 0 DatabaseNodes created; detector structurally unreachable.
- **Missed — missing-observed (dead `buildLegacyReport`).** No function-grain call edges, so dead code is indistinguishable from live; and buried under 13 false-positive missing-observed findings.
- **Missed — route throws (root-cause).** 50 incidents recorded but root-cause surfaced nothing.

## NEAT defects (the harvest)

| ID | Sev | Defect | Source hint | Disposition |
|----|-----|--------|-------------|-------------|
| A | HIGH | Divergence flood — `IMPORTS`/`CONFIGURED_BY` reported as `missing-observed` (13 false positives) | `divergences.ts:148` | **fix wave** (divergence-precision) |
| B | HIGH | root-cause blind to the incident store — "healthy" while 50 incidents recorded | `api.ts:435` / `traverse.ts` | **fix wave** (root-cause-incidents) |
| C | HIGH | OBSERVED near-zero for inbound/in-process — only caller side of cross-service calls mints an edge | `ingest.ts:1085` | filed **#576** (architectural) |
| D | HIGH | Incident attribution service-coarse despite `code.filepath`/`lineno`/route | `ingest.ts:910` | **fix wave** (root-cause-incidents) |
| E | HIGH | Static DB extraction misses a plain `postgres://` connection string → host-mismatch unreachable | `extract/databases/` | **fix wave** (db-config-extraction) |
| F | MED | Incident message "unknown error" for app-handled 500s | `ingest.ts:910` | **fix wave** (root-cause-incidents) |
| G | MED | Frontier OBSERVED edge not retired after promotion → duplicate divergence | `ingest.ts:1284` | filed **#577** |
| H/I | MED | observed-dependencies wrong granularity + misleading "is OTel running?" on receivers | `api.ts` / `cli-client.ts` | filed **#578** |
| J | HIGH(DX) | One-command flow fails on a healthy run, poisoned by an unrelated broken project in the readiness gate | `orchestrator.ts` | **fix wave** (orchestrator-dx) |
| K | MED | CLI query verbs can't reach a non-default project's daemon — `resolveDaemonUrl` ignores the registry | `cli.ts:1167` | filed **#579** |
| L | MED | Daemon binds IPv4-only but advertises a bare port — IPv6 listener shadows it | bind-host (#575 area) | filed **#580** |
| M | LOW | Grammar: "this library aren't" | `orchestrator.ts:~304` | **fix wave** (orchestrator-dx) |

## The honest takeaways

- **The fusion only fired on the one outbound HTTP hop.** A realistic Express-on-SQLite service is near worst-case: in-process DB invisible, inbound spans don't mint edges — the OBSERVED layer that's supposed to "carry the load" delivered a single edge (defect C).
- **Precision is the headline problem.** The agent-visible divergence surface is 13 false positives + 2 real (one duplicated), with the actual planted bugs nowhere in it. An agent acting on this chases phantoms and trusts a "healthy" verdict on a service throwing 500s.
- **Root-cause + incidents are disconnected.** NEAT *has* the exact `index.js:22` / `/users/:id` / 500 data but can't turn it into a root cause or attribute below the service level (defects B/D).
