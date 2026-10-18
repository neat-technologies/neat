#!/usr/bin/env node
// NEAT SessionStart hook (ADR-260, the push side). At the start of a Claude Code
// session, if the project's daemon holds a live incident, inject the composed lead
// so the agent reads the culprit before its first tool call and reaches for
// mcp__neat__investigate. The injected line ends with that literal tool id so a
// deferred-tool search (Claude Code 2.1 loads MCP tools through ToolSearch) lands.
//
// Once per session. Guarded (direction.md rule 8): never errors, never waits longer
// than one bounded shell-out, and stays silent when nothing is live or the daemon is
// unreachable — a push surface that costs the session nothing when there's nothing
// to push.
//
// Reuse, not duplication (#1373): daemon resolution and lead composition are not
// re-implemented here. The hook shells out to `neat incidents --lead`, which resolves
// the daemon through resolveClientTarget and composes the line through
// @neat.is/core/incidents-render — the same line the MCP server's startup
// instructions carry. The hook writes a "lead delivered" marker to the per-session
// gate dir so the search-nudge hook (ADR-261) can say "already flagged" instead of
// re-describing the incident on the first search.
//
// This shipped file is the source of truth: `neat claude install` installs it via
// readSkillAsset in @neat.is/core (packages/core/src/hooks-cli.ts), and the plugin
// copy (plugin/hooks/neat-session-incident.mjs) is kept byte-identical by
// plugin-packaging.test.ts.

import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

// The shell-out is bounded so a slow or hanging daemon never delays session start.
const LEAD_TIMEOUT_MS = 2500

// ~/.neat, overridable via NEAT_HOME (matches the CLI, the search-nudge hook, tests).
function neatHome() {
  const override = process.env.NEAT_HOME
  return override && override.length > 0 ? path.resolve(override) : path.join(os.homedir(), '.neat')
}

function safeSession(sessionId) {
  return (sessionId || 'nosession').replace(/[^\w.-]/g, '_')
}

// The marker lives in the same per-session gate dir the search-nudge hook uses, so
// ADR-261 can read it and shorten its first-search line to "already flagged".
function deliveredMarker(sessionId) {
  return path.join(neatHome(), 'hooks', 'gate', `lead-delivered-${safeSession(sessionId)}`)
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
    // best-effort — a missing marker just means 261 re-describes instead of referencing
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    try {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (c) => {
        data += c
      })
      process.stdin.on('end', () => resolve(data))
      process.stdin.on('error', () => resolve(data))
    } catch {
      resolve(data)
    }
    // SessionStart may provide no stdin on some harness versions; don't hang.
    setTimeout(() => resolve(data), 200).unref?.()
  })
}

// Shell out to the CLI verb — it resolves the daemon and composes the lead. Bounded
// and swallowed: a down or slow daemon yields an empty string, and the hook injects
// nothing. Prefer the installed `neat` bin; fall back to npx for an npx-only install.
function leadLine(cwd) {
  const run = (cmd, args) => {
    try {
      return execFileSync(cmd, args, {
        cwd,
        timeout: LEAD_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return ''
    }
  }
  let out = run('neat', ['incidents', '--lead'])
  if (!out) out = run('npx', ['-y', 'neat.is', 'incidents', '--lead'])
  return out
}

async function main() {
  const raw = await readStdin()
  let input = {}
  try {
    input = raw ? JSON.parse(raw) : {}
  } catch {
    input = {}
  }
  const sessionId = input.session_id
  const cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd()

  const marker = deliveredMarker(sessionId)
  if (markerExists(marker)) process.exit(0) // already delivered this session

  const line = leadLine(cwd)
  if (!line) process.exit(0) // nothing live, or the daemon is unreachable → inject nothing

  touchMarker(marker)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: line,
      },
    }),
  )
  process.exit(0)
}

main().catch(() => process.exit(0))
