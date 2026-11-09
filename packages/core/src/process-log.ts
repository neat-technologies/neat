// Reading a faulted workload's fused process log (ADR-243 `observedDeployContext.processLog`)
// for the line that names its failure, and for the dependency that line points at
// (ADR-262). Pure functions over the log text and a caller-supplied candidate list:
// no graph, no provider knowledge. A line is an error by its log level or by the
// shape of an exception, never by what product printed it.

// Terminal colour and cursor sequences. Go's zerolog console writer, among others,
// colours its level and caller fields, and the k8s log API returns the bytes as written.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

const MAX_LINE_CHARS = 300

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

const ERROR_LEVELS = new Set(['error', 'err', 'fatal', 'ftl', 'panic', 'critical', 'crit', 'severe', 'emerg', 'emergency', 'alert'])

// A level token standing alone in a text line: `FTL`, `[ERROR]`, `E1017 …` is not
// matched (too ambiguous), `level=error` is.
const LEVEL_TOKEN_RE = /(?:^|[\s[|(])(FTL|FATAL|PANIC|CRIT|CRITICAL|ERR|ERROR|SEVERE|EMERG)(?=[\s\]|):]|$)/
const LEVEL_KV_RE = /\b(?:level|lvl|severity)=["']?(error|err|fatal|panic|critical|crit)\b/i
// A runtime's own failure line: `panic: …`, `fatal error: …`, `Error: …`,
// `Exception in thread "main" …`, `pkg.SomeError: …`, `SomeException: …`.
const EXCEPTION_RE =
  /^(?:panic:|fatal error:|error:|Exception in thread\b|(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Error|Exception)(?::|$))/i
const TRACEBACK_RE = /^Traceback \(most recent call last\):/
const LEADING_TIMESTAMP_RE = /^\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/

export interface LogErrorLine {
  // The error line as shown: escapes stripped, a leading timestamp dropped, bounded.
  line: string
  // Index of the line within the stripped log, so the lines before it can be read.
  index: number
}

function display(line: string): string {
  const s = line.replace(LEADING_TIMESTAMP_RE, '').replace(/\s+/g, ' ').trim()
  return s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS - 1)}…` : s
}

// A JSON log record's level and message, when the line is one.
function jsonRecord(line: string): { level?: string; message?: string } | null {
  if (!line.startsWith('{')) return null
  try {
    const rec = JSON.parse(line) as Record<string, unknown>
    const level = [rec.level, rec.severity, rec.lvl, rec.levelname].find((v) => typeof v === 'string') as
      | string
      | undefined
    const message = [rec.message, rec.msg, rec.error, rec.err].find((v) => typeof v === 'string') as
      | string
      | undefined
    return { level, message }
  } catch {
    return null
  }
}

/** The stripped log, split into lines. */
export function logLines(log: string): string[] {
  return stripAnsi(log).split(/\r?\n/)
}

/**
 * The first line of the log that reports an error, by level or by exception shape.
 * A Python traceback reports at its last line (the exception), so a traceback header
 * resolves to the exception line that closes it.
 */
export function firstErrorLine(log: string): LogErrorLine | null {
  const lines = logLines(log)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim()
    if (raw.length === 0) continue
    const rec = jsonRecord(raw)
    if (rec) {
      if (rec.level && ERROR_LEVELS.has(rec.level.toLowerCase())) {
        return { line: display(rec.message ?? raw), index: i }
      }
      continue
    }
    if (TRACEBACK_RE.test(raw)) {
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!
        if (l.length > 0 && !/^\s/.test(l)) return { line: display(l), index: j }
      }
      return { line: display(raw), index: i }
    }
    if (LEVEL_TOKEN_RE.test(raw) || LEVEL_KV_RE.test(raw) || EXCEPTION_RE.test(raw)) {
      return { line: display(raw), index: i }
    }
  }
  return null
}

export interface DependencyCandidate {
  id: string
  // Names the node goes by in text: its name, host, aliases. Shorter than three
  // characters is dropped by the matcher.
  names: string[]
  // Lower ranks first when two candidates are named equally well.
  rank: number
}

export interface NamedDependency {
  id: string
  // The line that named it, as shown.
  line: string
  // True when the error line itself named it; false when a line before it did.
  inErrorLine: boolean
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The longest name of `c` found in `text` as a whole token: not run into by a word
// character or a hyphen on either side, so `mongodb-geo` matches in
// `mongodb-geo:27017` and `mongodb-geo.ns.svc`, and `geo` does not match in it.
function matchLength(text: string, c: DependencyCandidate): number {
  let best = 0
  for (const name of c.names) {
    if (name.length < 3 || name.length <= best) continue
    const re = new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`, 'i')
    if (re.test(text)) best = name.length
  }
  return best
}

function bestIn(text: string, candidates: DependencyCandidate[]): DependencyCandidate | null {
  let best: { c: DependencyCandidate; len: number } | null = null
  for (const c of candidates) {
    const len = matchLength(text, c)
    if (len === 0) continue
    if (
      !best ||
      len > best.len ||
      (len === best.len && (c.rank < best.c.rank || (c.rank === best.c.rank && c.id < best.c.id)))
    ) {
      best = { c, len }
    }
  }
  return best?.c ?? null
}

/**
 * The dependency the log names for its error: the error line first; when it names
 * none of the candidates, the nearest line before it that does. Candidates are the
 * caller's to bound (ADR-262: the seed's own outbound dependencies), so nothing
 * outside them can be named.
 */
export function dependencyNamedInLog(
  log: string,
  error: LogErrorLine,
  candidates: DependencyCandidate[],
): NamedDependency | null {
  if (candidates.length === 0) return null
  const lines = logLines(log)
  const own = bestIn(lines[error.index] ?? '', candidates)
  if (own) return { id: own.id, line: error.line, inErrorLine: true }
  for (let i = error.index - 1; i >= 0; i--) {
    const hit = bestIn(lines[i]!, candidates)
    if (hit) return { id: hit.id, line: display(lines[i]!), inErrorLine: false }
  }
  return null
}
