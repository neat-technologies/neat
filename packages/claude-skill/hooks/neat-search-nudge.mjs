#!/usr/bin/env node
// NEAT search-nudge — a Claude Code PreToolUse hook.
//
// When the agent reaches for raw text search — the Grep or Glob tools, or a
// Bash command that shells out to grep / rg / ag / ack / find / fd — this hook
// injects a short note suggesting NEAT's graph tools first. NEAT already holds
// this project's structure, dependencies, and runtime behaviour, so a graph
// query is usually faster and more accurate than scanning files by hand.
//
// It is a NUDGE, not a gate. The hook only ever adds context; it never denies
// the call and always exits 0, so the search runs regardless. Anything that is
// not a text search is a silent no-op.
//
// Wired by `neat hooks --apply`, which copies this script under ~/.neat/hooks/
// and adds a PreToolUse entry to ~/.claude/settings.json. The hook itself is
// Claude-Code-specific; agents on other harnesses get the same steer from the
// graph-first guidance NEAT ships instead (see `neat hooks --print-guide`).
//
// This file is a documentation copy. The source of truth is NEAT_SEARCH_HOOK
// in @neat.is/core (packages/core/src/hooks-cli.ts); a contract test keeps the
// two byte-aligned.

import process from 'node:process'

// grep-family and file-finder binaries. Matched at a word boundary so a path
// like agent.ts does not trip it, and after a shell separator so the binary in
// a pipe (... | grep foo) still counts.
const SEARCH_BINARY = /(?:^|[\s|;&(){}])(?:grep|egrep|fgrep|rg|ripgrep|ag|ack|find|fd)(?=\s|$)/

function bashLooksLikeSearch(command) {
  return typeof command === 'string' && SEARCH_BINARY.test(command)
}

function nudge(toolName) {
  return [
    'NEAT is wired into this project — its live graph already knows this codebase',
    'structure, dependencies, and runtime behaviour. Before leaning on ' + toolName + ', consider',
    'asking the graph over MCP; it answers with structured, provenance-tagged results',
    'rather than line matches:',
    '',
    '  - semantic_search — find code/nodes by a natural-language description',
    '  - get_dependencies / get_observed_dependencies — what a thing calls, as declared',
    '    in code (EXTRACTED) vs. what it actually calls in production (OBSERVED)',
    '  - get_divergences — where the code and production disagree',
    '  - get_root_cause / get_blast_radius — trace a failure, or a change reach',
    '',
    'Text search is still a fine fallback — go ahead and run it if the graph does not',
    'have what you need.',
  ].join('\n')
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

const raw = await readStdin()

let payload
try {
  payload = JSON.parse(raw)
} catch {
  // No parseable payload — nothing to nudge about. Let the call proceed.
  process.exit(0)
}

const toolName = typeof payload?.tool_name === 'string' ? payload.tool_name : ''
const toolInput = payload?.tool_input ?? {}

let isSearch = false
if (toolName === 'Grep' || toolName === 'Glob') isSearch = true
else if (toolName === 'Bash') isSearch = bashLooksLikeSearch(toolInput.command)

if (!isSearch) process.exit(0)

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: nudge(toolName),
    },
  }),
)
process.exit(0)
