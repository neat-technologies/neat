#!/usr/bin/env bash
# run.sh — host-side runner for the fresh-macOS-VM e2e pipeline.
#
# For each version in the matrix it: clones a virgin VM off neat-base, runs it
# headless with the repo mounted in, ssh's in to run scenario.sh, collects the
# artifacts (query outputs + screenshots + logs) the scenario wrote to the
# mount, then stops and DELETES the VM — every run gets a fresh Mac, every run
# kills itself. Teardown happens even on failure (trap), so a broken scenario
# never leaks a VM.
#
# Usage:
#   ./run.sh 0.4.18                 # one version
#   ./run.sh 0.4.16 0.4.17 0.4.18   # a version matrix
#   ./run.sh latest                 # whatever npm 'latest' points at
#
# Requires: Tart + a baked `neat-base` (run ./base-image.sh once first).
set -uo pipefail

# ── Config ─────────────────────────────────────────────────────────────────
BASE_VM="${BASE_VM:-neat-base}"
VM_USER="${VM_USER:-admin}"
VM_PASS="${VM_PASS:-admin}"          # cirrus base-image default creds; parameterize
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# Where collected artifacts land on the host. The scenario writes into the
# mounted repo's e2e/tart/artifacts/<version>/; we copy those out to here too so
# results survive even if the mount is read-only / transient.
HOST_ARTIFACTS="${HOST_ARTIFACTS:-$HERE/artifacts}"

VERSIONS=("$@")
if [ "${#VERSIONS[@]}" -eq 0 ]; then
  echo "usage: $0 <version> [version...]   e.g. $0 0.4.16 0.4.17 0.4.18" >&2
  exit 2
fi

say()  { printf '\n\033[1m[run] %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[run] %s\033[0m\n' "$*" >&2; }

command -v tart >/dev/null 2>&1 || { echo "tart not found (brew install cirruslabs/cli/tart)" >&2; exit 1; }
tart list | awk '{print $2}' | grep -qx "$BASE_VM" || {
  echo "base image '$BASE_VM' not found — run ./base-image.sh first" >&2; exit 1; }

# sshpass keeps the SSH non-interactive with the default creds. Fall back to a
# clear message if it isn't installed.
# PubkeyAuthentication=no + PreferredAuthentications=password force the password
# sshpass supplies and skip every agent/default key — otherwise ssh floods the VM
# with pubkey attempts and trips its MaxAuthTries ("Too many authentication
# failures") before the password is ever tried, an intermittent boot-time flake.
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10
          -o PubkeyAuthentication=no -o PreferredAuthentications=password)
if command -v sshpass >/dev/null 2>&1; then
  SSH() { sshpass -p "$VM_PASS" ssh "${SSH_OPTS[@]}" "$VM_USER@$1" "$2"; }
else
  warn "sshpass not installed — SSH steps will prompt for the '$VM_PASS' password each time."
  warn "install it for unattended matrix runs: brew install hudochenkov/sshpass/sshpass"
  SSH() { ssh "${SSH_OPTS[@]}" "$VM_USER@$1" "$2"; }
fi

# ── Per-version teardown, always runs ──────────────────────────────────────
CURRENT_VM=""
teardown_vm() {
  local vm="$1"
  [ -n "$vm" ] || return 0
  say "tearing down $vm (stop + delete — the VM kills itself)"
  tart stop "$vm" 2>/dev/null || true
  # stop is async; give it a beat, then force-delete.
  sleep 3
  tart delete "$vm" 2>/dev/null || true
}
# Trap covers Ctrl-C / unexpected exit mid-run so a VM is never orphaned.
trap 'teardown_vm "$CURRENT_VM"; exit 130' INT TERM

OVERALL_RC=0
declare -a RESULTS=()

# ── Per-version run ────────────────────────────────────────────────────────
run_one() {
  local version="$1"
  local vm="t-${version//[^a-zA-Z0-9]/-}"
  CURRENT_VM="$vm"
  local rc=0

  say "==== neat.is@$version  →  VM $vm ===="

  # Fresh clone off the virgin baseline.
  tart clone "$BASE_VM" "$vm" || { warn "clone failed for $vm"; RESULTS+=("$version: CLONE-FAIL"); CURRENT_VM=""; return 1; }

  # Boot headless with the repo mounted read-only at a named tag. Tart exposes
  # --dir mounts under /Volumes/My Shared Files/<tag> inside the VM. The
  # scenario reads the fixture + screenshot script from there and writes
  # artifacts back into the same tree (the mount is read-write unless :ro).
  say "booting $vm with the repo mounted (--dir neat:$REPO_ROOT)"
  tart run "$vm" --no-graphics --dir "neat:$REPO_ROOT" &
  local run_pid=$!

  # Wait for an IP.
  local ip=""
  for _ in $(seq 1 60); do
    ip="$(tart ip "$vm" 2>/dev/null || true)"
    [ -n "$ip" ] && break
    sleep 2
  done
  if [ -z "$ip" ]; then
    warn "$vm never got an IP"; RESULTS+=("$version: BOOT-FAIL")
    kill "$run_pid" 2>/dev/null || true
    teardown_vm "$vm"; CURRENT_VM=""; return 1
  fi
  say "$vm is up at $ip"

  # Wait for SSH to answer.
  local ssh_ok=0
  for _ in $(seq 1 30); do
    if SSH "$ip" "true" 2>/dev/null; then ssh_ok=1; break; fi
    sleep 2
  done
  [ "$ssh_ok" = "1" ] || { warn "ssh to $vm never came up"; RESULTS+=("$version: SSH-FAIL"); kill "$run_pid" 2>/dev/null||true; teardown_vm "$vm"; CURRENT_VM=""; return 1; }

  # Run the scenario inside the VM. It reads/writes the mount; --login so the
  # provisioned PATH (node@20, global playwright) is in scope.
  local mount='/Volumes/My Shared Files/neat'
  say "running scenario.sh inside $vm"
  # scenario.sh treats NEAT_MOUNT as the repo root and appends e2e/tart/... itself,
  # so pass the mount root here — suffixing /e2e/tart doubles the path.
  if SSH "$ip" "bash -lc 'export NEAT_MOUNT=\"$mount\"; chmod +x \"$mount/e2e/tart/scenario.sh\"; \"$mount/e2e/tart/scenario.sh\" $version'"; then
    say "$vm scenario PASSED"
    RESULTS+=("$version: PASS")
  else
    rc=$?
    warn "$vm scenario FAILED (rc=$rc)"
    RESULTS+=("$version: FAIL")
    OVERALL_RC=1
  fi

  # Collect artifacts. The scenario already wrote them into the mounted tree at
  # e2e/tart/artifacts/<version>/; mirror that into HOST_ARTIFACTS so results
  # outlive the VM and any per-run mount semantics.
  local src="$REPO_ROOT/e2e/tart/artifacts/$version"
  local dst="$HOST_ARTIFACTS/$version"
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    cp -R "$src/." "$dst/" 2>/dev/null || true
    say "artifacts collected → $dst"
    ls "$dst" 2>/dev/null | sed 's/^/    /'
  else
    warn "no artifacts found at $src (scenario may have died before writing)"
  fi

  # The VM kills itself.
  kill "$run_pid" 2>/dev/null || true
  teardown_vm "$vm"
  CURRENT_VM=""
  return "$rc"
}

mkdir -p "$HOST_ARTIFACTS"
for v in "${VERSIONS[@]}"; do
  run_one "$v" || true   # keep going through the matrix; OVERALL_RC tracks failures
done

# ── Matrix summary ─────────────────────────────────────────────────────────
say "==== MATRIX RESULTS ===="
for r in "${RESULTS[@]}"; do
  printf '    %s\n' "$r"
done
say "artifacts under: $HOST_ARTIFACTS"
exit "$OVERALL_RC"
