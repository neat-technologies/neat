# Breaker round 2 — harvest report

10 shapes against the hardened `main` (`3478e50`, all 15 fixes): 3 verification + 7 new-territory. **7 high, 19 medium, 9 low new defects** — but the headline is the verifications.

## The fixes HOLD on real backends (the meta-lesson stuck)

Every round-1 fix verified end-to-end on a real backend, not just in unit tests:

| Fix | Shape | Verified |
|---|---|---|
| #598 OTLP decode | Python FastAPI + real pg, real OTel SDK, sampled spans | ✅ spans land, no 400, incidents + OBSERVED edge form |
| #602 fusion | same | ✅ runtime signal attaches to the one EXTRACTED node, no duplicate |
| #586 host-mismatch | same | ✅ fires at conf 1.0 once a real pg edge exists |
| #599 Python imports | same | ✅ resolves to the module file, not `__init__.py` |
| #589 cross-service RCA | 3-service mesh, deep failure in C | ✅ `root-cause(A)` localizes C's handler via the failing chain |
| #594 blast-radius inbound | same | ✅ `blast-radius(C)` returns dependents; entry service correctly empty |
| #590 loopback frontier | pg + loopback A→B | ✅ no phantom `frontier:localhost` |
| #591 host-drift dedup | same | ✅ one divergence, not three |
| (bonus) cross-language fusion | polyglot Node↔Python + shared pg | ✅ one graph, cross-language OBSERVED edge, RCA crosses the boundary |

**Unit-green translated to real-backend-correct.** That's the whole point of the campaign's test-strategy lesson landing.

## New defects — themes

- **Trace-stitcher corrupts provenance (HIGH → fix wave):** an error span makes `stitchTrace` rewrite EXTRACTED structural edges (CONTAINS/IMPORTS/CONFIGURED_BY) as INFERRED twins; consumer queries then surface the low-confidence twin. Downgrades the exact trust signal NEAT sells, on any 500. Recurs across shapes. `ingest.ts:899/1310` (filters provenance, not edge.type).
- **Async/queue is dark (HIGH → #614, extends #576):** the consumer gets zero OBSERVED edges (caller-only minting), async failures are never recorded (incidents are HTTP-status-only), RCA/blast-radius blind to the consumer, redis modeled as a generic DB.
- **GraphQL / WebSocket produce zero OBSERVED (HIGH/MED → #615/#617):** single-endpoint GraphQL collapses all operations; WS handlers never become graph nodes. Coverage frontier.
- **gRPC (MED → #616):** engages at service level, but all methods collapse to one edge, `.proto` not extracted, error detail lost to "unknown error".
- **`watch` re-extract crash (HIGH → fix wave):** crashes + corrupts the graph when an imported file is edited.
- **Fusion incident gap (HIGH → fix wave):** #602 reconciled edge nodes but not incident `affectedNode` or `evidence.file` — on a serverless-path deploy those point at phantom nodes.
- **Daemon (MED → fix wave):** a held OTLP port crashes the daemon (stepping covers REST only); `daemon.json` not written on `watch`/non-default port, so otel-init resolves the wrong OTLP endpoint.
- **Incident quality (MED/LOW → fix wave):** double events per failure, "unknown error" for non-HTTP failures, root-cause pairing a message with the total incident count.

## Disposition

- **Round-3 fix wave (bounded, in flight):** stitcher provenance, watch crash, fusion incident reconciliation, daemon OTLP port + daemon.json, incident quality.
- **Filed (coverage/architectural, roll into #576/#595):** #614 queue, #615 graphql, #616 grpc, #617 websocket.

## Verdict

The campaign's fixes are real and hold under real load — a genuinely strong signal. The remaining gaps are (a) one clear provenance bug (stitcher) now being fixed, (b) the OBSERVED-coverage frontier (queue/graphql/ws/grpc) which is the #576 architectural work, and (c) polish. NEAT is meaningfully more trustworthy than at campaign start; the coverage frontier is the road to HN-ready.
