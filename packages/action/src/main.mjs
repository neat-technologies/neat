// NEAT graph-impact GitHub Action entrypoint. Reads the pull_request event and
// runs the steps in order: the security gate (security-step.mjs), then the graph
// impact comment (graph-step.mjs). Node builtins only — no bundling, no install.
// Never fails the PR check hard (its own errors exit 0); the one exception is the
// opt-in security gate (security-gate: fail). See exit.mjs.

import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { SECURITY, WORKSPACE } from './config.mjs'
import { sh } from './engine.mjs'
import { exitAfterError } from './exit.mjs'
import { graphStep } from './graph-step.mjs'
import { securityStep } from './security-step.mjs'

// Kept importable from here for tests and harnesses.
export { fetchDivergences, fetchObservedBreaks } from './host.mjs'
export { runSecurityScan } from './security-step.mjs'

async function main() {
  const env = process.env
  const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    : {}
  const pr = event.pull_request
  if (!pr) {
    console.log('Not a pull_request event; skipping.')
    return
  }
  const [owner, repo] = (env.GITHUB_REPOSITORY || '/').split('/')
  const baseSha = pr.base?.sha
  const headSha = pr.head?.sha

  let changedPaths = []
  try {
    changedPaths = sh('git', ['diff', '--name-only', `${baseSha}...${headSha}`], { cwd: WORKSPACE })
      .split('\n')
      .filter(Boolean)
  } catch {
    /* shallow checkout — degrade to no blast radius */
  }

  // The security gate runs on its own: a PR whose graph comes back empty still
  // gets checked for the vulnerabilities it pulls in.
  if (SECURITY === 'on') await securityStep(owner, repo, pr.number, baseSha, headSha)

  await graphStep(owner, repo, pr.number, baseSha, changedPaths)
}

// Run only as the action entrypoint; importable (for tests/harness) without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(exitAfterError)
}
