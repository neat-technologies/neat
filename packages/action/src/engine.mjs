// Running the NEAT engine in CI: graph extraction (`init`) and the JSON verbs
// the security step uses. The engine is `npx neat.is` by default, or a local
// build when the engine input is a path.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ENGINE, SCAN_SUBPATH } from './config.mjs'
import { loadGraph } from './graph.mjs'

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

// A path-like engine (a slash, or a .cjs/.js file) runs directly via node — used
// to test with a locally-built engine; a bare package name runs via npx.
function engineCommand(args) {
  if (ENGINE.includes('/') || ENGINE.endsWith('.cjs') || ENGINE.endsWith('.js')) return ['node', [ENGINE, ...args]]
  return ['npx', ['--yes', ENGINE, ...args]]
}

function runEngine(target) {
  const [cmd, args] = engineCommand(['init', target])
  sh(cmd, args, { cwd: target })
}

// Run an engine verb that prints JSON on stdout. Null when the engine doesn't
// have the verb (an older version), fails, or prints something that isn't JSON:
// the caller then falls back rather than failing the PR.
//
// `resultOnExit1` is for a verb whose exit code is part of its answer: `gate`
// exits 1 for a verdict that did not pass and still prints that verdict. With it
// set, an exit of exactly 1 is read from stdout like a clean one. Any other
// failure, or an exit 1 with nothing parseable, stays null.
export function runEngineJson(args, cwd, { resultOnExit1 = false } = {}) {
  try {
    const [cmd, argv] = engineCommand(args)
    return JSON.parse(sh(cmd, argv, { cwd, maxBuffer: 64 * 1024 * 1024 }))
  } catch (e) {
    if (!resultOnExit1 || e?.status !== 1 || typeof e.stdout !== 'string') return null
    try {
      return JSON.parse(e.stdout)
    } catch {
      return null
    }
  }
}

export function extractGraph(dir) {
  const target = SCAN_SUBPATH ? path.join(dir, SCAN_SUBPATH) : dir
  if (!existsSync(target)) return null
  try {
    runEngine(target)
  } catch {
    // init can exit non-zero on partial extraction; the snapshot may still exist.
  }
  const gp = path.join(target, 'neat-out', 'graph.json')
  return existsSync(gp) ? loadGraph(gp) : null
}
