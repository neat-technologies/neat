// PEP 440 version ordering, for PyPI records that give a range but no explicit
// version list (advisory-cache.md §3). Covers the public version scheme: epoch,
// release segments, pre (a/b/rc), post and dev releases, and local versions
// (`+local`, which sort after the same public version). A string that isn't a valid PEP 440
// version returns null, and the caller treats that as "can't evaluate".
//
// https://peps.python.org/pep-0440/#version-scheme

export interface Pep440 {
  epoch: number
  release: number[]
  pre: [number, number] | null // [0=a 1=b 2=rc, n]
  post: number | null
  dev: number | null
  local: Array<number | string> | null
}

const RE =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i

const PRE_RANK: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 }

export function parsePep440(raw: string): Pep440 | null {
  const m = RE.exec(raw.trim())
  if (!m) return null
  return {
    epoch: m[1] ? Number(m[1]) : 0,
    release: m[2]!.split('.').map(Number),
    pre: m[3] ? [PRE_RANK[m[3].toLowerCase()]!, Number(m[4] || 0)] : null,
    post: m[5] !== undefined ? Number(m[5]) : m[6] !== undefined ? Number(m[6] || 0) : null,
    dev: m[7] !== undefined ? Number(m[7] || 0) : null,
    local: m[8] ? m[8].split(/[-_.]/).map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg.toLowerCase())) : null,
  }
}

function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// The PEP 440 sort key, compared field by field. Release segments compare with
// trailing zeros ignored (1.0 == 1.0.0). For a release, dev < pre < (final) < post.
export function comparePep440(a: Pep440, b: Pep440): number {
  if (a.epoch !== b.epoch) return cmpNum(a.epoch, b.epoch)
  const len = Math.max(a.release.length, b.release.length)
  for (let i = 0; i < len; i++) {
    const c = cmpNum(a.release[i] ?? 0, b.release[i] ?? 0)
    if (c !== 0) return c
  }
  // Pre-release slot: a dev-only release (1.0.dev1) sorts before any pre-release.
  const preKey = (v: Pep440): [number, number] =>
    v.pre ? [v.pre[0], v.pre[1]] : v.post === null && v.dev !== null ? [-1, 0] : [3, 0]
  const [pa, pb] = [preKey(a), preKey(b)]
  if (pa[0] !== pb[0]) return cmpNum(pa[0], pb[0])
  if (pa[1] !== pb[1]) return cmpNum(pa[1], pb[1])
  const postKey = (v: Pep440) => (v.post === null ? -1 : v.post)
  if (postKey(a) !== postKey(b)) return cmpNum(postKey(a), postKey(b))
  const devKey = (v: Pep440) => (v.dev === null ? Number.POSITIVE_INFINITY : v.dev)
  if (devKey(a) !== devKey(b)) return cmpNum(devKey(a), devKey(b))
  // Local: none sorts before any; segments compare numerically when both are
  // numbers, a number sorts after a string, strings compare lexically, and a
  // shorter label that is a prefix of a longer one sorts first.
  if (a.local === null || b.local === null) return a.local === b.local ? 0 : a.local === null ? -1 : 1
  for (let i = 0; i < Math.max(a.local.length, b.local.length); i++) {
    const [x, y] = [a.local[i], b.local[i]]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return cmpNum(x, y)
    } else if (typeof x !== typeof y) {
      return typeof x === 'number' ? 1 : -1
    } else if (x !== y) {
      return String(x) < String(y) ? -1 : 1
    }
  }
  return 0
}
