import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GateInput } from '@neat.is/types'
import { gateFromCheckouts } from './pr-verdict.js'

// The hidden `neat gate` verb (docs/contracts/no-regression-gate.md). neat-action
// shells to it in CI to turn a pull request's base and head checkouts into the
// no-regression gate verdict (ADR-277), the same way it shells to `security diff`.
// Kept out of usage(), QUERY_VERBS and cli-surface.md, like `assess`.

const REQUIRED = ['--base', '--head', '--max-files', '--max-services'] as const
const OPTIONAL = ['--tests'] as const
const FLAGS: readonly string[] = [...REQUIRED, ...OPTIONAL]
const USAGE =
  'usage: neat gate --base <dir> --head <dir> --max-files <N> --max-services <N> [--tests pass|fail]\n'

/**
 * JSON-only CI seam: prints exactly one NoRegressionGateVerdict on stdout and nothing else, so the
 * caller can `JSON.parse` it. Exit 0 means the gate passed, 1 means it did not (a verdict is printed
 * either way), 2 means the usage was malformed or a checkout was missing (no verdict). Extraction can
 * fail to produce a graph; that surfaces as exit 1 with no verdict, which a caller reads as unavailable
 * and, when it blocks, fails closed on.
 */
export async function runGateCommand(argv: string[]): Promise<number> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!
    const value = argv[i + 1]
    if (!FLAGS.includes(flag) || !value || value.startsWith('--') || flags.has(flag)) {
      process.stderr.write(USAGE)
      return 2
    }
    flags.set(flag, value)
  }
  const tests = flags.get('--tests')
  const maxFiles = Number(flags.get('--max-files'))
  const maxServices = Number(flags.get('--max-services'))
  if (
    REQUIRED.some((flag) => !flags.has(flag)) ||
    !/^\d+$/.test(flags.get('--max-files')!) ||
    !/^\d+$/.test(flags.get('--max-services')!) ||
    maxFiles < 1 ||
    maxServices < 1 ||
    !Number.isSafeInteger(maxFiles) ||
    !Number.isSafeInteger(maxServices) ||
    (tests !== undefined && tests !== 'pass' && tests !== 'fail')
  ) {
    process.stderr.write(USAGE)
    return 2
  }

  const baseDir = path.resolve(flags.get('--base')!)
  const headDir = path.resolve(flags.get('--head')!)
  try {
    if (!(await fs.stat(baseDir)).isDirectory()) throw new Error('base is not a checkout')
    if (!(await fs.stat(headDir)).isDirectory()) throw new Error('head is not a checkout')
  } catch {
    process.stderr.write('neat gate: --base and --head must both be directories\n')
    return 2
  }

  const gate: GateInput = {
    blastRadius: { maxFiles, maxServices },
    ...(tests ? { tests } : {}),
  }

  // Extraction prints progress, and a warning can quote source. This is a dedicated
  // CLI process whose stdout is parsed as JSON, so silence the producers around the
  // run and emit only the verdict below.
  const diagnostic = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  }
  console.log = console.warn = console.error = console.info = console.debug = () => undefined
  let verdict
  try {
    verdict = await gateFromCheckouts({ baseDir, headDir, gate })
  } catch {
    Object.assign(console, diagnostic)
    // No provider, parser or filesystem exception may leak source. An unbuildable
    // graph is reported as unavailable (no verdict), which fails closed when the
    // caller blocks on the gate.
    process.stderr.write('neat gate: could not build the gate verdict from these checkouts\n')
    return 1
  } finally {
    Object.assign(console, diagnostic)
  }
  console.log(JSON.stringify(verdict))
  return verdict.passed ? 0 : 1
}
