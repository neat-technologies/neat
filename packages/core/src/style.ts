// The CLI's presentation layer — one module owns every color and glyph the
// human-facing CLI emits, so the palette stays coherent and turns off cleanly.
//
// It aligns the terminal to the product's visual identity (design-system.md):
// monochrome by default, with the OBSERVED green reserved to mean "observed /
// live". Provenance carries the color — OBSERVED reads green, STALE amber,
// INFERRED cyan, EXTRACTED stays plain — so a fact's trust is legible at a
// glance, the same signal the dashboard and canvas use.
//
// Zero runtime dependencies: the escapes are hand-rolled and gated on a real
// interactive stdout, with NO_COLOR / FORCE_COLOR honored. Piped output, `--json`,
// and CI all resolve to byte-plain text — the styling is additive over the exact
// strings the CLI printed before, never a replacement for them. Every helper is a
// pass-through when color is off, so a caller can wrap freely without branching.

import { Provenance } from '@neat.is/types'

const RESET = '\x1b[0m'

// Enablement, resolved once at load and overridable for tests. Precedence
// follows the community conventions: FORCE_COLOR pins it on, NO_COLOR (any value,
// https://no-color.org) pins it off, a `dumb` terminal is never styled, and the
// default is "on only when stdout is an interactive TTY" — which is what keeps
// pipes and CI plain without any caller opting out.
function computeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== '') {
    return true
  }
  if (env.NO_COLOR !== undefined) return false
  if (env.TERM === 'dumb') return false
  return Boolean(process.stdout && process.stdout.isTTY)
}

let enabled = computeEnabled()

// Test seam: force the enablement either way, or re-read the environment.
export function setColorEnabled(value: boolean): void {
  enabled = value
}
export function refreshColorEnabled(env?: NodeJS.ProcessEnv): void {
  enabled = computeEnabled(env)
}
export function colorEnabled(): boolean {
  return enabled
}

function wrap(open: string, s: string): string {
  return enabled ? `${open}${s}${RESET}` : s
}

// ── Weights ────────────────────────────────────────────────────────────────
export const bold = (s: string): string => wrap('\x1b[1m', s)
export const dim = (s: string): string => wrap('\x1b[2m', s)
export const italic = (s: string): string => wrap('\x1b[3m', s)
export const underline = (s: string): string => wrap('\x1b[4m', s)

// ── Palette ──────────────────────────────────────────────────────────────────
// Truecolor for the brand green (the design-system's #5fcf9e) and the two
// diagnostic hues; a terminal without 24-bit support renders a near neighbour.
// Kept deliberately small — one accent, plus the semantic warn/error/inferred.
const OBSERVED_GREEN = '\x1b[38;2;95;207;158m' // #5fcf9e — observed / live / success
const STALE_AMBER = '\x1b[38;2;214;164;92m' //          — stale / warning
const ERROR_RED = '\x1b[38;2;224;108;108m' //           — failure
const INFERRED_CYAN = '\x1b[38;2;122;162;247m' //       — inferred / stitched

export const green = (s: string): string => wrap(OBSERVED_GREEN, s)
export const amber = (s: string): string => wrap(STALE_AMBER, s)
export const red = (s: string): string => wrap(ERROR_RED, s)
export const cyan = (s: string): string => wrap(INFERRED_CYAN, s)

// Semantic aliases — the names callers reach for, so intent (not hue) is what
// reads at the call site.
export const accent = green // the one accent color
export const ok = green
export const warn = amber
export const error = red

// ── Glyphs ───────────────────────────────────────────────────────────────────
// A tight set, reused everywhere so the CLI's vocabulary stays consistent.
export const sym = {
  ok: '✓',
  fail: '✗',
  warn: '⚠',
  bullet: '•',
  arrow: '→',
  stale: '⋯',
  add: '+',
  dot: '●',
  chevron: '▸',
} as const

// ── Structural helpers ───────────────────────────────────────────────────────

// A section heading — bold in a color terminal, and (deliberately) the bare
// label when color is off, so piped and NO_COLOR output stay exactly the plain
// text they were rather than gaining decorative glyphs.
export function heading(label: string): string {
  return bold(label)
}

// An aligned `label   value` line. The label is dimmed and padded to `width`
// so a column of them lines up.
export function keyval(label: string, value: string, width: number): string {
  return `${dim(label.padEnd(width))}  ${value}`
}

// Color a single provenance token by what it means. The heart of the scheme:
// the same green/amber/cyan the graph uses, so a CLI reader learns provenance
// the way a dashboard reader does. Unknown tokens pass through unstyled.
export function provenanceToken(token: string): string {
  switch (token.trim().toUpperCase()) {
    case Provenance.OBSERVED:
      return green(token)
    case Provenance.STALE:
      return amber(token)
    case Provenance.INFERRED:
      return cyan(token)
    case Provenance.EXTRACTED:
      return dim(token)
    default:
      return token
  }
}

// A composite provenance string ("OBSERVED, EXTRACTED") with each token colored
// and the separators left plain, so the literal text is unchanged when color is
// off.
export function provenance(value: string): string {
  return value
    .split(',')
    .map((part, i) => (i === 0 ? provenanceToken(part) : ' ' + provenanceToken(part.replace(/^\s+/, ''))))
    .join(',')
}

// Width-aware table. Given rows of cells, pad every column to the widest cell in
// it (last column is left unpadded so it can run long). Alignment is computed on
// the plain text, so injected color codes never throw the columns off.
const ANSI = /\x1b\[[0-9;]*m/g
function visibleWidth(s: string): number {
  return s.replace(ANSI, '').length
}
export function table(rows: string[][], gap = 2): string[] {
  if (rows.length === 0) return []
  const cols = Math.max(...rows.map((r) => r.length))
  const widths: number[] = []
  for (let c = 0; c < cols - 1; c++) {
    widths[c] = Math.max(...rows.map((r) => (r[c] ? visibleWidth(r[c]) : 0)))
  }
  const pad = ' '.repeat(gap)
  return rows.map((r) =>
    r
      .map((cell, c) => {
        if (c === r.length - 1) return cell // last cell runs free
        const extra = widths[c] - visibleWidth(cell)
        return cell + ' '.repeat(Math.max(0, extra))
      })
      .join(pad),
  )
}

// Color an already-assembled result block (the middle third of a query verb's
// human output). Provenance tokens take their meaning-color wherever they appear;
// the leading `•` bullets dim back so the fact text carries the line. Purely
// additive — with color off every helper passes through, so the block is the
// exact text it was before.
export function styleBlock(block: string): string {
  return block
    .split('\n')
    .map((line) => {
      let out = line.replace(/\b(OBSERVED|STALE|INFERRED|EXTRACTED)\b/g, (m) => provenanceToken(m))
      out = out.replace(/^(\s*)•/, (_all, indent: string) => `${indent}${dim(sym.bullet)}`)
      return out
    })
    .join('\n')
}

// The verb footer — `confidence: X · provenance: Y` — with the labels dimmed and
// the provenance colored by meaning. The literal words and spacing are untouched,
// so the plain-text (color-off) footer is byte-identical to before.
export function footer(confidence: string, provenanceValue: string): string {
  const prov = provenanceValue === 'n/a' ? dim(provenanceValue) : provenance(provenanceValue)
  return `${dim('confidence:')} ${confidence} ${dim('·')} ${dim('provenance:')} ${prov}`
}

// The compact wordmark. Replaces the six-row block banner: one bold mark, the
// version, and a one-line tagline — brand without shouting on every run. Keeps a
// line carrying `neat.is` + `v<version>` (the single-sourced version string).
export function wordmark(version: string): string {
  const mark = `${accent(sym.chevron)} ${bold('neat')}`
  const expansion = dim('Network Environment Architecture Tools')
  const meta = dim(`neat.is · v${version} · Apache 2.0`)
  return `${mark}  ${expansion}\n${meta}`
}
