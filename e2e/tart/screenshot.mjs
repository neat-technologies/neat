#!/usr/bin/env node
// Playwright (chromium) dashboard capture — runs INSIDE the Tart VM.
//
// Navigates to the NEAT dashboard (loopback, no token locally), waits for the
// cytoscape canvas to render, and writes a few PNGs to the artifacts dir on the
// mounted host directory. Chromium specifically: a fresh macOS VM has no Chrome,
// so we always launch the bundled chromium (`channel` is left unset → chromium).
//
// Resilient on purpose: every wait has a bounded timeout and a fallback, so a
// dashboard that renders slowly (or a view that isn't reachable) downgrades to a
// best-effort full-page shot rather than hanging the whole pipeline.
//
// Usage:
//   node screenshot.mjs --url http://localhost:6328 --out /path/to/artifacts \
//                       [--project <name>]
//
// Env fallbacks: DASHBOARD_URL, ARTIFACTS_DIR, NEAT_PROJECT.

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'

// Resolve playwright robustly. ESM bare imports don't search the global
// node_modules, and a fresh VM installs playwright globally — so resolve it
// against the global root (npm root -g) and import by absolute path. Falls back
// to a plain bare import when playwright is local to the run dir.
function pickChromium(mod) {
  // ESM import of the CJS playwright package surfaces `chromium` either as a
  // named export (local import) or under `.default` (absolute-path import).
  return mod.chromium ?? (mod.default && mod.default.chromium)
}

async function loadChromium() {
  // 1) local resolve (run dir has playwright)
  try {
    const c = pickChromium(await import('playwright'))
    if (c) return c
  } catch {
    /* fall through */
  }
  // 2) global resolve via `npm root -g`
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
    const req = createRequire(path.join(globalRoot, 'noop.js'))
    const c = pickChromium(await import(req.resolve('playwright')))
    if (c) return c
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    'could not load playwright (local or global). ' +
      'Install it: npm install -g playwright && npx playwright install chromium',
  )
}

function arg(name, fallbackEnv, def) {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallbackEnv && process.env[fallbackEnv]) return process.env[fallbackEnv]
  return def
}

const BASE = arg('url', 'DASHBOARD_URL', 'http://localhost:6328').replace(/\/$/, '')
const OUT = arg('out', 'ARTIFACTS_DIR', './artifacts')
const PROJECT = arg('project', 'NEAT_PROJECT', '')

// Compose the dashboard URL. Passing ?project pins the view in a multi-project
// dashboard; harmless when there's only one project (it resolves to it anyway).
const dashUrl = PROJECT ? `${BASE}/?project=${encodeURIComponent(PROJECT)}` : `${BASE}/`

const log = (m) => console.log(`[screenshot] ${m}`)

async function safeShot(page, file, label) {
  try {
    await page.screenshot({ path: file, fullPage: false })
    log(`captured ${label} → ${file}`)
    return true
  } catch (err) {
    log(`WARN: ${label} screenshot failed: ${err.message}`)
    return false
  }
}

async function main() {
  await mkdir(OUT, { recursive: true })

  const chromium = await loadChromium()
  // Always bundled chromium — a fresh VM has no system Chrome.
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)

  let ok = true
  try {
    log(`navigating to ${dashUrl}`)
    await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    // The canvas container is <div id="cy">. Wait for it, then for cytoscape to
    // mount its inner <canvas> layers — that's the signal the graph drew.
    try {
      await page.waitForSelector('#cy', { timeout: 20_000 })
      await page.waitForSelector('#cy canvas', { timeout: 20_000 })
      log('cytoscape canvas mounted')
    } catch (_e) {
      log('WARN: never saw #cy canvas within timeout — capturing whatever rendered')
      ok = false
    }

    // Give cose layout a beat to settle and the legend counts to populate.
    // The legend count cells start as "—" and fill once the graph loads; wait
    // for at least one to change, but don't block forever on it.
    try {
      await page.waitForFunction(
        () => {
          const cells = Array.from(document.querySelectorAll('.legend .ct'))
          return cells.some((c) => c.textContent && c.textContent.trim() !== '—')
        },
        { timeout: 12_000 },
      )
      log('legend counts populated')
    } catch (_e) {
      log('WARN: legend counts stayed empty — graph may be small or still loading')
    }
    await page.waitForTimeout(1500)

    // 1) The graph canvas — the headline shot.
    ok = (await safeShot(page, path.join(OUT, 'dashboard-graph.png'), 'graph canvas')) && ok

    // 2) A full-page shot for context (chrome + legend + canvas together).
    try {
      await page.screenshot({ path: path.join(OUT, 'dashboard-full.png'), fullPage: true })
      log(`captured full page → ${path.join(OUT, 'dashboard-full.png')}`)
    } catch (err) {
      log(`WARN: full-page screenshot failed: ${err.message}`)
    }

    // 3) Best-effort inspector/divergence view. The dashboard surfaces
    // divergences on the canvas and via an inspector panel; clicking a node
    // opens it. We try a node click, then capture; if nothing opens, this is a
    // no-op and the earlier shots stand.
    try {
      // Cytoscape draws to <canvas>, so DOM-clicking a node isn't reliable;
      // instead click near the canvas center to trigger any hover/inspect, then
      // look for the inspector aside.
      const box = await page.locator('#cy').boundingBox()
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(800)
      }
      const inspector = page.locator('.inspect, aside.inspect, [class*="inspect"]').first()
      if (await inspector.count()) {
        await safeShot(page, path.join(OUT, 'dashboard-inspector.png'), 'inspector view')
      } else {
        log('no inspector panel reachable — skipping (graph shots stand)')
      }
    } catch (err) {
      log(`inspector capture skipped: ${err.message}`)
    }
  } finally {
    await browser.close()
  }

  if (!ok) {
    log('completed with warnings (canvas may not have fully rendered)')
    // Don't hard-fail the pipeline on a soft render miss; the assertions in
    // scenario.sh are the correctness gate. Exit 0 so screenshots are
    // best-effort, not a blocker.
  }
  log('done')
}

main().catch((err) => {
  console.error('[screenshot] fatal:', err)
  // A Playwright launch failure (no chromium) should be visible but not abort
  // the whole run after the assertions already passed; exit 0, log loudly.
  process.exit(0)
})
