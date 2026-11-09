import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { nginxProxiesFromConfig } from '../src/extract/infra/nginx.js'
import { discoverDockerfileService } from '../src/extract/dockerfile-service.js'
import type { GraphEdge, RouteNode, ServiceNode } from '@neat.is/types'
import { EdgeType, Provenance, routeId, serviceId } from '@neat.is/types'

// nginx proxy_pass as an edge (config as a source). train-ticket's ts-ui-dashboard
// is an OpenResty image with only a config and static files: it becomes a service
// and its `location /api/v1/ { proxy_pass http://ts-gateway-service:18888; }`
// becomes a route plus a CALLS to the gateway. socialNetwork's nginx-thrift serves
// every location from Lua, so nothing is minted from it.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures')

describe('nginxProxiesFromConfig', () => {
  it('reads plain, exact and regex locations, resolving an upstream to its servers', () => {
    const got = nginxProxiesFromConfig(`
upstream orders_pool {
  server orders-a:8080 weight=2;
  server orders-b:8080;
}
server {
  listen 80;
  # location /commented { proxy_pass http://nope; }
  location /api/ { proxy_pass http://gateway:18888/; }
  location = /health { proxy_pass http://health; }
  location ~* \\.php$ { proxy_pass http://php-fpm:9000; }
  location /orders/ { proxy_pass http://orders_pool; }
  location /dyn/ { proxy_pass http://$backend; }
  location /lua/ { content_by_lua_block { ngx.say("{ not nginx }") } }
  location /static/ { root /usr/share/nginx/html; }
}`)
    expect(got.map((p) => ({ path: p.locationPath, hosts: p.hosts }))).toEqual([
      { path: '/api/', hosts: ['gateway'] },
      { path: '/health', hosts: ['health'] },
      { path: null, hosts: ['php-fpm'] },
      { path: '/orders/', hosts: ['orders-a', 'orders-b'] },
      { path: '/dyn/', hosts: null },
    ])
  })

  it("mints nothing from socialNetwork's Lua-served nginx-thrift config", () => {
    const conf = readFileSync(path.join(FIXTURES, 'nginx-socialnetwork', 'nginx-web-server', 'conf', 'nginx.conf'), 'utf8')
    expect(nginxProxiesFromConfig(conf)).toEqual([])
  })
})

describe('nginx front-end discovery', () => {
  const mk = async (files: Record<string, string>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-nginx-'))
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
      await fs.writeFile(path.join(dir, rel), content)
    }
    return dir
  }

  it('mints a service for an nginx or OpenResty image that carries a config', async () => {
    const a = await mk({ Dockerfile: 'FROM node:20 AS build\nRUN x\nFROM nginx:1.25-alpine\n', 'conf.d/default.conf': 'server {}' })
    expect((await discoverDockerfileService(path.dirname(a), a))?.node.language).toBe('nginx')
  })

  it('needs both the image and the config', async () => {
    const noConf = await mk({ Dockerfile: 'FROM openresty/openresty:alpine\n' })
    const notNginx = await mk({ Dockerfile: 'FROM busybox\n', 'nginx.conf': 'events {}' })
    expect(await discoverDockerfileService(path.dirname(noConf), noConf)).toBeNull()
    expect(await discoverDockerfileService(path.dirname(notNginx), notNginx)).toBeNull()
  })
})

describe('train-ticket ui-dashboard (extractFromDirectory)', () => {
  beforeAll(async () => {
    resetGraph()
    await extractFromDirectory(getGraph(), path.join(FIXTURES, 'nginx-train-ticket'), { announce: false })
  })

  it('becomes an nginx service with its proxied location as a route', () => {
    expect((getGraph().getNodeAttributes(serviceId('ts-ui-dashboard')) as ServiceNode).language).toBe('nginx')
    expect(getGraph().getNodeAttributes(routeId('ts-ui-dashboard', 'ALL', '/api/v1/')) as RouteNode).toMatchObject({
      framework: 'nginx',
      path: 'nginx.conf',
      line: 41,
    })
  })

  it('calls the gateway from its config file', () => {
    const edge = getGraph().getEdgeAttributes(
      `${EdgeType.CALLS}:file:ts-ui-dashboard:nginx.conf->${serviceId('ts-gateway-service')}`,
    ) as GraphEdge
    expect(edge.provenance).toBe(Provenance.EXTRACTED)
    expect(edge.evidence).toMatchObject({ line: 41, pathTemplate: '/api/v1/' })
  })
})
