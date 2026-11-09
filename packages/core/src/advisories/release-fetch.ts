import zlib from 'node:zlib'
import { Buffer } from 'node:buffer'
import semver from 'semver'
import { computeFixDiff, fixDiffPair, isPackageSource, type FixDiff } from './fixdiff.js'
import type { Advisory, AffectedPackage } from './normalize.js'
import { comparePep440, parsePep440 } from './pep440.js'

// Fetching a package's releases and populating `advisory.fixDiff` (advisory-cache.md
// §4). This is the I/O boundary for the fix-diff, the sibling of source.ts: the
// pure compute lives in fixdiff.ts (computeFixDiff, fixDiffPair, packageSymbols),
// and this module does the registry fetch and archive reading around it.
//
// Registry archives are untrusted input. Everything here is read in memory and
// never written to disk (no path from an archive entry reaches the filesystem,
// so an archive can't escape a directory), decompression is hard-capped so a
// compression bomb raises rather than exhausts memory, downloads are size- and
// time-bounded, and every failure falls open: a package that can't be fetched or
// read gets no fixDiff, and the security card degrades to package grain.

const NPM_REGISTRY = 'https://registry.npmjs.org'
const PYPI = 'https://pypi.org/pypi'
const GO_PROXY = 'https://proxy.golang.org'

const FETCH_TIMEOUT_MS = 30_000
const MAX_DOWNLOAD = 32 * 1024 * 1024 // compressed bytes off the wire
const MAX_UNPACKED = 64 * 1024 * 1024 // total decompressed bytes per archive
const MAX_FILE = 4 * 1024 * 1024 // per-file source cap; a larger file is skipped
const MAX_ENTRIES = 20_000

function pep440Cmp(a: string, b: string): number | null {
  const [x, y] = [parsePep440(a), parsePep440(b)]
  return x && y ? comparePep440(x, y) : null
}
function semverCmp(a: string, b: string): number | null {
  const [x, y] = [semver.parse(a.replace(/^v/, '')), semver.parse(b.replace(/^v/, ''))]
  return x && y ? semver.compare(x, y) : null
}
const cmpFor = (ecosystem: string) => (ecosystem === 'PyPI' ? pep440Cmp : semverCmp)

// PyPI compares names PEP 503-normalized; npm and Go are case-sensitive.
const pep503 = (s: string) => s.replace(/[-_.]+/g, '-').toLowerCase()
function sameName(ecosystem: string, a: string, b: string): boolean {
  return ecosystem === 'PyPI' ? pep503(a) === pep503(b) : a === b
}
const ensureV = (v: string) => (/^v/.test(v) ? v : `v${v}`)
// Go module proxy path encoding: an uppercase letter becomes `!` + its lowercase.
const goEscape = (s: string) => s.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)

// Every (introduced, fixed) pair an affected package lists, walking each range's
// events in order so a `fixed` is paired with the `introduced` that opened it.
function fixEvents(pkg: AffectedPackage): Array<{ introduced: string; fixed: string }> {
  const out: Array<{ introduced: string; fixed: string }> = []
  for (const r of pkg.ranges) {
    let introduced = '0'
    for (const e of r.events) {
      if (e.introduced !== undefined) introduced = e.introduced
      else if (e.fixed !== undefined) out.push({ introduced, fixed: e.fixed })
    }
  }
  return out
}

// The earliest fix across every affected entry for the package: `to` is the
// first fixed version (advisory-cache.md §4), so a re-affected range doesn't move
// the diff off the fix that landed first. Several entries are unioned the way the
// matcher unions `fixedIn`, since folding can leave one package in more than one.
function earliestFix(pkgs: AffectedPackage[], ecosystem: string): { introduced: string; fixed: string } | null {
  const cmp = cmpFor(ecosystem)
  const evs = pkgs.flatMap(fixEvents)
  if (evs.length === 0) return null
  evs.sort((a, b) => cmp(a.fixed, b.fixed) ?? a.fixed.localeCompare(b.fixed))
  return evs[0]!
}

async function fetchBytes(fetchImpl: typeof fetch, url: string): Promise<Uint8Array> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: '*/*' } })
  if (!res.ok) throw new Error(`release fetch failed: ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD) throw new Error('release too large')
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > MAX_DOWNLOAD) throw new Error('release too large')
  return buf
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`registry metadata failed: ${res.status}`)
  return res.json()
}

// A tar (already decompressed), read block by block. Regular files only; ustar
// `prefix` and a PAX `path=` override are honored so long names aren't truncated.
// Returns raw bytes per entry; the caller strips prefixes and filters to source.
function readTar(tar: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const str = (start: number, len: number) => {
    const slice = tar.subarray(start, start + len)
    const nul = slice.indexOf(0)
    return Buffer.from(nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8')
  }
  let off = 0
  let paxPath: string | null = null
  while (off + 512 <= tar.length) {
    // Two consecutive zero blocks end the archive.
    if (tar.subarray(off, off + 512).every((b) => b === 0)) break
    const sizeOctal = str(off + 124, 12).trim()
    const size = parseInt(sizeOctal, 8)
    if (!Number.isFinite(size) || size < 0) break
    const typeflag = String.fromCharCode(tar[off + 156] ?? 0)
    const dataStart = off + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) break
    if (typeflag === 'x' || typeflag === 'g') {
      // PAX header: records are "<len> key=value\n". Only `path` is taken, and a
      // global ('g') header is ignored for naming (treated like a per-file one is
      // never wrong here because we only read `path`).
      const body = Buffer.from(tar.subarray(dataStart, dataEnd)).toString('utf8')
      const m = body.match(/\d+ path=([^\n]*)\n/)
      if (m && typeflag === 'x') paxPath = m[1] ?? null
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const prefix = str(off + 345, 155)
      const name = str(off, 100)
      const full = paxPath ?? (prefix ? `${prefix}/${name}` : name)
      paxPath = null
      out.set(full, tar.subarray(dataStart, dataEnd))
      if (out.size > MAX_ENTRIES) break
    } else {
      paxPath = null
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return out
}

function gunzip(buf: Uint8Array): Uint8Array {
  return zlib.gunzipSync(buf, { maxOutputLength: MAX_UNPACKED })
}

// A zip, read from its central directory (the authority on each entry's name,
// method and compressed size). Entries are inflated in memory with a hard output
// cap, so a crafted entry raises rather than exhausting memory. zip64 and
// encrypted entries are not handled: such an archive raises and falls open.
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  // End of central directory: scan back for its signature.
  let eocd = -1
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 0x10000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true) // central directory offset
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip: zip64 unsupported')
  let total = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip: bad central record')
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOff = dv.getUint32(p + 42, true)
    const name = Buffer.from(zip.subarray(p + 46, p + 46 + nameLen)).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue // directory entry
    if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('zip: bad local header')
    const lNameLen = dv.getUint16(localOff + 26, true)
    const lExtraLen = dv.getUint16(localOff + 28, true)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const comp = zip.subarray(dataStart, dataStart + compSize)
    let data: Uint8Array
    if (method === 0) data = comp
    else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: MAX_UNPACKED - total })
    else throw new Error(`zip: unsupported method ${method}`)
    total += data.byteLength
    if (total > MAX_UNPACKED) throw new Error('zip: unpacked too large')
    out.set(name, data)
    if (out.size > MAX_ENTRIES) throw new Error('zip: too many entries')
  }
  return out
}

// Decode entries to source, after stripping an archive's path prefix to the
// package-relative paths the graph uses (dependency-symbols extract.ts). `strip`
// returns the package-relative path, or null to drop the entry.
function toSource(raw: Map<string, Uint8Array>, strip: (p: string) => string | null): Map<string, string> {
  const out = new Map<string, string>()
  for (const [rawPath, bytes] of raw) {
    const rel = strip(rawPath.replace(/\\/g, '/'))
    if (rel === null || rel === '' || !isPackageSource(rel)) continue
    if (bytes.byteLength > MAX_FILE) continue
    out.set(rel, Buffer.from(bytes).toString('utf8'))
  }
  return out
}

// npm tarballs root every entry at `package/`.
const npmStrip = (p: string) => (p.startsWith('package/') ? p.slice('package/'.length) : p)
// A wheel is already import-rooted (`jinja2/filters.py`); its `.dist-info` and
// `.data` entries carry no source extension, so isPackageSource drops them.
const wheelStrip = (p: string) => p
// An sdist roots at `<name>-<version>/`, often over a `src/` layout. Strip the
// single top directory, then a leading `src/`, to reach the import root.
const sdistStrip = (p: string): string | null => {
  const i = p.indexOf('/')
  if (i < 0) return null
  const rest = p.slice(i + 1)
  return rest.startsWith('src/') ? rest.slice(4) : rest
}
// A Go module zip roots at `<module>@<version>/`; the module path holds slashes,
// so strip everything up to and including the first `@<version>/`.
const goStrip = (version: string) => (p: string): string | null => {
  const marker = `@${version}/`
  const idx = p.indexOf(marker)
  return idx < 0 ? null : p.slice(idx + marker.length)
}

interface ReleaseSource {
  versions: string[]
  // Package-relative source files for one version; throws on any fetch or read
  // failure, which buildFixDiff turns into a fail-open (no fixDiff).
  fetchSource: (version: string) => Promise<Map<string, string>>
}

async function npmSource(name: string, fetchImpl: typeof fetch): Promise<ReleaseSource> {
  const doc = (await fetchJson(fetchImpl, `${NPM_REGISTRY}/${name.replace(/\//g, '%2f')}`)) as {
    versions?: Record<string, { dist?: { tarball?: string } }>
  }
  const versions = Object.keys(doc.versions ?? {})
  return {
    versions,
    fetchSource: async (version) => {
      const tarball = doc.versions?.[version]?.dist?.tarball
      if (!tarball) throw new Error(`npm: no tarball for ${name}@${version}`)
      return toSource(readTar(gunzip(await fetchBytes(fetchImpl, tarball))), npmStrip)
    },
  }
}

async function pypiSource(name: string, fetchImpl: typeof fetch): Promise<ReleaseSource> {
  const doc = (await fetchJson(fetchImpl, `${PYPI}/${encodeURIComponent(name)}/json`)) as {
    releases?: Record<string, Array<{ filename?: string; url?: string; packagetype?: string; yanked?: boolean }>>
  }
  const releases = doc.releases ?? {}
  return {
    versions: Object.keys(releases),
    fetchSource: async (version) => {
      const files = (releases[version] ?? []).filter((f) => f.url && !f.yanked)
      const wheel = files.find((f) => f.packagetype === 'bdist_wheel' || f.filename?.endsWith('.whl'))
      if (wheel?.url) return toSource(readZip(await fetchBytes(fetchImpl, wheel.url)), wheelStrip)
      const sdist = files.find((f) => f.packagetype === 'sdist' || /\.(tar\.gz|tgz|zip)$/.test(f.filename ?? ''))
      if (!sdist?.url) throw new Error(`pypi: no distribution for ${name} ${version}`)
      const bytes = await fetchBytes(fetchImpl, sdist.url)
      if (sdist.filename?.endsWith('.zip')) return toSource(readZip(bytes), sdistStrip)
      return toSource(readTar(gunzip(bytes)), sdistStrip)
    },
  }
}

async function goSource(name: string, fetchImpl: typeof fetch): Promise<ReleaseSource> {
  const esc = goEscape(name)
  // Capped like the archives: the list is text, not a decompress path, but it's
  // still untrusted, so no unbounded read anywhere in this module.
  const listBytes = await fetchBytes(fetchImpl, `${GO_PROXY}/${esc}/@v/list`)
  const versions = Buffer.from(listBytes).toString('utf8').split('\n').map((v) => v.trim()).filter(Boolean)
  return {
    versions,
    fetchSource: async (version) => {
      const bytes = await fetchBytes(fetchImpl, `${GO_PROXY}/${esc}/@v/${goEscape(version)}.zip`)
      return toSource(readZip(bytes), goStrip(version))
    },
  }
}

function releaseSource(ecosystem: string, name: string, fetchImpl: typeof fetch): Promise<ReleaseSource> | null {
  if (ecosystem === 'npm') return npmSource(name, fetchImpl)
  if (ecosystem === 'PyPI') return pypiSource(name, fetchImpl)
  if (ecosystem === 'Go') return goSource(name, fetchImpl)
  return null
}

/**
 * The fix-diff for one advisory on one package: the symbols its first fixed
 * release changed (advisory-cache.md §4), computed with NEAT's own extraction
 * (computeFixDiff) over the release before the fix and the fix itself. Returns
 * undefined, never throws, when there's no fixed version, no release pair to
 * diff, an unsupported ecosystem, or any fetch or archive failure. The caller
 * then leaves the advisory without a fixDiff and the card falls back to package
 * grain.
 */
export async function buildFixDiff(
  advisory: Advisory,
  pkg: { ecosystem: string; name: string },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<FixDiff | undefined> {
  try {
    const fetchImpl = opts.fetchImpl ?? fetch
    const affected = advisory.affected.filter((p) => p.ecosystem === pkg.ecosystem && sameName(pkg.ecosystem, p.name, pkg.name))
    if (affected.length === 0) return undefined
    const fix = earliestFix(affected, pkg.ecosystem)
    if (!fix) return undefined
    const sourceP = releaseSource(pkg.ecosystem, pkg.name, fetchImpl)
    if (!sourceP) return undefined
    const source = await sourceP
    const fixed = pkg.ecosystem === 'Go' ? ensureV(fix.fixed) : fix.fixed
    const pair = fixDiffPair(pkg.ecosystem, source.versions, fixed, fix.introduced)
    if (!pair) return undefined
    const [from, to] = await Promise.all([source.fetchSource(pair.from), source.fetchSource(pair.to)])
    if (from.size === 0 && to.size === 0) return undefined
    const text = `${advisory.summary}\n${advisory.details}`
    return computeFixDiff({ version: pair.from, files: from }, { version: pair.to, files: to }, text)
  } catch {
    return undefined
  }
}
