# Wire incidents into your agent

`neat monitor --json` emits one line per new high-signal fact. Incident lines are
the full work-order card (ADR-221) — the incident fused with its root-cause chain,
blast radius, governing policies, and node divergence, each claim provenance-
stamped. Filter to `"kind":"incident"` and hand the card to an agent as its task.

The card is zero-fabrication: a missing locus is `null`, a missing cause is `null`,
and every chain hop carries its own provenance. Your agent should trust each claim
by its provenance (OBSERVED > INFERRED > STALE) and verify what it can't.

## Claude Code (the `monitors/` mechanism)

The NEAT plugin already runs `neat monitor`; each stdout line reaches the agent as
a mid-session notification, so an incident that lands while you work surfaces
before your next edit. Nothing to wire — the incident line joins the divergence,
stale, observed, and policy lines already on that stream.

## Any agent — pipe the JSON

```bash
neat monitor --json | while IFS= read -r line; do
  kind=$(printf '%s' "$line" | jq -r '.kind // empty')
  [ "$kind" = "incident" ] || continue

  # The card is a self-sufficient work order. Hand it to your agent verbatim.
  printf '%s' "$line" | jq . > /tmp/neat-incident.json
  your-agent --task "A production incident just fired. Here is the NEAT incident
  card — root cause, blast radius, governing policies, and node divergence, each
  claim provenance-stamped. Fix the defect at the locus. Trust OBSERVED hops;
  verify INFERRED ones. Card: $(cat /tmp/neat-incident.json)"
done
```

## Pull the same card on demand

An agent that would rather ask gets the identical card over MCP:

```
get_incident_card(nodeId: "service:api")            # the node's most recent incident
get_incident_card(nodeId: "service:api", errorId: "…")  # one specific incident
```

Both the push (above) and this pull read one composed endpoint,
`GET /graph/incident-card/:nodeId`, so they never disagree about what the card says.
