import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GraphEdge, RouteNode, ServiceNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  routeId,
} from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { makeEdgeId, type DiscoveredService } from '../shared.js'
import { recordExtractionError, noteExtractedDropped } from '../errors.js'
import { ensureFileNode, snippet, toPosix } from '../calls/shared.js'

// nginx `proxy_pass` — config as a source. A front end that is only nginx (or
// OpenResty) hands requests to a service through its config:
//
//   location /api/v1/ {
//     proxy_pass http://ts-gateway-service:18888;
//   }
//
// For each service directory carrying an nginx config (`nginx.conf`,
// `conf/nginx.conf`, `conf.d/*.conf`), each `location` whose block holds a
// literal `proxy_pass http(s)://<host>[:port][/path]` mints:
//   - a RouteNode for the location path on that service (ALL), when the location
//     is a plain or exact (`=`) path; a regex location (`~`, `~*`) has no path
//     template, so it gets no route, though its proxy edge still stands;
//   - `file ──CALLS──▶ service` from the config file to the service <host> names,
//     matched against service names, directory names and aliases. A host naming an
//     `upstream` block resolves through that block's `server` hosts.
// A host from a variable (`proxy_pass http://$backend`) is recorded as a drop with
// its reason; a literal host naming no service in the graph gets no edge. A
// location served by Lua (`content_by_lua*`) or by files has no proxy_pass and
// mints nothing here.

const CONFIG_CANDIDATES = ['nginx.conf', path.join('conf', 'nginx.conf')]

interface Token {
  text: string
  line: number
}

// nginx's grammar: words, quoted strings, `;`, `{`, `}`, and `#` comments.
function tokenize(text: string): Token[] {
  const out: Token[] = []
  let i = 0
  let line = 1
  while (i < text.length) {
    const c = text[i]!
    if (c === '\n') {
      line++
      i++
    } else if (/\s/.test(c)) {
      i++
    } else if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === ';' || c === '{' || c === '}') {
      out.push({ text: c, line })
      i++
    } else if (c === '"' || c === "'") {
      const start = line
      let j = i + 1
      let s = ''
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\' && j + 1 < text.length) j++
        if (text[j] === '\n') line++
        s += text[j]
        j++
      }
      out.push({ text: s, line: start })
      i = j + 1
    } else {
      let j = i
      while (j < text.length && !/[\s;{}#]/.test(text[j]!)) j++
      out.push({ text: text.slice(i, j), line })
      i = j
    }
  }
  return out
}

interface Directive {
  name: string
  args: string[]
  line: number
  block?: Directive[]
}

function parseBlock(tokens: Token[], pos: { i: number }): Directive[] {
  const out: Directive[] = []
  while (pos.i < tokens.length) {
    const t = tokens[pos.i]!
    if (t.text === '}') {
      pos.i++
      return out
    }
    const words: Token[] = []
    while (pos.i < tokens.length && ![';', '{', '}'].includes(tokens[pos.i]!.text)) {
      words.push(tokens[pos.i]!)
      pos.i++
    }
    const end = tokens[pos.i]
    if (!words.length) {
      pos.i++
      continue
    }
    const d: Directive = { name: words[0]!.text, args: words.slice(1).map((w) => w.text), line: words[0]!.line }
    if (end?.text === '{') {
      pos.i++
      // A Lua block (`content_by_lua_block { … }`) holds Lua, not nginx syntax;
      // skip to its matching brace.
      if (d.name.endsWith('_by_lua_block')) {
        let depth = 1
        while (pos.i < tokens.length && depth > 0) {
          if (tokens[pos.i]!.text === '{') depth++
          else if (tokens[pos.i]!.text === '}') depth--
          pos.i++
        }
      } else {
        d.block = parseBlock(tokens, pos)
      }
    } else if (end?.text === ';') {
      pos.i++
    }
    out.push(d)
  }
  return out
}

export interface NginxProxy {
  // The location's path template, or null for a regex location.
  locationPath: string | null
  // The proxied hosts (an upstream resolves to its servers), or null when the
  // proxy_pass host is a variable.
  hosts: string[] | null
  target: string
  line: number
}

function walkDirectives(ds: Directive[], visit: (d: Directive) => void): void {
  for (const d of ds) {
    visit(d)
    if (d.block) walkDirectives(d.block, visit)
  }
}

/** The proxy_pass locations one nginx config declares. */
export function nginxProxiesFromConfig(text: string): NginxProxy[] {
  const root = parseBlock(tokenize(text), { i: 0 })
  const upstreams = new Map<string, string[]>()
  walkDirectives(root, (d) => {
    if (d.name !== 'upstream' || !d.args[0] || !d.block) return
    const hosts = d.block
      .filter((s) => s.name === 'server' && s.args[0])
      .map((s) => s.args[0]!.replace(/^[a-z]+:\/\//i, '').replace(/:\d+$/, ''))
    upstreams.set(d.args[0], hosts)
  })

  const out: NginxProxy[] = []
  walkDirectives(root, (d) => {
    if (d.name !== 'location' || !d.block) return
    const proxy = d.block.find((s) => s.name === 'proxy_pass' && s.args[0])
    if (!proxy) return
    const [modifier, maybePath] = d.args
    const isRegex = modifier === '~' || modifier === '~*'
    const rawPath = modifier === '=' || modifier === '^~' || isRegex ? maybePath : modifier
    const locationPath = !isRegex && rawPath && rawPath.startsWith('/') ? rawPath : null
    const target = proxy.args[0]!
    const m = /^https?:\/\/([^/:]+)/i.exec(target)
    let hosts: string[] | null = null
    if (m && !m[1]!.includes('$')) {
      const host = m[1]!
      hosts = upstreams.get(host) ?? [host]
    }
    out.push({ locationPath, hosts, target, line: proxy.line })
  })
  return out
}

async function configFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const rel of CONFIG_CANDIDATES) {
    const p = path.join(dir, rel)
    if (await fs.stat(p).then((s) => s.isFile()).catch(() => false)) out.push(p)
  }
  const confd = path.join(dir, 'conf.d')
  for (const name of await fs.readdir(confd).catch(() => [] as string[])) {
    if (name.endsWith('.conf')) out.push(path.join(confd, name))
  }
  return out
}

/** Gateway-style edges from nginx configs in service directories. */
export async function addNginxProxies(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  // Host → service: service names, directory names, and aliases.
  const hostToService = new Map<string, string>()
  for (const s of services) {
    hostToService.set(s.pkg.name, s.node.id)
    hostToService.set(path.basename(s.dir), s.node.id)
    const node = graph.hasNode(s.node.id) ? (graph.getNodeAttributes(s.node.id) as ServiceNode) : s.node
    for (const a of node.aliases ?? []) if (!hostToService.has(a)) hostToService.set(a, s.node.id)
  }

  let nodesAdded = 0
  let edgesAdded = 0
  for (const service of services) {
    for (const abs of await configFiles(service.dir)) {
      const text = await fs.readFile(abs, 'utf8').catch(() => null)
      if (text === null || !text.includes('proxy_pass')) continue
      let proxies: NginxProxy[]
      try {
        proxies = nginxProxiesFromConfig(text)
      } catch (err) {
        recordExtractionError('nginx config extraction', abs, err)
        continue
      }
      if (proxies.length === 0) continue
      const relFile = toPosix(path.relative(service.dir, abs))
      const { fileNodeId, nodesAdded: n, edgesAdded: e } = ensureFileNode(
        graph,
        service.pkg.name,
        service.node.id,
        relFile,
      )
      nodesAdded += n
      edgesAdded += e

      for (const p of proxies) {
        const ev = { file: relFile, line: p.line, snippet: snippet(text, p.line) }
        if (p.locationPath) {
          const rid = routeId(service.pkg.name, 'ALL', p.locationPath)
          if (!graph.hasNode(rid)) {
            const node: RouteNode = {
              id: rid,
              type: NodeType.RouteNode,
              name: `ALL ${p.locationPath}`,
              service: service.pkg.name,
              method: 'ALL',
              pathTemplate: p.locationPath,
              path: relFile,
              line: p.line,
              framework: 'nginx',
              discoveredVia: 'static',
            }
            graph.addNode(rid, node)
            nodesAdded++
          }
          const containsId = extractedEdgeId(service.node.id, rid, EdgeType.CONTAINS)
          if (!graph.hasEdge(containsId)) {
            const edge: GraphEdge = {
              id: containsId,
              source: service.node.id,
              target: rid,
              type: EdgeType.CONTAINS,
              provenance: Provenance.EXTRACTED,
              confidence: confidenceForExtracted('structural'),
              evidence: ev,
            }
            graph.addEdgeWithKey(containsId, service.node.id, rid, edge)
            edgesAdded++
          }
        }

        if (p.hosts === null) {
          noteExtractedDropped({
            source: fileNodeId,
            target: 'service:unresolved',
            type: EdgeType.CALLS,
            confidence: confidenceForExtracted('reconstructed-approximate'),
            confidenceKind: 'reconstructed-approximate',
            evidence: { ...ev, approximate: true, reason: `proxy_pass host isn't literal: ${p.target}` },
          })
          continue
        }
        for (const host of p.hosts) {
          const target = hostToService.get(host)
          if (!target || target === service.node.id) continue
          const edgeId = makeEdgeId(fileNodeId, target, EdgeType.CALLS)
          if (graph.hasEdge(edgeId)) continue
          const edge: GraphEdge = {
            id: edgeId,
            source: fileNodeId,
            target,
            type: EdgeType.CALLS,
            provenance: Provenance.EXTRACTED,
            confidence: confidenceForExtracted('structural'),
            evidence: { ...ev, ...(p.locationPath ? { pathTemplate: p.locationPath } : {}) },
          }
          graph.addEdgeWithKey(edgeId, fileNodeId, target, edge)
          edgesAdded++
        }
      }
    }
  }
  return { nodesAdded, edgesAdded }
}
