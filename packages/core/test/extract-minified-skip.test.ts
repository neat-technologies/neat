import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMinifiedSource, loadSourceFiles, walkSourceFiles } from '../src/extract/calls/shared.js'
import { drainSkippedFiles, formatSkippedBanner } from '../src/extract/errors.js'

// #1258 — a minified bundle is machine output: thousands of one-character
// declarations on one line, each of which would mint a SymbolNode nobody can
// navigate to. The file stays in the graph (its FileNode is a true fact about
// the repo); nothing is extracted from it, and the skip is counted rather than
// silent.

const dirs: string[] = []

async function repo(files: Record<string, string>): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-min-')))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, 'utf8')
  }
  return root
}

// One line, many declarations — the real shape of a bundle chunk.
function minifiedBundle(bytes: number): string {
  let line = ''
  let i = 0
  while (line.length < bytes) line += `function m${i++}(a,b){return a+b}`
  return line
}

afterEach(async () => {
  drainSkippedFiles()
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

describe('isMinifiedSource', () => {
  it('takes the .min. naming convention at its word', () => {
    expect(isMinifiedSource('/x/vendor.min.js', 'a\n').minified).toBe(true)
    expect(isMinifiedSource('/x/vendor.MIN.JS', 'a\n').minified).toBe(true)
    expect(isMinifiedSource('/x/app.min.mjs', 'a\n').minified).toBe(true)
  })

  it('catches an unnamed bundle by its line length', () => {
    const v = isMinifiedSource('/x/main-4f2a.js', minifiedBundle(200 * 1024))
    expect(v.minified).toBe(true)
    expect(v.detail).toMatch(/longest line \d+ chars/)
  })

  it('leaves ordinary source alone, including a long-ish generated line', () => {
    // The longest real line measured across this repo is 2,977 chars — an
    // inline SVG path in platform-icons.ts. The threshold has to clear it.
    const svgish = `export const icon = '${'M12 2L2 7'.repeat(300)}'`
    expect(svgish.length).toBeGreaterThan(2_000)
    expect(isMinifiedSource('/x/platform-icons.ts', svgish).minified).toBe(false)
    expect(isMinifiedSource('/x/index.ts', 'const a = 1\nconst b = 2\n').minified).toBe(false)
  })

  it('does not flag a big file that is merely long, only one that is wide', () => {
    const tall = 'const x = 1\n'.repeat(50_000)
    expect(tall.length).toBeGreaterThan(500_000)
    expect(isMinifiedSource('/x/generated.ts', tall).minified).toBe(false)
  })
})

describe('loadSourceFiles', () => {
  it('skips a minified file and records why, while the walk still yields it', async () => {
    const root = await repo({
      'src/index.js': 'export const a = 1\n',
      'src/vendor.min.js': 'var a=1\n',
      'src/chunk-abc.js': minifiedBundle(200 * 1024),
    })
    drainSkippedFiles()

    // walkSourceFiles is what addFiles uses — every file is still a FileNode.
    const walked = (await walkSourceFiles(root)).map((p) => path.basename(p)).sort()
    expect(walked).toEqual(['chunk-abc.js', 'index.js', 'vendor.min.js'])

    // loadSourceFiles is what every producer reads through — only real source.
    const loaded = (await loadSourceFiles(root)).map((f) => path.basename(f.path))
    expect(loaded).toEqual(['index.js'])

    const skipped = drainSkippedFiles()
    expect(skipped.map((s) => path.basename(s.path)).sort()).toEqual(['chunk-abc.js', 'vendor.min.js'])
    expect(skipped.every((s) => s.reason === 'minified')).toBe(true)
    expect(skipped.find((s) => s.path.endsWith('vendor.min.js'))!.detail).toBe('named *.min.js')
    expect(skipped.find((s) => s.path.endsWith('chunk-abc.js'))!.detail).toMatch(/longest line/)
  })

  it('counts a file once however many producers read the tree', async () => {
    // Eleven producers each call loadSourceFiles, so a naive push reported six
    // minified files in a repo that had one.
    const root = await repo({ 'src/chunk.js': minifiedBundle(200 * 1024) })
    drainSkippedFiles()
    await loadSourceFiles(root)
    await loadSourceFiles(root)
    await loadSourceFiles(root)
    expect(drainSkippedFiles()).toHaveLength(1)
  })

  it('records nothing for a repo with no machine output', async () => {
    const root = await repo({ 'src/index.js': 'export const a = 1\n' })
    drainSkippedFiles()
    await loadSourceFiles(root)
    expect(drainSkippedFiles()).toEqual([])
  })
})

describe('formatSkippedBanner', () => {
  it('says nothing on zero, and counts otherwise', () => {
    expect(formatSkippedBanner(0)).toBeNull()
    expect(formatSkippedBanner(1)).toContain('1 minified file')
    expect(formatSkippedBanner(4)).toContain('4 minified files')
    expect(formatSkippedBanner(4)).toContain('FileNodes kept')
  })
})
