// The no-regression gate step (ADR-277). Off by default. When a repo opts in
// (no-regression-gate: report | fail), it runs the engine's hidden `gate` verb
// over the PR's base and head checkouts, posts the four conditions as a sticky
// comment, and (only in `fail` mode) fails the check when the verdict does not
// pass. Runs on its own, like the security step; a shallow checkout that hides
// the base leaves the gate unevaluable, which fails closed when it blocks.

import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  GATE_MAX_FILES,
  GATE_MAX_SERVICES,
  GATE_TESTS,
  NO_REGRESSION_GATE,
  SCAN_SUBPATH,
  TOKEN,
  WORKSPACE,
} from './config.mjs'
import { runEngineJson, sh } from './engine.mjs'
import { failNoRegressionGate } from './exit.mjs'
import { renderGate } from './gate.mjs'
import { postSticky } from './github.mjs'

/**
 * Run the gate verb over the PR's base and head. Returns the parsed
 * NoRegressionGateVerdict, or null when the base can't be checked out or the verb
 * can't produce one (both read as unevaluable downstream). The base is checked out
 * under a directory whose leaf name matches the head's, so a package.json with no
 * name is the same service on both sides (#1557).
 */
export function runGate(baseSha, { run = runEngineJson, git = sh } = {}) {
  const headDir = SCAN_SUBPATH ? path.join(WORKSPACE, SCAN_SUBPATH) : WORKSPACE
  const parent = mkdtempSync(path.join(tmpdir(), 'neat-gate-'))
  const baseRoot = path.join(parent, path.basename(WORKSPACE) || 'repo')
  try {
    git('git', ['worktree', 'add', '--detach', baseRoot, baseSha], { cwd: WORKSPACE })
    const baseDir = SCAN_SUBPATH ? path.join(baseRoot, SCAN_SUBPATH) : baseRoot
    if (!existsSync(baseDir)) return null
    const args = [
      'gate',
      '--base',
      baseDir,
      '--head',
      headDir,
      '--max-files',
      String(GATE_MAX_FILES),
      '--max-services',
      String(GATE_MAX_SERVICES),
    ]
    if (GATE_TESTS) args.push('--tests', GATE_TESTS)
    return run(args, headDir)
  } catch (e) {
    console.log('no-regression gate skipped:', e.message)
    return null
  } finally {
    try {
      git('git', ['worktree', 'remove', '--force', baseRoot], { cwd: WORKSPACE })
    } catch {
      /* best-effort */
    }
    try {
      rmSync(parent, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

export async function noRegressionGateStep(owner, repo, prNumber, baseSha) {
  if (NO_REGRESSION_GATE === 'off') return

  const verdict = runGate(baseSha)
  const rendered = renderGate(verdict, NO_REGRESSION_GATE)

  if (TOKEN) {
    try {
      await postSticky(owner, repo, prNumber, rendered.marker, rendered.body)
      console.log(`Posted NEAT no-regression gate comment on PR #${prNumber}`)
    } catch (e) {
      console.log('no-regression gate comment not posted:', e.message)
    }
  } else {
    console.log('No github-token; no-regression gate preview:\n' + rendered.body)
  }

  if (NO_REGRESSION_GATE === 'fail' && rendered.blocks) {
    console.error('neat-action: the no-regression gate did not pass (no-regression-gate: fail)')
    failNoRegressionGate()
  }
}
