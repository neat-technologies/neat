#!/usr/bin/env bash
#
# Local fallback for publishing the six NEAT packages to npm.
#
# Preferred path: tag push to GitHub triggers `.github/workflows/publish.yml`.
# Use this script only when CI isn't an option (offline, hotfix, debugging).
#
# Usage:
#   bash scripts/publish.sh              # publish for real
#   bash scripts/publish.sh --dry-run    # preflight + simulate, no publish
#
# Exits non-zero on any error. Idempotent — already-published versions are
# skipped, so re-running after a partial failure is safe.

set -euo pipefail

DRY_RUN="false"
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN="true"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Six packages that must share the same version on every release.
LOCKSTEP_PACKAGES=(
  "packages/types"
  "packages/core"
  "packages/mcp"
  "packages/claude-skill"
  "packages/web"
  "packages/neat.is"
)

# All packages to publish, in dependency order.
# @neat.is/instrumentation-registry is independently versioned (v1.x) but
# ships before core since core depends on it.
PACKAGES=(
  "packages/instrumentation-registry"
  "packages/types"
  "packages/core"
  "packages/mcp"
  "packages/claude-skill"
  "packages/web"
  "packages/neat.is"
)

# ── Preflight ────────────────────────────────────────────────────────────
echo "── preflight ──"

if ! npm whoami > /dev/null 2>&1; then
  echo
  echo "ERROR: not logged in to npm."
  echo "Run \`npm login\` (or refresh your token) and try again."
  echo "See docs/runbook-publish.md for one-time setup."
  exit 1
fi

WHOAMI=$(npm whoami)
echo "  npm user: ${WHOAMI}"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo
  echo "WARNING: not on main (you're on ${CURRENT_BRANCH})."
  echo "Publishing from a feature branch ships the wrong commit."
  read -r -p "Continue anyway? [y/N] " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    exit 1
  fi
fi

if [ -n "$(git status --porcelain)" ]; then
  echo
  echo "ERROR: working tree has uncommitted changes."
  echo "Commit or stash before publishing — published artifacts must match git state."
  exit 1
fi

# ── Version sync check ──────────────────────────────────────────────────
echo
echo "── versions ──"
VERSIONS=()
for pkg_dir in "${LOCKSTEP_PACKAGES[@]}"; do
  v=$(node -p "require('./${pkg_dir}/package.json').version")
  name=$(node -p "require('./${pkg_dir}/package.json').name")
  echo "  ${name}: ${v}"
  VERSIONS+=("$v")
done

UNIQUE_COUNT=$(printf '%s\n' "${VERSIONS[@]}" | sort -u | wc -l | tr -d ' ')
if [ "$UNIQUE_COUNT" != "1" ]; then
  echo
  echo "ERROR: package versions are not in lockstep."
  echo "All six packages must share the same version. Bump and try again."
  exit 1
fi

# ── Build + test gate ───────────────────────────────────────────────────
echo
echo "── build / test / lint ──"
npx turbo build test lint

# ── Publish ─────────────────────────────────────────────────────────────
echo
echo "── publish ──"
PUBLISHED=()
SKIPPED=()

for pkg_dir in "${PACKAGES[@]}"; do
  pkg_name=$(node -p "require('./${pkg_dir}/package.json').name")
  pkg_version=$(node -p "require('./${pkg_dir}/package.json').version")

  echo
  echo "${pkg_name}@${pkg_version}"

  if npm view "${pkg_name}@${pkg_version}" version > /dev/null 2>&1; then
    echo "  already on registry, skipping"
    SKIPPED+=("$pkg_name")
    continue
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "  DRY RUN — would publish"
    ( cd "$pkg_dir" && npm publish --dry-run )
    continue
  fi

  ( cd "$pkg_dir" && npm publish )
  echo "  published"
  PUBLISHED+=("$pkg_name")
done

# ── Summary ─────────────────────────────────────────────────────────────
echo
echo "── summary ──"
if [ "$DRY_RUN" = "true" ]; then
  echo "  dry run complete (no packages published)"
else
  echo "  published: ${#PUBLISHED[@]}"
  for p in "${PUBLISHED[@]}"; do echo "    - $p"; done
  echo "  skipped:   ${#SKIPPED[@]}"
  for p in "${SKIPPED[@]}"; do echo "    - $p"; done
fi
