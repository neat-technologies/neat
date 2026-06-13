#!/usr/bin/env bash
# base-image.sh — one-time prep of the reusable virgin macOS base image.
#
# Bakes `neat-base`: a macOS VM that has Node 20.x, git, and Playwright's
# bundled chromium, and NOTHING from NEAT — no global neat, no ~/.neat, no built
# artifacts, no orphaned lock. Every `run.sh` clone starts from this exact
# virgin baseline, so the scenario exercises the genuine first-install path the
# maintainer's stateful dev machine masks.
#
# This script automates what it can from the host (clone, start, wait, stop).
# The provisioning *inside* the VM happens over SSH; those steps are spelled out
# as copy-pasteable blocks because they run against the VM's shell, not the
# host's. Run this once; thereafter `run.sh` reuses `neat-base`.
#
# Requires: Tart (`brew install cirruslabs/cli/tart`) and Apple Silicon.
set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:-ghcr.io/cirruslabs/macos-sequoia-base:latest}"
BASE_VM="${BASE_VM:-neat-base}"
VM_USER="${VM_USER:-admin}"
VM_PASS="${VM_PASS:-admin}"          # cirrus base-image default creds
NODE_MAJOR="${NODE_MAJOR:-20}"        # NEAT runs on Node 20.x

say() { printf '\n\033[1m[base-image] %s\033[0m\n' "$*"; }

# ── 0. Preflight ───────────────────────────────────────────────────────────
command -v tart >/dev/null 2>&1 || {
  echo "tart not found. Install it: brew install cirruslabs/cli/tart" >&2
  exit 1
}

# ── 1. Clone the cirrus base image to a working VM ─────────────────────────
if tart list | awk '{print $2}' | grep -qx "$BASE_VM"; then
  say "$BASE_VM already exists. Delete it first to rebuild: tart delete $BASE_VM"
  exit 0
fi
say "cloning $BASE_IMAGE → $BASE_VM (first pull is several GB; cached after)"
tart clone "$BASE_IMAGE" "$BASE_VM"

# ── 2. Boot it headless so we can SSH in to provision ──────────────────────
say "starting $BASE_VM (headless) to provision it"
tart run "$BASE_VM" --no-graphics &
TART_RUN_PID=$!
trap 'kill "$TART_RUN_PID" 2>/dev/null || true' EXIT

say "waiting for the VM to get an IP"
IP=""
for _ in $(seq 1 60); do
  IP="$(tart ip "$BASE_VM" 2>/dev/null || true)"
  [ -n "$IP" ] && break
  sleep 2
done
[ -n "$IP" ] || { echo "VM never got an IP" >&2; exit 1; }
say "VM is up at $IP"

# ── 3. Provision inside the VM over SSH ────────────────────────────────────
# Run the provisioning as one heredoc'd remote script. `sshpass` lets us pass
# the default admin/admin non-interactively; if you don't have it
# (`brew install sshpass` / hudochenkov tap), run the block manually — it's
# printed below for copy-paste.
REMOTE_PROVISION=$(cat <<'PROVISION'
set -euo pipefail
echo "[vm] provisioning virgin base"

# Homebrew ships preinstalled on the cirrus macOS images. Use it for node + git.
eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true

# Node 20.x — pin the major so the baseline matches NEAT's engines (>=20).
brew install node@20 git || true
# Put node@20 first on PATH for login shells.
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zprofile
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
echo "[vm] node: $(node -v)   npm: $(npm -v)   git: $(git --version)"

# Playwright + its bundled chromium. A fresh Mac has no system Chrome, so the
# screenshot step launches chromium specifically — install the browser binary
# now so it's baked into the image and not re-downloaded every run.
npm install -g playwright
npx --yes playwright install chromium
echo "[vm] chromium installed at: $(ls -d ~/Library/Caches/ms-playwright/chromium* 2>/dev/null | head -1)"

# Make absolutely sure the baseline carries NO NEAT state. Nothing should exist
# yet, but assert it — a dirty base image is the one thing that defeats this
# whole harness.
rm -rf ~/.neat
npm ls -g neat.is >/dev/null 2>&1 && npm uninstall -g neat.is || true
if command -v neat >/dev/null 2>&1; then
  echo "[vm] WARNING: a global 'neat' is still on PATH — remove it before baking" >&2
fi
echo "[vm] verified virgin: ~/.neat absent=$([ -e ~/.neat ] && echo NO || echo YES), global neat absent=$(command -v neat >/dev/null 2>&1 && echo NO || echo YES)"

echo "[vm] provisioning done"
PROVISION
)

if command -v sshpass >/dev/null 2>&1; then
  say "provisioning $BASE_VM over SSH (Node $NODE_MAJOR + git + chromium, clearing NEAT state)"
  sshpass -p "$VM_PASS" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$VM_USER@$IP" "bash -lc '$REMOTE_PROVISION'"
else
  cat <<EOF

  sshpass is not installed, so provisioning can't run automatically.
  Install it (brew install hudochenkov/sshpass/sshpass) and re-run, OR
  SSH in by hand and paste the provisioning block:

      ssh $VM_USER@$IP        # password: $VM_PASS

  Then run the block printed in this script's REMOTE_PROVISION heredoc
  (Node $NODE_MAJOR via 'brew install node@20', 'npm i -g playwright',
   'npx playwright install chromium', and 'rm -rf ~/.neat').

  When it finishes, come back here and press Enter to finalize the image.
EOF
  read -r -p "  Press Enter once you've provisioned the VM... " _
fi

# ── 4. Shut the VM down cleanly so the baked disk is consistent ────────────
say "stopping $BASE_VM to seal the baseline"
sshpass -p "$VM_PASS" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  "$VM_USER@$IP" "sudo shutdown -h now" 2>/dev/null || tart stop "$BASE_VM" || true

# Give it a moment to power off, then drop the trap-managed run process.
sleep 5
kill "$TART_RUN_PID" 2>/dev/null || true
trap - EXIT

say "done. '$BASE_VM' is a reusable virgin baseline: Node $NODE_MAJOR + git + chromium, no NEAT state."
say "Next: ./run.sh <version>   (e.g. ./run.sh 0.4.18)"
