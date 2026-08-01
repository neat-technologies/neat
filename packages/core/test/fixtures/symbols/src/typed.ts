// Heavily type-annotated TypeScript: generics, typed params, typed returns, a
// typed arrow-const, and a generic class. The tree-sitter-javascript grammar
// cannot parse these — it emits ERROR nodes that swallow the definitions — so
// this file is the regression guard that symbol extraction uses the TypeScript
// grammar (ADR-158). Under the JS grammar most of these symbols disappear.

export function mapValues<T, R>(obj: Record<string, T>, fn: (v: T) => R): Record<string, R> {
  const out: Record<string, R> = {}
  for (const k of Object.keys(obj)) out[k] = fn(obj[k]!)
  return out
}

export const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n))

export async function fetchJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url)
  return (await res.json()) as T
}

export class Box<T> {
  constructor(private value: T) {}

  get(): T {
    return this.value
  }
}
