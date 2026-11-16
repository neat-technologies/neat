import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { EdgeType, Provenance, serviceId } from '@neat.is/types'
import type { GraphEdge } from '@neat.is/types'

// C# HttpClient outbound calls (csharp-calls.ts): file → service (host→service) and
// file → route (path→route), the RestTemplate/WebClient analog. A C# caller calls a
// JS callee whose Express route exercises the route-match; precision negatives below.

// CALLS targets of the C# caller file (the http-call producer's file→X edges).
function callerTargets(): string[] {
  const out: string[] = []
  getGraph().forEachEdge((_id, a) => {
    const e = a as GraphEdge
    if (
      e.type === EdgeType.CALLS &&
      e.provenance === Provenance.EXTRACTED &&
      e.source.startsWith('file:') &&
      e.source.includes('Caller.cs')
    ) {
      out.push(e.target)
    }
  })
  return out
}

describe('C# HttpClient outbound calls', () => {
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cscalls-'))
    // C# caller service.
    await fs.mkdir(path.join(dir, 'caller'), { recursive: true })
    await fs.writeFile(path.join(dir, 'caller', 'app.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n')
    await fs.writeFile(
      path.join(dir, 'caller', 'Caller.cs'),
      `using System.Net.Http;
using System.Threading.Tasks;
namespace Caller
{
    public class Client
    {
        private readonly HttpClient _http = new HttpClient();
        public async Task Run()
        {
            await _http.GetAsync("http://callee/api/orders");       // → service + route
            await _http.PostAsync("http://third-party.example.com/pay", null); // third party → skipped
            await _http.GetAsync("/relative/only");                 // relative (BaseAddress) → skipped
            var u = Build();
            await _http.GetAsync(u);                                 // non-literal → skipped
        }
        string Build() { return "http://callee/x"; }
    }
}
`,
    )
    // JS callee service with an Express route for the path to match.
    await fs.mkdir(path.join(dir, 'callee'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'callee', 'package.json'),
      JSON.stringify({ name: 'callee', version: '1.0.0', dependencies: { express: '^4.18.0' } }),
    )
    await fs.writeFile(
      path.join(dir, 'callee', 'index.js'),
      `const express = require('express');\nconst app = express();\napp.get('/api/orders', (req, res) => res.end());\nmodule.exports = app;\n`,
    )
    resetGraph()
    await extractFromDirectory(getGraph(), dir, { announce: false })
  })

  it('mints file → service for a literal absolute URL whose host is a known service', () => {
    expect(callerTargets()).toContain(serviceId('callee'))
  })

  it('mints file → route when the path matches the callee’s route', () => {
    expect(callerTargets().some((t) => t.startsWith('route:') && t.includes('callee'))).toBe(true)
  })

  it('skips a third-party host, a relative URL, and a non-literal URL', () => {
    const t = callerTargets()
    expect(t.some((x) => x.includes('third-party') || x.includes('example.com'))).toBe(false)
    // exactly one service target (callee), never self or third party
    expect(t.filter((x) => x.startsWith('service:'))).toEqual([serviceId('callee')])
  })
})
