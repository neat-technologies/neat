#!/usr/bin/env bash
# PreToolUse hook for NEAT contracts.
# Wired in .claude/settings.json against Edit, Write, MultiEdit, and Read.
#
# Reads the tool payload from stdin, finds every contract in
# docs/contracts/*.md whose `governs:` frontmatter glob matches the target
# file path, and surfaces the match as additionalContext:
#   - on Edit / Write / MultiEdit: the full contract body — the binding rules
#     at the moment of writing.
#   - on Read: a concise pointer (name + one-line + path), so an agent reading
#     to understand the code knows it's governed, without burying it in the
#     full contract on every file it opens.
#
# Output is a JSON object keyed `hookSpecificOutput.additionalContext`.
# If no contracts match, the hook is a silent no-op (exit 0, empty output).

set -euo pipefail

INPUT=$(cat)

# Which tool fired — Read gets a concise pointer, edits get the full body.
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)

# Pick the file path off whichever shape the tool input arrived in.
# Edit / Write use file_path; MultiEdit nests edits but still has file_path.
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
CONTRACTS_DIR="$PROJECT_DIR/docs/contracts"

if [ ! -d "$CONTRACTS_DIR" ]; then
  exit 0
fi

# Make the file path relative to the project root for glob matching.
REL_PATH="${FILE_PATH#$PROJECT_DIR/}"

# Walk every contract file. Extract the `governs:` block from frontmatter.
# For each glob, test if REL_PATH matches via shell pattern.
RELEVANT=()
for contract in "$CONTRACTS_DIR"/*.md; do
  [ -f "$contract" ] || continue
  base=$(basename "$contract")
  # Skip the index and the hook itself; only per-topic contracts have governs.
  case "$base" in
    _*|index.md) continue ;;
  esac

  # Parse `governs:` frontmatter list. Frontmatter is between the first two
  # `---` lines. Lines under `governs:` look like `  - "packages/..."`.
  GLOBS=$(awk '
    /^---$/ { fm = !fm; next }
    fm && /^governs:/ { in_governs = 1; next }
    fm && in_governs && /^  - / {
      sub(/^  - /, "")
      gsub(/"/, "")
      print
      next
    }
    fm && in_governs && /^[a-z]/ { in_governs = 0 }
  ' "$contract")

  while IFS= read -r glob; do
    [ -z "$glob" ] && continue
    case "$REL_PATH" in
      $glob) RELEVANT+=("$contract"); break ;;
    esac
  done <<< "$GLOBS"
done

if [ ${#RELEVANT[@]} -eq 0 ]; then
  exit 0
fi

# Build the additionalContext payload. Edits get the full binding text; reads
# get a concise pointer so the agent stays contract-aware without the noise of
# the full contract on every file it opens.
if [ "$TOOL_NAME" = "Read" ]; then
  CONTEXT="This file is governed by binding NEAT contract(s), surfaced on read. Read the contract before changing the file:"$'\n'
  for c in "${RELEVANT[@]}"; do
    base=$(basename "$c")
    name=$(awk -F': ' '/^name:/ { print $2; exit }' "$c")
    desc=$(awk '/^description:/ { sub(/^description: */, ""); gsub(/^"|"$/, ""); print; exit }' "$c")
    CONTEXT+=$'\n'"- ${name:-$base} — docs/contracts/${base}"
    [ -n "$desc" ] && CONTEXT+=$'\n'"  ${desc}"
  done
else
  CONTEXT="The following NEAT contracts govern this file. Read them before editing — they are binding."$'\n'
  for c in "${RELEVANT[@]}"; do
    CONTEXT+=$'\n\n----\n\n'
    CONTEXT+="$(cat "$c")"
  done
fi

# Emit the structured PreToolUse response.
jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'
