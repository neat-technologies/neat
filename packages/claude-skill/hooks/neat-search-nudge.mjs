#!/usr/bin/env node
// NEAT search hook — a Claude Code PreToolUse hook.
//
// When the agent reaches for raw text search — the Grep or Glob tools, or a
// Bash command that shells out to grep / rg / ag / ack / find / fd — this hook
// steers it to NEAT's graph first. NEAT already holds this project's structure
// and dependencies, and carries what the code actually did in production
// (OBSERVED), which no file the agent can open shows it.
//
// It also covers the ops probes an agent reaches for on a failing system: a
// Bash command whose first word is kubectl, docker, docker-compose, curl,
// journalctl, gcloud, aws or az (ADR-261). Those are steered only until the
// graph has been consulted this session.
//
//   INCIDENT-LOUD (default, ADR-261) — before the graph has been consulted, the
//     hook asks the daemon once per session whether it holds a live incident
//     (one GET, a short timeout, cached; an unreachable daemon is silence). If it
//     does, the note leads with what NEAT sees and tells the agent to call
//     `investigate` first. With NEAT_SEARCH_DEBUG_LOUD=block it denies the first
//     such call of the session instead; NEAT_SEARCH_DEBUG_LOUD=0 turns it off.
//     No live incident → the quiet nudge below, unchanged.
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

// Ops probes, matched on the command's first word (after any leading VAR=value
// assignments and sudo), so `kubectl get pods` counts and `echo kubectl` doesn't.
const OPS_PROBES = new Set(['kubectl', 'docker', 'docker-compose', 'curl', 'journalctl', 'gcloud', 'aws', 'az'])
function bashOpsProbe(command) {
  if (typeof command !== 'string') return null
  const words = command.trim().split(/\s+/)
  let i = 0
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === 'sudo')) i++
  const first = words[i] ? path.basename(words[i]) : ''
  return OPS_PROBES.has(first) ? first : null
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
const debugLoudEnabled = () =>
  process.env.NEAT_SEARCH_DEBUG_LOUD === 'block' || flagOn('NEAT_SEARCH_DEBUG_LOUD', 'debug-loud')

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

// ── Live incident (ADR-261) ────────────────────────────────────────────────
// How long an incident counts as live, and how long the one GET may take.
const LIVE_MINUTES = Number(process.env.NEAT_SEARCH_LIVE_MINUTES) > 0 ? Number(process.env.NEAT_SEARCH_LIVE_MINUTES) : 30
const LIVE_TIMEOUT_MS = 1500

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

// The daemon this session talks to, the way the MCP server finds it: the env,
// else the address `neat claude install` wrote into mcpServers.neat, else the
// running daemon whose project holds the session's cwd, else the only one.
function resolveDaemon(cwd) {
  const envUrl = process.env.NEAT_CORE_URL || process.env.NEAT_API_URL
  const envToken = process.env.NEAT_AUTH_TOKEN || undefined
  if (envUrl) return { url: envUrl, token: envToken }
  const claudeJson =
    process.env.NEAT_CLAUDE_CONFIG || path.join(process.env.HOME || os.homedir(), '.claude.json')
  const mcpEnv = readJson(claudeJson)?.mcpServers?.neat?.env
  if (mcpEnv && typeof mcpEnv.NEAT_CORE_URL === 'string') {
    return { url: mcpEnv.NEAT_CORE_URL, token: envToken || mcpEnv.NEAT_AUTH_TOKEN }
  }
  let names = []
  try {
    names = fs.readdirSync(path.join(neatHome(), 'daemons'))
  } catch {
    return null
  }
  const live = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJson(path.join(neatHome(), 'daemons', n)))
    .filter((r) => r && r.status === 'running' && Number.isInteger(r.pid) && pidAlive(r.pid) && Number.isInteger(r.ports?.rest))
  const here = cwd ? path.resolve(cwd) : undefined
  const owner = here
    ? live.find((r) => typeof r.projectPath === 'string' && (here === r.projectPath || here.startsWith(r.projectPath + path.sep)))
    : undefined
  const pick = owner ?? (live.length === 1 ? live[0] : undefined)
  return pick ? { url: `http://localhost:${pick.ports.rest}`, token: envToken } : null
}

// The live incidents the daemon holds, newest first, asked once per session and
// cached. Any failure is "none": the hook never errors and never waits longer
// than the one bounded GET.
async function liveIncidents(sessionId, cwd) {
  const cacheFile = path.join(neatHome(), 'hooks', 'live', `${safeSession(sessionId)}.json`)
  const cached = readJson(cacheFile)
  if (cached && Array.isArray(cached.live)) return cached.live
  let live = []
  try {
    const daemon = resolveDaemon(cwd)
    if (daemon) {
      const since = new Date(Date.now() - LIVE_MINUTES * 60_000).toISOString()
      const res = await fetch(`${daemon.url.replace(/\/$/, '')}/incidents?limit=200&since=${encodeURIComponent(since)}`, {
        headers: daemon.token ? { authorization: `Bearer ${daemon.token}` } : {},
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      })
      if (res.ok) {
        const body = await res.json()
        live = (Array.isArray(body?.events) ? body.events : [])
          .filter((e) => e && typeof e.timestamp === 'string')
          .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
          .map((e) => ({
            service: e.service || e.affectedNode || 'a service',
            node: e.affectedNode || undefined,
            what: String(e.errorMessage || e.errorType || 'an incident').replace(/\s+/g, ' ').slice(0, 160),
          }))
      }
    }
  } catch {
    live = []
  }
  touchJson(cacheFile, { checkedAt: new Date().toISOString(), live })
  return live
}

function touchJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  } catch {
    // best-effort cache
  }
}

function blockedMarker(sessionId) {
  return path.join(neatHome(), 'hooks', 'live', `blocked-${safeSession(sessionId)}`)
}

// The loud note: what NEAT already sees, and the one call to make first.
function incidentLoud(live, toolName) {
  const top = live[0]
  const more = live.length > 1 ? ` (+${live.length - 1} more live incident${live.length > 2 ? 's' : ''})` : ''
  const target = top.node ? ` with node "${top.node}"` : ''
  return [
    `NEAT sees ${top.what} on ${top.service}${more}; call investigate first.`,
    '',
    `Before ${toolName}: call the NEAT \`investigate\` tool (mcp__neat__investigate)${target}, or`,
    '`neat incidents` from the shell. One call returns the culprit, the evidence with provenance,',
    'the blast radius and the code locus — what several kubectl round trips only approximate,',
    'and the declared-versus-observed divergence they cannot show at all.',
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

// 2. Is this a raw text search, or an ops probe? Anything else is a silent no-op.
let isSearch = false
if (toolName === 'Grep' || toolName === 'Glob') isSearch = true
else if (toolName === 'Bash') isSearch = bashLooksLikeSearch(toolInput.command)
const opsProbe = !isSearch && toolName === 'Bash' ? bashOpsProbe(toolInput.command) : null

if (!isSearch && !opsProbe) process.exit(0)
const consulted = markerExists(consultedMarker(sessionId))
// An ops probe is steered only until the graph has been consulted.
if (opsProbe && consulted) process.exit(0)
const subject = opsProbe ?? toolName

// 3. INCIDENT-LOUD (ADR-261): before the graph has been consulted, a live
//    incident makes the note lead with what NEAT sees. =block denies the first
//    such call of the session; =0 turns this off.
const loudSetting = process.env.NEAT_SEARCH_DEBUG_LOUD
if (!consulted && loudSetting !== '0') {
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd()
  const live = await liveIncidents(sessionId, cwd)
  if (live.length > 0) {
    const message = incidentLoud(live, subject)
    if (loudSetting === 'block' && !markerExists(blockedMarker(sessionId))) {
      touchMarker(blockedMarker(sessionId))
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: message,
          },
        }),
      )
      process.exit(0)
    }
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } }),
    )
    process.exit(0)
  }
}

// 4. GATE: a text search before the graph has been consulted → deny and tell the
//    agent what to do instead. Proven to fire even under
//    --dangerously-skip-permissions. Ops probes are never gated.
if (isSearch && gateEnabled() && !consulted) {
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

// 5. NUDGE: default mode, or gate mode after the graph has been consulted — allow
//    the call and inject the graph-first note. In debug-loud mode, a search while
//    an investigation is open gets the louder note. Never denies.
const note =
  isSearch && debugLoudEnabled() && markerExists(debugMarker(sessionId)) ? loudNudge(toolName) : nudge(subject)
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: note,
    },
  }),
)
process.exit(0)
