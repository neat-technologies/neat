import { parseAllDocuments, parse as parseYaml } from 'yaml'
import type { FlagDefinition } from '@neat.is/types'
import { parseFlagDocument } from '../flags.js'

// Flag grain, EXTRACTED side, second source (ADR-242 amendment, #1454): flag
// definitions embedded in a Kubernetes ConfigMap.
//
//   kind: ConfigMap
//   metadata:
//     name: flagd-config
//   data:
//     flags.yaml: |
//       flags:
//         tt-feat-01:
//           state: ENABLED
//           variants: { "on": true, "off": false }
//           defaultVariant: "off"
//
// A data value is read as YAML (which also reads JSON) and is a flag document
// when it holds a `flags` map of definitions, the same shape a flag file holds.
// A ConfigMap carries no `$schema`, so the provider is the one whose name (from
// compat.json's flag-store list) appears in the ConfigMap's name or the data key.
//
// Helm templates are read as text and never rendered. A `{{ … }}` expression is
// swapped for a marker before the parse, and a line holding only a template
// action (`{{- if … }}`) is dropped. A flag whose definition still holds the
// marker came from a template value and stays unclaimed; the rest of the file
// is read. A file that won't parse yields nothing.

const MARKER = '__neat_helm_expr__'

export interface ConfigMapFlags {
  provider: string
  flags: Map<string, FlagDefinition>
}

function untemplate(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*\{\{-?[^}]*-?\}\}\s*$/.test(line))
    .join('\n')
    .replace(/\{\{-?[^}]*?-?\}\}/g, MARKER)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Flag documents in one YAML manifest's ConfigMaps, by provider. */
export function configMapFlagsFromYaml(text: string, providers: readonly string[]): ConfigMapFlags[] {
  const out: ConfigMapFlags[] = []
  let docs
  try {
    docs = parseAllDocuments(untemplate(text))
  } catch {
    return out
  }
  for (const d of docs) {
    if (d.errors.length > 0) continue
    const doc = d.toJS() as unknown
    if (!isRecord(doc) || doc['kind'] !== 'ConfigMap' || !isRecord(doc['data'])) continue
    const name = isRecord(doc['metadata']) && typeof doc['metadata']['name'] === 'string' ? doc['metadata']['name'] : ''
    for (const [key, value] of Object.entries(doc['data'])) {
      if (typeof value !== 'string' || !value.includes('flags')) continue
      const provider = providers.find((p) => name.includes(p) || key.includes(p))
      if (!provider) continue
      let inner: unknown
      try {
        inner = parseYaml(value)
      } catch {
        continue
      }
      // A flag whose raw definition came from a template value is left out.
      if (isRecord(inner) && isRecord(inner['flags'])) {
        const flagsObj = inner['flags']
        for (const k of Object.keys(flagsObj)) {
          if (k.includes(MARKER) || JSON.stringify(flagsObj[k]).includes(MARKER)) delete flagsObj[k]
        }
      }
      const flags = parseFlagDocument(inner)
      if (flags) out.push({ provider, flags })
    }
  }
  return out
}
