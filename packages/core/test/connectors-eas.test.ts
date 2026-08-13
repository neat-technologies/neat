import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NodeType, serviceId, configId, type ErrorEvent } from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import { readErrorEvents } from '../src/ingest.js'
import { createEasConnector, fetchErroredBuilds, type EasBuild } from '../src/connectors/eas/index.js'
import { resetJunctionRateLimiters } from '../src/connectors/junction.js'
import type { NeatGraph } from '../src/graph.js'

// ADR-185 — the EAS build-failure connector, the first incident-emitting
// connector (connectors.md §10). These tests run the REAL extractor over a real
// Expo/EAS fixture (package.json + app.json + eas.json + index.js), then drive
// real ERRORED builds through the connector via `runConnectorPoll`, and assert
// each build failure lands as an OBSERVED incident on the node the EXTRACTOR
// produced for the same repo — the fuse-not-twin discipline two-sided-observed
// checks for edges, here for incidents.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EAS_FIXTURE = path.resolve(__dirname, 'fixtures', 'eas-app')

const APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const NEAT_SERVICE = 'eas-app'
const EAS_API = 'https://api.expo.dev/graphql'

// A build's `completedAt` is "now" so the poll's default lookback window always
// includes it; `createdAt` is a fixed value so the passthrough attribute is
// deterministic to assert.
function nowIso(): string {
  return new Date().toISOString()
}

function build(overrides: Partial<EasBuild> & { id: string }): EasBuild {
  return {
    status: 'ERRORED',
    platform: 'ANDROID',
    buildProfile: 'production',
    gitCommitHash: 'abc1234',
    gitRef: 'refs/heads/main',
    isGitWorkingTreeDirty: false,
    createdAt: '2026-08-13T09:00:00.000Z',
    completedAt: nowIso(),
    logFileUrls: [`https://logs.expo.dev/${overrides.id}`],
    ...overrides,
  }
}

// A fake `fetch` standing in for the Expo GraphQL API and the signed log URLs.
// The GraphQL call returns one offset page of builds; anything else is treated as
// a log URL and returns a canned log body.
function fakeFetch(pages: EasBuild[][], logBody = 'gradle line 1\nFAILURE: Build failed\n'): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === EAS_API) {
      const body = JSON.parse(String(init?.body)) as { variables: { offset: number; limit: number } }
      const idx = body.variables.limit > 0 ? Math.floor(body.variables.offset / body.variables.limit) : 0
      const builds = pages[idx] ?? []
      return new Response(JSON.stringify({ data: { app: { byId: { builds } } } }), { status: 200 })
    }
    return new Response(logBody, { status: 200 })
  }) as unknown as typeof fetch
}

async function freshErrorsPath(): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'neat-eas-'))
  return path.join(dir, 'errors.ndjson')
}

// One poll of the EAS connector against the given build pages, returning the
// incidents written to the ledger.
async function pollIncidents(graph: NeatGraph, pages: EasBuild[][]): Promise<ErrorEvent[]> {
  const { connector, resolveTarget } = createEasConnector(
    graph,
    { appId: APP_ID, serviceName: NEAT_SERVICE, pageSize: 50 },
    fakeFetch(pages),
  )
  const errorsPath = await freshErrorsPath()
  const ctx: ConnectorContext = {
    projectDir: EAS_FIXTURE,
    credentials: { token: 'expo-robot-token' },
    errorsPath,
  }
  await runConnectorPoll(connector, ctx, graph, resolveTarget)
  return readErrorEvents(errorsPath)
}

describe('EAS connector — build failures fuse onto the extracted repo nodes (#996, ADR-185)', () => {
  let graph: NeatGraph

  beforeEach(async () => {
    resetJunctionRateLimiters()
    resetGraph()
    graph = getGraph()
    await extractFromDirectory(graph, EAS_FIXTURE)
  })

  it('extracts the fixture the fusion targets need: a ServiceNode + app.json/eas.json ConfigNodes', () => {
    // The connector fuses onto these; if the extractor stops minting them the
    // fusion assertions below would silently pass onto a twin instead.
    expect(graph.hasNode(serviceId(NEAT_SERVICE))).toBe(true)
    expect(graph.hasNode(configId('eas.json'))).toBe(true)
    expect(graph.hasNode(configId('app.json'))).toBe(true)
    const eas = graph.getNodeAttributes(configId('eas.json')) as { type?: string; name?: string }
    expect(eas.type).toBe(NodeType.ConfigNode)
    expect(eas.name).toBe('eas.json')
  })

  it('INSTALL_DEPENDENCIES failure → incident on the app ServiceNode, carrying commit + logs', async () => {
    const incidents = await pollIncidents(graph, [
      [
        build({
          id: 'b-install',
          error: {
            buildPhase: 'INSTALL_DEPENDENCIES',
            errorCode: 'EAS_BUILD_NPM_INSTALL_FAILED',
            message: 'npm ERR! peer dep conflict',
            docsUrl: 'https://docs.expo.dev/build-reference/npm-hooks/',
          },
        }),
      ],
    ])
    expect(incidents).toHaveLength(1)
    const ev = incidents[0]!
    // package.json is a ServiceNode, not a ConfigNode (ADR-185), so a
    // dependency-phase failure anchors to the app's ServiceNode.
    expect(ev.affectedNode).toBe(serviceId(NEAT_SERVICE))
    expect(ev.errorType).toBe('eas-build-failure')
    expect(ev.id).toBe('eas:build:b-install')
    expect(ev.errorMessage).toContain('INSTALL_DEPENDENCIES')
    expect(ev.attributes?.['eas.buildPhase']).toBe('INSTALL_DEPENDENCIES')
    expect(ev.attributes?.['eas.gitCommitHash']).toBe('abc1234')
    expect(ev.attributes?.['eas.errorCode']).toBe('EAS_BUILD_NPM_INSTALL_FAILED')
    expect(String(ev.attributes?.['eas.logs'])).toContain('Build failed')
  })

  it('READ_EAS_JSON failure → incident on the eas.json ConfigNode the extractor produced (fuse, not twin)', async () => {
    const incidents = await pollIncidents(graph, [
      [
        build({
          id: 'b-eas',
          error: { buildPhase: 'READ_EAS_JSON', message: 'eas.json is not valid JSON' },
        }),
      ],
    ])
    expect(incidents).toHaveLength(1)
    const ev = incidents[0]!
    // The fusion assertion: affectedNode is the exact ConfigNode id the extractor
    // minted for this repo's eas.json, and that node really is in the graph.
    expect(ev.affectedNode).toBe(configId('eas.json'))
    expect(graph.hasNode(ev.affectedNode)).toBe(true)
    expect(ev.attributes?.['eas.buildPhase']).toBe('READ_EAS_JSON')
  })

  it('READ_APP_CONFIG failure → incident on the app.json ConfigNode', async () => {
    const incidents = await pollIncidents(graph, [
      [build({ id: 'b-appcfg', error: { buildPhase: 'READ_APP_CONFIG', message: 'app.json invalid' } })],
    ])
    expect(incidents).toHaveLength(1)
    expect(incidents[0]!.affectedNode).toBe(configId('app.json'))
  })

  it('RUN_GRADLEW failure → incident on the app ServiceNode with logs, never a ConfigNode', async () => {
    const incidents = await pollIncidents(graph, [
      [
        build({
          id: 'b-gradle',
          error: { buildPhase: 'RUN_GRADLEW', message: 'Execution failed for task :app:compileReleaseKotlin' },
        }),
      ],
    ])
    expect(incidents).toHaveLength(1)
    const ev = incidents[0]!
    expect(ev.affectedNode).toBe(serviceId(NEAT_SERVICE))
    // A native-compile phase must NOT be misattributed to a config file.
    expect(ev.affectedNode).not.toBe(configId('eas.json'))
    expect(ev.affectedNode).not.toBe(configId('app.json'))
    expect(String(ev.attributes?.['eas.logs'])).toContain('Build failed')
  })

  it('SPIN_UP_BUILDER (infra) failure → mints nothing (transient filter)', async () => {
    const incidents = await pollIncidents(graph, [
      [build({ id: 'b-spin', error: { buildPhase: 'SPIN_UP_BUILDER', message: 'could not provision builder' } })],
    ])
    expect(incidents).toHaveLength(0)
  })

  it('an INTERNAL_SERVER_ERROR-class errorCode → mints nothing even at a repo phase', async () => {
    const incidents = await pollIncidents(graph, [
      [
        build({
          id: 'b-internal',
          error: { buildPhase: 'RUN_GRADLEW', errorCode: 'EAS_BUILD_INTERNAL_SERVER_ERROR', message: 'internal error' },
        }),
      ],
    ])
    expect(incidents).toHaveLength(0)
  })

  it('a dirty working tree lowers confidence and is called out in the incident', async () => {
    const incidents = await pollIncidents(graph, [
      [
        build({
          id: 'b-dirty',
          isGitWorkingTreeDirty: true,
          error: { buildPhase: 'RUN_GRADLEW', message: 'compile failed' },
        }),
      ],
    ])
    expect(incidents).toHaveLength(1)
    const ev = incidents[0]!
    expect(ev.attributes?.['eas.gitWorkingTreeDirty']).toBe(true)
    expect(ev.attributes?.['eas.confidence']).toBe('low')
    expect(ev.errorMessage).toContain('dirty working tree')
  })

  it('a mix of ERRORED, transient, and a stray FINISHED row → only the real repo failures mint', async () => {
    const incidents = await pollIncidents(graph, [
      [
        build({ id: 'b-eas2', error: { buildPhase: 'READ_EAS_JSON', message: 'bad eas.json' } }),
        build({ id: 'b-spin2', error: { buildPhase: 'PREPARE_CREDENTIALS', message: 'no creds' } }),
        build({ id: 'b-finished', status: 'FINISHED', error: null }),
      ],
    ])
    expect(incidents).toHaveLength(1)
    expect(incidents[0]!.id).toBe('eas:build:b-eas2')
  })
})

describe('EAS connector — pagination dedupes builds by id (#996, ADR-185)', () => {
  beforeEach(() => resetJunctionRateLimiters())

  it('a build id that appears on two overlapping pages is fetched once', async () => {
    const b1 = build({ id: 'p1' })
    const b2 = build({ id: 'p2' })
    const b3 = build({ id: 'p3' })
    // pageSize 2: page 0 = [p1, p2] (full → continue), page 1 = [p2, p3] (p2 dup,
    // p3 new → continue), page 2 = [] → stop.
    const fetchImpl = fakeFetch([
      [b1, b2],
      [b2, b3],
      [],
    ])
    const builds = await fetchErroredBuilds('t', { appId: APP_ID, pageSize: 2, maxPages: 5 }, fetchImpl)
    expect(builds.map((b) => b.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('drops a non-ERRORED row even if the server filter returned it', async () => {
    const fetchImpl = fakeFetch([
      [build({ id: 'ok', status: 'FINISHED', error: null }), build({ id: 'bad', error: { buildPhase: 'RUN_GRADLEW' } })],
      [],
    ])
    const builds = await fetchErroredBuilds('t', { appId: APP_ID, pageSize: 2, maxPages: 5 }, fetchImpl)
    expect(builds.map((b) => b.id)).toEqual(['bad'])
  })

  it('fails loud on a GraphQL schema/shape error rather than dropping builds', async () => {
    const drift = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Cannot query field "buildPhase"' }] }), {
        status: 200,
      })) as unknown as typeof fetch
    await expect(fetchErroredBuilds('t', { appId: APP_ID }, drift)).rejects.toThrow(/Expo GraphQL errors/)
  })
})
