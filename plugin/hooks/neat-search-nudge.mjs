#!/usr/bin/env node
// NEAT search hook — a Claude Code PreToolUse hook with three modes.
//
// When the agent reaches for raw text search — the Grep or Glob tools, or a
// Bash command that shells out to grep / rg / ag / ack / find / fd — this hook
// steers it to NEAT's graph first. NEAT already holds this project's structure
// and dependencies, and carries what the code actually did in production
// (OBSERVED), which no file the agent can open shows it.
//
//   NUDGE (default) — injects a short "ask the graph first" note and always lets
//     the search run. It never denies; anything that is not a text search is a
//     silent no-op.
//
//   DEBUG-LOUD (opt-in) — when the agent is mid-investigation (its last NEAT call
//     this session was an incident or root-cause query) and it then reaches for
//     raw search, the note is louder: stay in the graph, don't leave the trail.
//     Still a nudge, never a deny. Off by default; enabled by
//     NEAT_SEARCH_DEBUG_LOUD=1 or a ~/.neat/hooks/debug-loud flag (=0 forces off).
//
//   GATE (opt-in) — DENIES Grep / Glob / grep-family Bash until the agent has
//     consulted the graph — any NEAT query (`ask`, get_root_cause, get_incident_*,
//     get_divergences, …) — at least once this session, forcing the graph-first
//     orientation. Once the graph has been consulted, search is allowed and the
//     nudge rides along. State is a per-session marker under ~/.neat/hooks/gate/,
//     keyed by session_id, since each hook call is a fresh process.
//
// Gate is enabled by `neat hooks --apply --gate` (which persists a flag at
// ~/.neat/hooks/gate-enabled) and/or NEAT_SEARCH_GATE=1; NEAT_SEARCH_GATE=0
// forces nudge-only. Debug-loud is independent, via NEAT_SEARCH_DEBUG_LOUD or
// ~/.neat/hooks/debug-loud.
//
// Wired by `neat hooks --apply`, which copies this script under ~/.neat/hooks/
// and adds a PreToolUse entry to ~/.claude/settings.json. The hook is
// Claude-Code-specific; agents on other harnesses get the same steer from the
// graph-first guidance NEAT ships (see `neat hooks --print-guide`).
//
// This shipped file is the source of truth: `neat hooks --apply` installs it via
// readSkillAsset in @neat.is/core (packages/core/src/hooks-cli.ts), and the
// plugin copy (plugin/hooks/neat-search-nudge.mjs) is kept byte-identical by
// plugin-packaging.test.ts.

import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// grep-family and file-finder binaries. Matched at a word boundary so a path
// like agent.ts does not trip it, and after a shell separator so the binary in
// a pipe (... | grep foo) still counts.
const SEARCH_BINARY = /(?:^|[\s|;&(){}])(?:grep|egrep|fgrep|rg|ripgrep|ag|ack|find|fd)(?=\s|$)/
// A NEAT query run as a Bash CLI verb — the CLI form of consulting the graph.
const ASK_BASH = /(?:^|[\s|;&(){}])neat\s+(?:ask|incidents|root-cause|divergences|blast-radius|dependencies|observed-dependencies)\b/
// The incident/root-cause subset — a Bash CLI investigation that marks debug-loud.
const DEBUG_BASH = /(?:^|[\s|;&(){}])neat\s+(?:incidents|root-cause|divergences)\b/

function bashLooksLikeSearch(command) {
  return typeof command === 'string' && SEARCH_BINARY.test(command)
}

// ~/.neat, overridable via NEAT_HOME (matches the CLI + tests).
function neatHome() {
  const override = process.env.NEAT_HOME
  return override && override.length > 0 ? path.resolve(override) : path.join(os.homedir(), '.neat')
}

// Shared opt-in flag: env wins (1/0), else a persisted flag file under ~/.neat/hooks.
function flagOn(envName, flagFile) {
  const env = process.env[envName]
  if (env === '0') return false
  if (env === '1') return true
  try {
    return fs.existsSync(path.join(neatHome(), 'hooks', flagFile))
  } catch {
    return false
  }
}
const gateEnabled = () => flagOn('NEAT_SEARCH_GATE', 'gate-enabled')
const debugLoudEnabled = () => flagOn('NEAT_SEARCH_DEBUG_LOUD', 'debug-loud')

// Per-session markers. `consulted` records that the graph was queried at all
// (opens the gate); `debug` records an active incident/root-cause investigation
// (makes a later raw search loud in debug-loud mode). session_id scopes both.
function safeSession(sessionId) {
  return (sessionId || 'nosession').replace(/[^\w.-]/g, '_')
}
function consultedMarker(sessionId) {
  return path.join(neatHome(), 'hooks', 'gate', `ask-ran-${safeSession(sessionId)}`)
}
function debugMarker(sessionId) {
  return path.join(neatHome(), 'hooks', 'debug', `active-${safeSession(sessionId)}`)
}
function markerExists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}
function touchMarker(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, new Date().toISOString())
  } catch {
    // best-effort — a missing marker just means the mode stays in its default
  }
}

function nudge(toolName) {
  return [
    'NEAT is wired into this project — its live graph already knows this codebase:',
    'structure, dependencies, and what the code actually did in production (OBSERVED),',
    'which ' + toolName + ' cannot show you. Ask the graph first; it answers with',
    'structured, provenance-tagged facts, in roughly this order:',
    '',
    '  - get_incident_history / get_root_cause — why something is failing',
    '  - get_divergences — where the code and production disagree',
    '  - get_blast_radius / get_dependencies — what a change reaches, what a node uses',
    '  - get_observed_dependencies — what it actually calls at runtime (OBSERVED)',
    '  - ask — one plain-language question, routed to the right query',
    '  - semantic_search — find a node by description when you cannot name it',
    '',
    'Raw text search is a fine fallback for comments, string literals, and config the',
    'graph does not model — run it if the graph does not have what you need.',
  ].join('\n')
}

// Louder variant: the agent is mid-investigation and reaching for raw search.
function loudNudge(toolName) {
  return [
    'You are mid-investigation — your last NEAT call was an incident or root-cause query —',
    'and now reaching for ' + toolName + '. Stay in the graph: it carries the cause chain, the',
    'blast radius, and the OBSERVED runtime behaviour that raw search cannot see. Ask NEAT the',
    'next step — get_root_cause, get_incident_history, get_divergences, then expand / relate to',
    'confirm the cause — before you scan files. Raw search is for what the graph does not model.',
  ].join('\n')
}

function denyReason(toolName) {
  return (
    'NEAT gate: consult the graph before text search. Call `neat ask "<your question>"` ' +
    '(or any NEAT query — get_root_cause, get_incident_history, get_divergences) first — it ' +
    'answers with structured, provenance-tagged facts (EXTRACTED from code, OBSERVED from ' +
    'runtime) that ' + (toolName || 'grep') + ' cannot see. After you have asked the graph once ' +
    'this session, text search is available as a fallback for what the graph does not model ' +
    '(comments, string literals, config minutiae).'
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
const bareName = toolName.startsWith('mcp__neat__') ? toolName.slice('mcp__neat__'.length) : toolName

// The incident/root-cause query set — any of these marks an active investigation.
const INVESTIGATION = new Set([
  'get_incident_card',
  'get_incident_history',
  'get_root_cause',
  'get_divergences',
  'expand',
  'relate',
])

// 1. Did the agent consult the graph? Any NEAT query — the MCP tools (mcp__neat__*),
//    a bare `ask`, or a Bash `neat <query>` — opens the gate for the session. An
//    incident/root-cause query also marks an active investigation (debug-loud).
const bashCommand = toolName === 'Bash' && typeof toolInput.command === 'string' ? toolInput.command : ''
const isNeatQuery =
  toolName.startsWith('mcp__neat__') || bareName === 'ask' || (bashCommand && ASK_BASH.test(bashCommand))
if (isNeatQuery) {
  touchMarker(consultedMarker(sessionId))
  if (INVESTIGATION.has(bareName) || (bashCommand && DEBUG_BASH.test(bashCommand))) {
    touchMarker(debugMarker(sessionId))
  }
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
if (gateEnabled() && !markerExists(consultedMarker(sessionId))) {
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

// 4. NUDGE: default mode, or gate mode after the graph has been consulted — allow
//    the search and inject the graph-first note. In debug-loud mode, a search
//    while an investigation is open gets the louder note. Never denies.
const note =
  debugLoudEnabled() && markerExists(debugMarker(sessionId)) ? loudNudge(toolName) : nudge(toolName)
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: note,
    },
  }),
)
process.exit(0)
