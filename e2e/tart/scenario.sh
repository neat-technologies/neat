#!/usr/bin/env bash
# scenario.sh — runs INSIDE the Tart VM (a virgin macOS install).
#
# This is the fresh-install path the maintainer's stateful dev machine masks.
# On a virgin Mac there is no global neat, no ~/.neat, no built artifacts, no
# orphaned lock — so this exercises the genuine `npx neat.is@<version>` UX a new
# user gets, and asserts the graph it produces. run.sh ssh's in and runs this.
#
# Usage (inside the VM):
#   scenario.sh <version>
#     <version>  the neat.is version to test, e.g. 0.4.18 (or "latest").
#
# It reads the repo + fixture from the read-only host mount and writes all
# artifacts (query outputs, logs, screenshots, a PASS/FAIL summary) to the
# mounted artifacts dir so run.sh can collect them on the host after teardown.
set -uo pipefail

VERSION="${1:?usage: scenario.sh <version>}"

# ── Layout ────────────────────────────────────────────────────────────────
# The host mounts the repo root read-only at MOUNT (default /Volumes/My Shared
# Files, Tart's --dir mount point). The fixture lives under it; artifacts are
# written to a per-version subdir of the mount's `artifacts/`.
MOUNT="${NEAT_MOUNT:-/Volumes/My Shared Files/neat}"
FIXTURE_SRC="${NEAT_FIXTURE_SRC:-$MOUNT/e2e/tart/fixture}"
ARTIFACTS="${NEAT_ARTIFACTS:-$MOUNT/e2e/tart/artifacts/$VERSION}"
SCREENSHOT_MJS="${NEAT_SCREENSHOT:-$MOUNT/e2e/tart/screenshot.mjs}"

# Work happens in a writable temp dir — the mount may be read-only, and we want
# a virgin copy of the fixture each run.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/neat-tart-XXXXXX")"
FIXTURE="$WORK/fixture"

# Canonical local ports. In a fresh VM there is exactly one daemon, so the
# defaults are free and the orchestrator takes them.
REST_PORT="${PORT:-8080}"
WEB_PORT="${NEAT_WEB_PORT:-6328}"
APP_PORT="${FIXTURE_APP_PORT:-9099}"   # the fixture's own port (not a NEAT port)
# The CLI reaches the daemon at this URL (NEAT_API_URL); default is fine for the
# single-daemon fresh VM.
export NEAT_API_URL="${NEAT_API_URL:-http://localhost:$REST_PORT}"

# Loopback dev surface: the orchestrator pins the daemon to 127.0.0.1 with no
# token, so the REST API is open server-side — but the dashboard's client-side
# auth gate still redirects to /login unless the daemon reports publicRead. We
# export NEAT_PUBLIC_READ=true so the daemon the orchestrator spawns serves the
# no-login dashboard the headless screenshot needs. (The daemon inherits this
# from the orchestrator's process env.)
export NEAT_PUBLIC_READ="${NEAT_PUBLIC_READ:-true}"

mkdir -p "$ARTIFACTS"
SUMMARY="$ARTIFACTS/summary.txt"
: > "$SUMMARY"

PASS=0
FAIL=0
APP_PID=0
note() { echo "$*" | tee -a "$SUMMARY"; }
pass() { PASS=$((PASS + 1)); note "PASS  $*"; }
fail() { FAIL=$((FAIL + 1)); note "FAIL  $*"; }

# Final teardown + report. Defined early so any step can bail out through it.
finish() {
  note ""
  kill "${APP_PID:-0}" 2>/dev/null || true
  note "=== SUMMARY · neat.is@$VERSION · PASS=$PASS FAIL=$FAIL ==="
  rm -rf "$WORK" 2>/dev/null || true
  if [ "$FAIL" -gt 0 ]; then
    note "RESULT: FAIL"
    exit 1
  fi
  note "RESULT: PASS"
  exit 0
}

note "=== NEAT Tart fresh-VM scenario · neat.is@$VERSION · $(date -u +%FT%TZ) ==="
note "node: $(node -v 2>/dev/null)   npm: $(npm -v 2>/dev/null)"
note "work dir: $WORK"
note "artifacts: $ARTIFACTS"
note ""

# A fresh VM should have NO prior NEAT state. Record it as evidence — this is
# the whole point of the harness (the stateful-machine masking the first-run
# bug class). A non-empty ~/.neat here means the base image wasn't clean.
if [ -e "$HOME/.neat" ]; then
  fail "fresh-state: ~/.neat already exists on this VM — base image is not virgin"
  ls -la "$HOME/.neat" >> "$SUMMARY" 2>&1 || true
else
  pass "fresh-state: no ~/.neat (virgin VM, first-install path)"
fi
if command -v neat >/dev/null 2>&1; then
  fail "fresh-state: a global 'neat' is on PATH — base image is not virgin"
else
  pass "fresh-state: no global neat (npx pulls the pinned version)"
fi
note ""

# ── 1. Copy the fixture off the read-only mount into a writable dir ─────────
note "[1] copying fixture → $FIXTURE"
mkdir -p "$FIXTURE"
# Copy source only — never the host's node_modules / neat-out / artifacts.
( cd "$FIXTURE_SRC" && cp package.json server.cjs "$FIXTURE/" ) || {
  fail "copy: could not read fixture from $FIXTURE_SRC"; finish; }
pass "copy: fixture staged"

# ── 2. The headline one-command flow ───────────────────────────────────────
# `npx neat.is@<version> <path>` is the real first-run UX: it discovers,
# extracts, instruments (writes otel-init + patches package.json), spawns the
# daemon, and opens the dashboard on :6328 with the loopback no-token surface.
# We capture its full output — the banner, the summary, and the token line —
# as the artifact a new user would see.
note ""
note "[2] npx neat.is@$VERSION $FIXTURE  (one-command flow)"
# --no-open: the VM is headless; we drive the dashboard with Playwright instead.
( cd "$FIXTURE" && npx -y "neat.is@$VERSION" "$FIXTURE" --no-open ) \
  > "$ARTIFACTS/01-npx-neat.log" 2>&1
ORCH_RC=$?
tail -40 "$ARTIFACTS/01-npx-neat.log" | sed 's/^/  /' >> "$SUMMARY"
if [ "$ORCH_RC" -eq 0 ]; then
  pass "orchestrator: npx neat.is@$VERSION exited 0"
else
  fail "orchestrator: npx neat.is@$VERSION exited $ORCH_RC (see 01-npx-neat.log)"
fi

# The orchestrator patches package.json with the OTel deps but leaves the
# install to the user ("Run npm install afterwards"). Do it so otel-init can
# load @opentelemetry/sdk-node when the app boots.
note ""
note "[2b] npm install (picks up the OTel deps neat added)"
( cd "$FIXTURE" && npm install --no-audit --no-fund ) > "$ARTIFACTS/02-npm-install.log" 2>&1 \
  && pass "install: OTel deps installed" \
  || fail "install: npm install failed (see 02-npm-install.log)"

# Resolve the project name the orchestrator registered (basename of the dir).
PROJECT="$(node -e '
  const fs=require("fs"),path=require("path"),os=require("os");
  const reg=path.join(process.env.NEAT_HOME||path.join(os.homedir(),".neat"),"projects.json");
  const want=path.resolve(process.argv[1]);
  try{const raw=JSON.parse(fs.readFileSync(reg,"utf8"));
    const es=Array.isArray(raw)?raw:(raw.projects||Object.values(raw));
    for(const e of es){const p=e&&(e.path||e.root||e.dir);
      if(p&&path.resolve(p)===want){process.stdout.write(e.name||path.basename(p));process.exit(0)}}
  }catch(_e){}
  process.stdout.write(path.basename(want));
' "$FIXTURE")"
note "project registered as: $PROJECT"

# Wait for the daemon REST to answer (the orchestrator detaches it).
note ""
note "[2c] waiting for daemon REST on :$REST_PORT"
DAEMON_UP=0
for i in $(seq 1 30); do
  code="$(curl -sS --max-time 1 -o /dev/null -w '%{http_code}' "$NEAT_API_URL/projects" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then DAEMON_UP=1; break; fi
  sleep 1
done
[ "$DAEMON_UP" = "1" ] && pass "daemon: REST answering on :$REST_PORT" \
  || fail "daemon: REST never came up on :$REST_PORT"

# ── 3. Start the instrumented fixture app ──────────────────────────────────
note ""
note "[3] starting the instrumented fixture on :$APP_PORT"
# The fixture calls its stub by a NON-loopback name so NEAT forms a real
# CALLS->frontier edge (a 127.0.0.1 peer is deliberately suppressed — see the
# fixture header + ingest.ts isLoopbackHost, issues #590/#577). Map that name to
# loopback where the stub actually binds. This is a throwaway VM, so editing
# /etc/hosts is safe; sudo -n avoids hanging if a password were somehow required.
UPSTREAM_HOST="upstream.neat.local"
if ! grep -q "$UPSTREAM_HOST" /etc/hosts 2>/dev/null; then
  echo "127.0.0.1 $UPSTREAM_HOST" | sudo -n tee -a /etc/hosts >/dev/null 2>&1 \
    && note "    mapped $UPSTREAM_HOST -> 127.0.0.1 (so the CALLS->frontier edge forms)" \
    || note "    WARN: could not add $UPSTREAM_HOST to /etc/hosts — the CALLS edge may not form"
fi
(
  cd "$FIXTURE" || exit 1
  PORT_APP="$APP_PORT" STUB_PORT="$((APP_PORT + 1))" \
  NODE_OPTIONS="--require $FIXTURE/otel-init.cjs" \
    node server.cjs
) > "$ARTIFACTS/03-fixture-app.log" 2>&1 &
APP_PID=$!
# Wait for /health.
APP_UP=0
for i in $(seq 1 20); do
  code="$(curl -sS --max-time 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/health" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then APP_UP=1; break; fi
  sleep 1
done
[ "$APP_UP" = "1" ] && pass "app: fixture answering /health on :$APP_PORT" \
  || fail "app: fixture never answered /health (see 03-fixture-app.log)"

# ── 4. Drive traffic so every tier emits spans ─────────────────────────────
note ""
note "[4] driving traffic (8 iterations across all routes)"
for i in $(seq 1 8); do
  for r in /quote /enrich /items /report; do
    curl -sS -o /dev/null --max-time 4 "http://127.0.0.1:$APP_PORT$r"
  done
  curl -sS -o /dev/null --max-time 4 -X POST -H 'content-type: application/json' \
    -d "{\"name\":\"run-$i\"}" "http://127.0.0.1:$APP_PORT/items"
done
pass "traffic: drove 8x5 requests"

# Let the OTel batch span processor flush to the daemon.
note "    waiting 10s for span batch flush"
sleep 10

# ── 5. The series of NEAT operations and queries ───────────────────────────
note ""
note "[5] NEAT operations and queries"

# The virgin VM installed NEAT via `npx neat.is@$VERSION` — there is no global
# `neat` on PATH, and the orchestrator doesn't add one. Invoke the CLI the same
# way a first-time user's later commands would: through npx, which serves it from
# the cache step [2] already populated (offline-fast). The query verbs are daemon
# clients and reach the running daemon at NEAT_API_URL (:8080) with no --project,
# exercising the bare-verb single-project resolution.
NEAT() { npx -y "neat.is@$VERSION" "$@"; }

# 5a. Bare-verb resolution — `neat divergences` with NO --project must resolve
# to the single registered project, not 404. This is exactly the bare-verb fix.
note ""
note "[5a] neat divergences  (BARE verb — no --project; the bare-verb fix)"
DIV_OUT="$ARTIFACTS/05a-divergences.txt"
NEAT divergences > "$DIV_OUT" 2>&1
DIV_RC=$?
NEAT divergences --json > "$ARTIFACTS/05a-divergences.json" 2>&1 || true
sed 's/^/  /' "$DIV_OUT" | head -20 >> "$SUMMARY"
if [ "$DIV_RC" -eq 0 ] && ! grep -qiE '404|not found|several projects|could not pick|pass --project' "$DIV_OUT"; then
  pass "divergences: bare verb resolved to '$PROJECT' (no 404, no ambiguity)"
else
  fail "divergences: bare verb did not resolve cleanly (rc=$DIV_RC — see 05a)"
fi

# 5b. semantic search — a term that exists in the graph.
note ""
note "[5b] neat search server"
NEAT search server > "$ARTIFACTS/05b-search.txt" 2>&1 \
  && pass "search: returned (rc 0)" \
  || fail "search: non-zero exit (see 05b)"
sed 's/^/  /' "$ARTIFACTS/05b-search.txt" | head -10 >> "$SUMMARY"

# Pick a real node id from the graph for the traversal verbs — the fixture's
# server file node, which carries both OBSERVED outbound edges.
GRAPH_JSON="$ARTIFACTS/graph.json"

# Fetch the project graph across both REST shapes:
#   - current dual-mount model: the project lives at /projects/<name>/graph,
#     and the bare /graph resolves to a (possibly absent) `default` project,
#     which returns an empty {nodes:[],edges:[]} — valid JSON but zero nodes.
#   - per-project-daemon model: the daemon IS the project, so the bare /graph
#     carries it and there is no /projects/<name> prefix.
# So we can't trust "valid JSON" — we accept a graph only once it has nodes,
# trying the prefixed route first, then the bare root. Whichever yields nodes
# wins, keeping the harness green across the refactor.
graph_has_nodes() {
  node -e 'try{const g=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit((g.nodes&&g.nodes.length>0)?0:1)}catch(_e){process.exit(1)}' "$1" 2>/dev/null
}
: > "$GRAPH_JSON"
for url in "$NEAT_API_URL/projects/$PROJECT/graph" "$NEAT_API_URL/graph"; do
  if curl -sS --max-time 5 "$url" -o "$GRAPH_JSON" 2>/dev/null && graph_has_nodes "$GRAPH_JSON"; then
    note "graph fetched from: $url"
    break
  fi
done
NODE_ID="$(node -e '
  try{const g=JSON.parse(require("fs").readFileSync(process.argv[1]));
    const n=(g.nodes||[]).find(x=>x.id&&x.id.indexOf("server.cjs")!==-1)
          ||(g.nodes||[]).find(x=>x.id&&x.id.startsWith("file:"));
    process.stdout.write(n?n.id:"");
  }catch(_e){process.stdout.write("")}
' "$GRAPH_JSON")"
note "node id for traversals: ${NODE_ID:-<none found>}"

# 5c. root-cause — exercises the inbound traversal. A healthy node legitimately
# has no root cause, so we assert the verb runs cleanly, not that it finds one.
note ""
note "[5c] neat root-cause $NODE_ID"
if [ -n "$NODE_ID" ]; then
  NEAT root-cause "$NODE_ID" > "$ARTIFACTS/05c-root-cause.txt" 2>&1 \
    && pass "root-cause: ran (rc 0)" \
    || fail "root-cause: non-zero exit (see 05c)"
  sed 's/^/  /' "$ARTIFACTS/05c-root-cause.txt" | head -8 >> "$SUMMARY"
else
  fail "root-cause: no node id resolved from the graph"
fi

# 5d. blast-radius — INBOUND dependents ("what breaks if this node changes"),
# not a downstream walk. The sharp demonstration is the shared database: its
# blast radius is every node that depends on it — the file that opens the
# connection and, keeping CONTAINS (file-awareness §36), that file's owning
# service. Resolve the OBSERVED database node the traffic just minted and assert
# the owning service surfaces as a dependent.
note ""
DB_NODE_ID="$(node -e '
  try{const g=JSON.parse(require("fs").readFileSync(process.argv[1]));
    const n=(g.nodes||[]).find(x=>x.id&&x.id.startsWith("database:"));
    process.stdout.write(n?n.id:"");
  }catch(_e){process.stdout.write("")}
' "$GRAPH_JSON")"
note "[5d] neat blast-radius $DB_NODE_ID  (dependents of the shared database)"
if [ -n "$DB_NODE_ID" ]; then
  NEAT blast-radius "$DB_NODE_ID" > "$ARTIFACTS/05d-blast-radius.txt" 2>&1
  BR_RC=$?
  sed 's/^/  /' "$ARTIFACTS/05d-blast-radius.txt" | head -10 >> "$SUMMARY"
  if [ "$BR_RC" -eq 0 ] && grep -qE 'service:neat-tart-fixture' "$ARTIFACTS/05d-blast-radius.txt"; then
    pass "blast-radius: the db's dependents reached the owning service"
  else
    fail "blast-radius: rc=$BR_RC or owning service absent from the db's blast radius (see 05d)"
  fi
else
  fail "blast-radius: no database node resolved from the graph"
fi

# ── 6. The correctness core — assert OBSERVED edges exist (>0) ─────────────
# This is the same shape e2e/capture asserts: read the graph from REST and
# require OBSERVED edges. We require both an outbound CALLS (frontier) and a
# CONNECTS_TO (database), file-grained where the call-site processor landed.
note ""
note "[6] OBSERVED-edge assertion (the correctness core)"
OBS_REPORT="$(node -e '
  let g;
  try{ g = JSON.parse(require("fs").readFileSync(process.argv[1])); }
  catch(e){ console.log("ERR could not read graph: "+e.message); process.exit(3); }
  const edges = g.edges||[];
  const obs = edges.filter(e=>e.provenance==="OBSERVED");
  const calls = obs.filter(e=>e.type==="CALLS");
  const conn  = obs.filter(e=>e.type==="CONNECTS_TO");
  console.log("observed_total="+obs.length);
  console.log("observed_calls="+calls.length);
  console.log("observed_connects_to="+conn.length);
  for(const e of obs.slice(0,12)) console.log("  "+e.type+" "+e.source+" -> "+e.target+" spans="+((e.signal&&e.signal.spanCount)||"?"));
  if(obs.length===0){ console.log("VERDICT fail-no-observed"); process.exit(1); }
  if(calls.length===0){ console.log("VERDICT fail-no-calls"); process.exit(1); }
  if(conn.length===0){ console.log("VERDICT fail-no-connects"); process.exit(1); }
  console.log("VERDICT ok");
' "$GRAPH_JSON" 2>&1)"
OBS_RC=$?
echo "$OBS_REPORT" | sed 's/^/  /' | tee -a "$SUMMARY"
echo "$OBS_REPORT" > "$ARTIFACTS/06-observed.txt"
if [ "$OBS_RC" -eq 0 ]; then
  pass "observed: >0 OBSERVED edges, incl. CALLS->frontier and CONNECTS_TO->database"
else
  fail "observed: assertion failed (see 06-observed.txt — VERDICT line)"
fi

# ── 7. Dashboard screenshots (Playwright chromium) ─────────────────────────
note ""
note "[7] dashboard screenshots → $ARTIFACTS"
if [ -f "$SCREENSHOT_MJS" ]; then
  # Run from a dir where 'playwright' resolves. The base image installs
  # playwright globally; link it in if a local resolve is needed.
  node "$SCREENSHOT_MJS" \
    --url "http://localhost:$WEB_PORT" \
    --out "$ARTIFACTS" \
    --project "$PROJECT" > "$ARTIFACTS/07-screenshot.log" 2>&1 || true
  SHOTS="$(ls "$ARTIFACTS"/*.png 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${SHOTS:-0}" -ge 1 ]; then
    pass "screenshots: captured $SHOTS PNG(s)"
  else
    # Screenshots are best-effort; a miss is a warning, not a hard fail.
    note "WARN  screenshots: none captured (see 07-screenshot.log)"
  fi
else
  note "WARN  screenshots: $SCREENSHOT_MJS not found on the mount — skipping"
fi

# ── 8. Tear down the fixture app and report ────────────────────────────────
finish
