#!/usr/bin/env bash
# e2e/capture/run.sh — the layered file-first capture smoke (file-awareness.md
# §4, ADR-090). Drives a self-contained service whose routes exercise every
# real auto-instrumentation tier, then asserts NEAT landed file-grained code.*
# on every emitted CLIENT/PRODUCER/SERVER span.
#
# Unlike e2e/brief this needs no external repo: the sample app lives under
# app/. The CI workflow stands up Postgres, installs the app, runs `neat init`
# to inject the layered otel-init, and starts the app. Locally, point
# CAPTURE_APP_BASE / NEAT_BASE at running instances.
set -euo pipefail

NEAT_BASE="${NEAT_BASE:-http://localhost:8080}"
CAPTURE_APP_BASE="${CAPTURE_APP_BASE:-http://127.0.0.1:8082}"
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HARNESS_DIR}/../.." && pwd)"
APP_DIR="${HARNESS_DIR}/app"

probe() {
  curl -sS --max-time 2 -o /dev/null -w "%{http_code}" "$1" 2>/dev/null || echo "000"
}

# Step 1 — neatd reachable?
if [[ "$(probe "${NEAT_BASE}/projects")" != "200" ]]; then
  echo "[run] neatd not reachable at ${NEAT_BASE} — start it (node packages/core/dist/cli.cjs) or set NEAT_BASE" >&2
  exit 2
fi

# Step 2 — capture app reachable?
if [[ "$(probe "${CAPTURE_APP_BASE}/health")" != "200" ]]; then
  echo "[run] capture app not reachable at ${CAPTURE_APP_BASE} — start it (npm --prefix ${APP_DIR} start) after \`neat init\`" >&2
  exit 3
fi

# Step 3 — discover the project name neat init registered for APP_DIR, so the
# assertions read the right graph regardless of how init derived it.
PROJECT="$(node -e '
  const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os");
  const reg = path.join(process.env.NEAT_HOME || path.join(os.homedir(), ".neat"), "projects.json");
  const want = path.resolve(process.argv[1]);
  try {
    const raw = JSON.parse(fs.readFileSync(reg, "utf8"));
    const entries = Array.isArray(raw) ? raw : (raw.projects || Object.values(raw));
    for (const e of entries) {
      const p = e && (e.path || e.root || e.dir);
      if (p && path.resolve(p) === want) { process.stdout.write(e.name || path.basename(p)); process.exit(0) }
    }
  } catch (_e) {}
  process.stdout.write(path.basename(want));
' "${APP_DIR}")"
echo "[run] capture project resolved to '${PROJECT}'"

if [[ "$(probe "${NEAT_BASE}/projects/${PROJECT}/graph")" != "200" ]]; then
  echo "[run] neatd has no '${PROJECT}' project — run \`node packages/core/dist/cli.cjs init ${APP_DIR}\` first" >&2
  exit 4
fi

# Step 4 — drive the tiers.
echo "[run] driving the capture app across all tiers"
( cd "${REPO_ROOT}" && CAPTURE_APP_BASE="${CAPTURE_APP_BASE}" npx tsx "${HARNESS_DIR}/load.ts" )

# Step 5 — assert file-grained code.* on every tier.
echo "[run] asserting file-first OBSERVED shape on /projects/${PROJECT}/graph"
( cd "${REPO_ROOT}" && NEAT_BASE="${NEAT_BASE}" CAPTURE_PROJECT="${PROJECT}" npx tsx "${HARNESS_DIR}/assertions.ts" )

echo "[run] PASS"
