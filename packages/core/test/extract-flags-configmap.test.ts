import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { configMapFlagsFromYaml } from '../src/extract/flags-configmap.js'
import type { GraphEdge, InfraNode } from '@neat.is/types'
import { EdgeType, Provenance } from '@neat.is/types'

// Flag grain, second EXTRACTED source (#1454): flag definitions embedded in a
// Kubernetes ConfigMap. The fixture is SREGym's train-ticket fork: a Helm
// template declaring 22 flagd flags, of which three are read in source.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'flagd-configmap-train-ticket')

const keys = (text: string): string[] =>
  configMapFlagsFromYaml(text, ['flagd']).flatMap((c) => [...c.flags.keys()].map((k) => `${c.provider}:${k}`))

const FLAG = (name: string, dv = '"off"') => `      ${name}:
        state: ENABLED
        variants:
          "on": true
          "off": false
        defaultVariant: ${dv}`

describe('configMapFlagsFromYaml', () => {
  it('reads a flag document from a ConfigMap data value, through Helm templating', () => {
    expect(
      keys(`{{- if .Values.flags.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: flagd-config
  namespace: {{ .Release.Namespace }}
data:
  flags.yaml: |
    flags:
${FLAG('a')}
${FLAG('b', '{{ .Values.bDefault }}')}
{{- end }}
`),
    ).toEqual(['flagd:a']) // b's default comes from a template value: unclaimed
  })

  it('reads JSON in a data value, and a provider named by the data key', () => {
    expect(
      keys(`kind: ConfigMap
metadata: { name: app-config }
data:
  flagd.json: '{"flags": {"x": {"state": "ENABLED", "variants": {"on": true}, "defaultVariant": "on"}}}'
`),
    ).toEqual(['flagd:x'])
  })

  it('reads nothing without a named provider, from another kind, or from a broken file', () => {
    expect(keys(`kind: ConfigMap\nmetadata: { name: settings }\ndata:\n  flags.yaml: |\n    flags:\n${FLAG('a')}\n`)).toEqual([])
    expect(keys(`kind: Secret\nmetadata: { name: flagd }\ndata:\n  flags.yaml: |\n    flags:\n${FLAG('a')}\n`)).toEqual([])
    expect(keys(`kind: ConfigMap\nmetadata: { name: flagd\n  : : [`)).toEqual([])
  })
})

describe('flagd ConfigMap on SREGym train-ticket (extractFromDirectory)', () => {
  let store: InfraNode
  beforeAll(async () => {
    resetGraph()
    await extractFromDirectory(getGraph(), FIXTURE, { announce: false })
    store = getGraph().getNodeAttributes('infra:flag-store:flagd') as InfraNode
  })

  it('declares all 22 flags from the Helm template', () => {
    expect(store.kind).toBe('flag-store')
    expect(store.flags).toHaveLength(22)
    expect(store.flags!.every((f) => f.declaredIn === 'templates/flagd-config.yaml')).toBe(true)
    expect(store.flags!.find((f) => f.key === 'tt-feat-17')?.declared).toEqual({
      state: 'ENABLED',
      defaultVariant: 'off',
      variants: { off: false, on: true },
    })
  })

  it('links the three flags read in source to their services; the other 19 have no reader', () => {
    const read = Object.fromEntries(
      store.flags!.filter((f) => f.readers?.length).map((f) => [f.key, f.readers!.map((r) => r.service)]),
    )
    expect(read).toEqual({
      'tt-feat-01': ['service:ts-cancel-service'],
      'tt-feat-17': ['service:ts-voucher-service'],
      'tt-feat-22': ['service:ts-contacts-service'],
    })
    const sources: string[] = []
    getGraph().forEachInEdge('infra:flag-store:flagd', (_e, a) => {
      const e = a as GraphEdge
      if (e.type === EdgeType.CONNECTS_TO && e.provenance === Provenance.EXTRACTED) sources.push(e.source)
    })
    expect(sources.sort()).toEqual([
      'file:ts-cancel-service:src/main/java/cancel/async/AsyncTask.java',
      'file:ts-contacts-service:src/main/java/contacts/service/ContactsServiceImpl.java',
      'file:ts-voucher-service:server.py',
    ])
  })
})
