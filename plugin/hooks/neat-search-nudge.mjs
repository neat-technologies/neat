#!/usr/bin/env node
// NEAT search hook — a Claude Code PreToolUse hook with two modes.
//
// When the agent reaches for raw text search — the Grep or Glob tools, or a
// Bash command that shells out to grep / rg / ag / ack / find / fd — this hook
// steers it to NEAT's graph first. NEAT already holds this project's structure,
// dependencies, and runtime behaviour, so a graph query is usually faster and
// more accurate than scanning files by hand.
//
//   NUDGE (default) — injects a short "ask the graph first" note and always lets
//     the search run. It never denies; anything that is not a text search is a
//     silent no-op.
//
//   GATE (opt-in) — DENIES Grep / Glob / grep-family Bash until `neat ask` (the
//     `mcp__neat__ask` tool or a Bash `neat ask …`) has run at least once this
//     session, forcing the graph-first orientation. Once the graph has been
//     consulted, search is allowed as a fallback and the nudge rides along
//     (we gate the orientation, not every search forever). State is a per-session
//     marker under ~/.neat/hooks/gate/, keyed by session_id, since each hook call
//     is a fresh process.
//
// Gate is enabled by `neat hooks --apply --gate` (which persists a flag at
// ~/.neat/hooks/gate-enabled) and/or the env toggle NEAT_SEARCH_GATE=1;
// NEAT_SEARCH_GATE=0 forces nudge-only even when the flag is set.
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
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// grep-family and file-finder binaries. Matched at a word boundary so a path
// like agent.ts does not trip it, and after a shell separator so the binary in
// a pipe (... | grep foo) still counts.
const SEARCH_BINARY = /(?:^|[\s|;&(){}])(?:grep|egrep|fgrep|rg|ripgrep|ag|ack|find|fd)(?=\s|$)/
// `neat ask …` in a Bash command — the CLI form of consulting the graph.
const ASK_BASH = /(?:^|[\s|;&(){}])neat\s+ask\b/

function bashLooksLikeSearch(command) {
  return typeof command === 'string' && SEARCH_BINARY.test(command)
}

// ~/.neat, overridable via NEAT_HOME (matches the CLI + tests).
function neatHome() {
  const override = process.env.NEAT_HOME
  return override && override.length > 0 ? path.resolve(override) : path.join(os.homedir(), '.neat')
}

// Gate on when NEAT_SEARCH_GATE=1, or when `neat hooks --apply --gate` persisted
// the flag. NEAT_SEARCH_GATE=0 forces it off regardless. Default: nudge only.
function gateEnabled() {
  const env = process.env.NEAT_SEARCH_GATE
  if (env === '0') return false
  if (env === '1') return true
  try {
    return fs.existsSync(path.join(neatHome(), 'hooks', 'gate-enabled'))
  } catch {
    return false
  }
}

// Per-session "ask has run" marker. The first `ask` writes it; every search
// reads it. session_id scopes the gate to one Claude Code session.
function markerFor(sessionId) {
  const safe = (sessionId || 'nosession').replace(/[^\w.-]/g, '_')
  return path.join(neatHome(), 'hooks', 'gate', `ask-ran-${safe}`)
}
function askHasRun(sessionId) {
  try {
    return fs.existsSync(markerFor(sessionId))
  } catch {
    return false
  }
}
function recordAskRan(sessionId) {
  try {
    const p = markerFor(sessionId)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, new Date().toISOString())
  } catch {
    // best-effort — a missing marker just means the gate stays closed
  }
}

function nudge(toolName) {
  return [
    'NEAT is wired into this project — its live graph already knows this codebase',
    'structure, dependencies, and runtime behaviour. Before leaning on ' + toolName + ', consider',
    'asking the graph over MCP; it answers with structured, provenance-tagged results',
    'rather than line matches:',
    '',
    '  - ask — one plain-language question, routed to the right graph query',
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

function denyReason(toolName) {
  return (
    'NEAT gate: consult the graph before text search. Call `neat ask "<your question>"` ' +
    '(or the `ask` MCP tool) first — it resolves the entities in your question and answers ' +
    'with structured, provenance-tagged facts (EXTRACTED from code, OBSERVED from runtime), ' +
    'faster and with production truth that ' + (toolName || 'grep') + ' cannot see. After you have ' +
    'asked the graph once this session, text search is available as a fallback for what the graph ' +
    'does not model (comments, string literals, config minutiae).'
  )
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
  // No parseable payload — nothing to act on. Let the call proceed.
  process.exit(0)
}

const toolName = typeof payload?.tool_name === 'string' ? payload.tool_name : ''
const toolInput = payload?.tool_input ?? {}
const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : ''

// 1. Did the agent consult the graph? Any `ask` — the MCP tool or the CLI verb —
//    opens the gate for the rest of this session.
const isAsk =
  toolName === 'mcp__neat__ask' ||
  toolName === 'ask' ||
  (toolName === 'Bash' && typeof toolInput.command === 'string' && ASK_BASH.test(toolInput.command))
if (isAsk) {
  recordAskRan(sessionId)
  process.exit(0)
}

// 2. Is this a raw text search? Anything else is a silent no-op.
let isSearch = false
if (toolName === 'Grep' || toolName === 'Glob') isSearch = true
else if (toolName === 'Bash') isSearch = bashLooksLikeSearch(toolInput.command)

if (!isSearch) process.exit(0)

// 3. GATE: a search before the graph has been consulted → deny and tell the
//    agent what to do instead. Proven to fire even under
//    --dangerously-skip-permissions.
if (gateEnabled() && !askHasRun(sessionId)) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason(toolName),
      },
    }),
  )
  process.exit(0)
}

// 4. NUDGE: default mode, or gate mode after `ask` has run — allow the search
//    and inject the graph-first note. Never denies.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: nudge(toolName),
    },
  }),
)
process.exit(0)
