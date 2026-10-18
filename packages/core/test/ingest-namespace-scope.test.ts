import { describe, it, expect } from 'vitest'
import { parseOtlpRequest, type OtlpTracesRequest } from '../src/otel.js'
import {
  declaredNamespacesByProject,
  namespaceAllowed,
  type K8sSubstrateConfig,
} from '../src/connectors/kubernetes/substrate.js'

// #1485 — scope OTel ingest to a project's declared k8s namespaces. On a collector
// shared by several apps, a span from a neighbour app's namespace is dropped rather
// than fused into the wrong project's graph (which led 9/35 bench cards with a
// neighbour app's errors). A span with no namespace, or a project that declares
// none, keeps today's behaviour.

function spanBody(ns: string | undefined, service = 'cart'): OtlpTracesRequest {
  const attributes: { key: string; value: { stringValue: string } }[] = [
    { key: 'service.name', value: { stringValue: service } },
  ]
  if (ns) attributes.push({ key: 'k8s.namespace.name', value: { stringValue: ns } })
  return {
    resourceSpans: [
      {
        resource: { attributes },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 't',
                spanId: 's',
                name: 'op',
                kind: 2,
                startTimeUnixNano: '0',
                endTimeUnixNano: '0',
                attributes: [],
              },
            ],
          },
        ],
      },
    ],
  }
}

describe('ingest namespace scoping (#1485)', () => {
  it('parses k8s.namespace.name off the resource onto the span', () => {
    expect(parseOtlpRequest(spanBody('astronomy-shop'))[0]!.k8sNamespace).toBe('astronomy-shop')
    expect(parseOtlpRequest(spanBody(undefined))[0]!.k8sNamespace).toBeUndefined()
  })

  it('groups declared namespaces by project; an unbound entry binds to the single project', () => {
    const config = {
      version: 1,
      deployments: [
        { id: 'a', project: 'astro', namespace: 'astronomy-shop' },
        { id: 'b', project: 'astro', namespace: 'astronomy-extra' },
        { id: 'c', namespace: 'hotel' }, // unbound
      ],
    } as unknown as K8sSubstrateConfig

    const bound = declaredNamespacesByProject(config)
    expect([...(bound.get('astro') ?? [])].sort()).toEqual(['astronomy-extra', 'astronomy-shop'])
    expect(bound.get('hotel')).toBeUndefined() // unbound entry, no single project → skipped

    const withSingle = declaredNamespacesByProject(config, 'solo')
    expect([...(withSingle.get('solo') ?? [])]).toEqual(['hotel'])
  })

  it('allows a declared namespace, drops one outside it, keeps a namespaceless or unscoped span', () => {
    const declared = new Set(['astronomy-shop'])
    expect(namespaceAllowed(declared, 'astronomy-shop')).toBe(true) // declared → keep
    expect(namespaceAllowed(declared, 'hotel-reservation')).toBe(false) // neighbour → drop
    expect(namespaceAllowed(declared, undefined)).toBe(true) // no namespace → keep
    expect(namespaceAllowed(undefined, 'anything')).toBe(true) // project unscoped → keep
    expect(namespaceAllowed(new Set(), 'anything')).toBe(true) // empty declared → keep
  })

  it('two namespaces on a shared collector, one declared: only the declared one ingests', () => {
    const declared = new Set(['astronomy-shop'])
    const mine = parseOtlpRequest(spanBody('astronomy-shop'))[0]!
    const neighbour = parseOtlpRequest(spanBody('hotel-reservation'))[0]!
    expect(namespaceAllowed(declared, mine.k8sNamespace)).toBe(true)
    expect(namespaceAllowed(declared, neighbour.k8sNamespace)).toBe(false)
  })
})
