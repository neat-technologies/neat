import { promises as fs } from 'node:fs'
import path from 'node:path'
import { assessCheckout, refusedAssessment } from './extract/assess.js'

const FLAGS = [
  '--path',
  '--baseline',
  '--policies',
  '--origin',
  '--max-files',
  '--max-services',
] as const

/** JSON-only sandbox diagnostic. Never print producer or filesystem error text. */
export async function runAssessCommand(argv: string[]): Promise<number> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!
    const value = argv[i + 1]
    if (
      !(FLAGS as readonly string[]).includes(flag) ||
      !value ||
      value.startsWith('--') ||
      flags.has(flag)
    ) {
      console.log(JSON.stringify(refusedAssessment('invalid-input')))
      return 2
    }
    flags.set(flag, value)
  }
  if (
    FLAGS.some((flag) => !flags.has(flag)) ||
    !/^\d+$/.test(flags.get('--max-files')!) ||
    !/^\d+$/.test(flags.get('--max-services')!) ||
    Number(flags.get('--max-files')) < 1 ||
    Number(flags.get('--max-services')) < 1 ||
    !Number.isSafeInteger(Number(flags.get('--max-files'))) ||
    !Number.isSafeInteger(Number(flags.get('--max-services')))
  ) {
    console.log(JSON.stringify(refusedAssessment('invalid-input')))
    return 2
  }

  let baseline: unknown
  let policies: unknown
  const checkout = path.resolve(flags.get('--path')!)
  try {
    if (!(await fs.stat(checkout)).isDirectory()) throw new Error('not a checkout')
    baseline = JSON.parse(await fs.readFile(flags.get('--baseline')!, 'utf8')) as unknown
    policies = JSON.parse(await fs.readFile(flags.get('--policies')!, 'utf8')) as unknown
  } catch {
    console.log(JSON.stringify(refusedAssessment('invalid-input')))
    return 1
  }

  // Extraction warnings can quote source. This is a dedicated CLI process;
  // suppress its producer output and emit only the allowlisted verdict below.
  const diagnostic = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  }
  console.log = console.warn = console.error = console.info = console.debug = () => undefined
  let verdict = refusedAssessment('extraction-unavailable')
  try {
    verdict = await assessCheckout({
      path: checkout,
      baseline,
      policies,
      origin: flags.get('--origin')!,
      maxFiles: Number(flags.get('--max-files')),
      maxServices: Number(flags.get('--max-services')),
    })
  } catch {
    // No provider, policy, parser or filesystem exception may leak source.
  } finally {
    Object.assign(console, diagnostic)
  }
  console.log(JSON.stringify(verdict))
  return verdict.passed ? 0 : 1
}
