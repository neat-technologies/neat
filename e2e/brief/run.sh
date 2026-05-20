#!/usr/bin/env bash
# e2e/brief/run.sh — drives Brief, asserts OBSERVED edges land in neatd's graph.
# See docs/contracts/observed-e2e.md for the contract this enforces.
set -euo pipefail

NEAT_BASE="${NEAT_BASE:-http://localhost:8080}"
BRIEF_BASE="${BRIEF_BASE:-http://localhost:8081}"
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HARNESS_DIR}/../.." && pwd)"

SPAWNED_NEATD_PID=""
SPAWNED_BRIEF_PID=""

cleanup() {
  if [[ -n "${SPAWNED_BRIEF_PID}" ]]; then
    kill "${SPAWNED_BRIEF_PID}" 2>/dev/null || true
  fi
  if [[ -n "${SPAWNED_NEATD_PID}" ]]; then
    kill "${SPAWNED_NEATD_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

probe() {
  curl -sS --max-time 2 -o /dev/null -w "%{http_code}" "$1" 2>/dev/null || echo "000"
}

wait_for() {
  local url="$1"
  local label="$2"
  local budget_s="${3:-60}"
  local deadline=$(( $(date +%s) + budget_s ))
  while (( $(date +%s) < deadline )); do
    local code
    code="$(probe "${url}")"
    if [[ "${code}" =~ ^[23] || "${code}" == "404" ]]; then
      # 404 is fine for the /projects/brief/graph probe when the project
      # hasn't bootstrapped yet — keep waiting unless 2xx.
      if [[ "${code}" =~ ^[23] ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "[run] timed out waiting for ${label} at ${url}" >&2
  return 1
}

# Step 1 — neatd up?
if [[ "$(probe "${NEAT_BASE}/projects")" != "200" ]]; then
  echo "[run] neatd not reachable at ${NEAT_BASE}; spawning"
  HOST=127.0.0.1 neatd start > /tmp/neatd.e2e.log 2>&1 &
  SPAWNED_NEATD_PID=$!
  wait_for "${NEAT_BASE}/projects" "neatd /projects" 60
fi

# Step 2 — Brief up?
if [[ "$(probe "${BRIEF_BASE}/health")" != "200" ]]; then
  echo "[run] Brief not reachable at ${BRIEF_BASE}; expected to be running" >&2
  echo "[run] start Brief from its api/ checkout (npm run dev) before re-running, or set BRIEF_BASE" >&2
  exit 2
fi

# Step 3 — verify the brief project is loaded in neatd's registry.
if [[ "$(probe "${NEAT_BASE}/projects/brief/graph")" != "200" ]]; then
  echo "[run] neatd has no 'brief' project — run \`neat init /path/to/Brief\` first" >&2
  exit 3
fi

# Step 4 — run the load generator.
echo "[run] driving Brief with the load generator"
( cd "${REPO_ROOT}" && npx tsx "${HARNESS_DIR}/load.ts" )

# Step 5 — assertions (with its own poll budget).
echo "[run] asserting OBSERVED shape on /projects/brief/graph"
( cd "${REPO_ROOT}" && npx tsx "${HARNESS_DIR}/assertions.ts" )

echo "[run] PASS"
