import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract/index.js'
import { discoverServices } from '../src/extract/services.js'
import { goImports } from '../src/extract/go.js'

// ADR-255 — DeathStarBench hotelReservation is one go.mod with one
// `cmd/<name>/main.go` per deployed service and the code under `services/<name>/`.
// Discovery used to mint a single `service:hotelReservation` for all of it, while
// each binary reports its own service.name at runtime. The tree below has hotel's
// shape: two binaries, their service packages, a proto package both reach, and a
// shared tracing package.

const MOD = 'github.com/delimitrou/DeathStarBench/tree/master/hotelReservation'

const TREE: Record<string, string> = {
  'go.mod': `module ${MOD}\n\ngo 1.18\n\nrequire (\n\tgoogle.golang.org/grpc v1.56.3\n)\n`,
  'cmd/frontend/main.go': `package main

import (
	"${MOD}/services/frontend"
	"${MOD}/tracing"
)

func main() { frontend.Run(tracing.Init()) }
`,
  'cmd/geo/main.go': `package main

import (
	"${MOD}/services/geo"
	"${MOD}/tracing"
)

func main() { geo.Run(tracing.Init()) }
`,
  'services/frontend/server.go': `package frontend

import (
	"net/http"

	geo "${MOD}/services/geo/proto"
	"${MOD}/tracing"
)

func Run(t tracing.T) {
	_ = geo.NewGeoClient
	mux := tracing.NewServeMux(t)
	mux.Handle("/hotels", http.HandlerFunc(searchHandler))
	mux.HandleFunc("GET /hotels/{id}", hotelHandler)
}
`,
  'services/frontend/static/index.html': '<html></html>\n',
  'services/geo/server.go': `package geo

import pb "${MOD}/services/geo/proto"

func Run(t interface{}) { _ = pb.RegisterGeoServer }
`,
  'services/geo/proto/geo.pb.go': 'package geo\n\nfunc NewGeoClient() {}\nfunc RegisterGeoServer() {}\n',
  'services/geo/proto/geo.proto': 'syntax = "proto3";\npackage geo;\nservice Geo { rpc Nearby(Request) returns (Result); }\nmessage Request {}\nmessage Result {}\n',
  'tracing/tracing.go': 'package tracing\n\ntype T struct{}\n\nfunc Init() T { return T{} }\nfunc NewServeMux(t T) *Mux { return nil }\n',
}

async function writeTree(root: string, tree: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(tree)) {
    const abs = path.join(root, ...rel.split('/'))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, body)
  }
}

function ownerOfFile(g: NeatGraph, relPath: string): string[] {
  return g
    .filterNodes((_id, a) => (a as GraphNode).type === NodeType.FileNode && (a as { path?: string }).path === relPath)
    .flatMap((id) =>
      g
        .inboundEdges(id)
        .map((e) => g.getEdgeAttributes(e) as GraphEdge)
        .filter((e) => e.type === EdgeType.CONTAINS)
        .map((e) => e.source),
    )
    .sort()
}

describe('a Go module with several binaries is one service per binary (ADR-255)', () => {
  let root: string
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-go-bins-'))
    await writeTree(path.join(root, 'hotelReservation'), TREE)
  })
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reads import paths from both import forms', () => {
    expect(goImports('package x\n\nimport "a/b"\nimport (\n\tc "d/e" // why\n\t"f"\n)\n').sort()).toEqual(['a/b', 'd/e', 'f'])
  })

  it('discovers frontend, geo and the module service', async () => {
    const services = await discoverServices(root)
    expect(services.map((s) => s.node.name).sort()).toEqual(['frontend', 'geo', 'hotelReservation'])
    for (const s of services) expect(s.node.language).toBe('go')
  })

  it('gives each binary the packages only it reaches, and keeps shared code on the module', async () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    await extractFromDirectory(g, root)
    expect(ownerOfFile(g, 'cmd/frontend/main.go')).toEqual(['service:frontend'])
    expect(ownerOfFile(g, 'services/frontend/server.go')).toEqual(['service:frontend'])
    expect(ownerOfFile(g, 'cmd/geo/main.go')).toEqual(['service:geo'])
    expect(ownerOfFile(g, 'services/geo/server.go')).toEqual(['service:geo'])
    // Reached by both binaries: shared, never duplicated.
    expect(ownerOfFile(g, 'services/geo/proto/geo.pb.go')).toEqual(['service:hotelReservation'])
    expect(ownerOfFile(g, 'tracing/tracing.go')).toEqual(['service:hotelReservation'])
  })

  it("puts frontend's route on service:frontend", async () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    await extractFromDirectory(g, root)
    const routes = g.filterNodes((_id, a) => (a as GraphNode).type === NodeType.RouteNode)
    const owners = routes.map((id) => (g.getNodeAttributes(id) as { service: string }).service)
    // The Go 1.22 pattern is read on any base; hotel's own exact paths join it once
    // the net/http exact-path reader (ADR-254) is in. Either way, frontend owns them.
    expect(owners).toContain('frontend')
    for (const o of owners) expect(o).toBe('frontend')
  })

  it('a module with a single main is unchanged', async () => {
    const one = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-go-one-'))
    try {
      const tree = { ...TREE }
      delete tree['cmd/geo/main.go']
      await writeTree(path.join(one, 'hotelReservation'), tree)
      const services = await discoverServices(one)
      expect(services.map((s) => s.node.name)).toEqual(['hotelReservation'])
    } finally {
      await fs.rm(one, { recursive: true, force: true })
    }
  })
})
