import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { NodeType } from '@neat.is/types'
import type { RouteNode } from '@neat.is/types'

// ASP.NET Core route extraction (csharp-routes.ts): attribute controllers + minimal
// API, the same RouteNode shape every other router mints.

function routes(): string[] {
  const out: string[] = []
  getGraph().forEachNode((_id, a) => {
    const n = a as { type: string } & RouteNode
    if (n.type === NodeType.RouteNode) out.push(`${n.method} ${n.pathTemplate}`)
  })
  return out.sort()
}

describe('ASP.NET Core routes', () => {
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-csroutes-'))
    await fs.writeFile(path.join(dir, 'app.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n')
    await fs.writeFile(
      path.join(dir, 'Orders.cs'),
      `using Microsoft.AspNetCore.Mvc;
namespace Shop
{
    [ApiController]
    [Route("api/[controller]")]
    public class OrdersController : ControllerBase
    {
        [HttpGet] public int List() { return 0; }
        [HttpGet("{id}")] public int Get(int id) { return id; }
        [HttpPost("submit")] public void Submit() {}
        [HttpDelete("/admin/orders/{id}")] public void Remove(int id) {}
        [HttpGet(RoutePaths.Items)] public void ConstRoute() {}   // non-literal template → skipped
    }
}
`,
    )
    await fs.writeFile(
      path.join(dir, 'Program.cs'),
      `using Microsoft.AspNetCore.Builder;
var app = WebApplication.Create();
app.MapGet("/health", () => "ok");
app.MapPost("/orders", (int x) => x);
app.MapGet("nostar", () => "x");          // no leading slash → skipped
var p = GetPath();
app.MapGet(p, () => "y");                  // non-literal path → skipped
app.MapControllers();                       // not a route
app.Run();
`,
    )
    resetGraph()
    await extractFromDirectory(getGraph(), dir, { announce: false })
  })

  it('mints controller routes with [controller] expansion, prefix composition, and absolute override', () => {
    const r = routes()
    expect(r).toContain('GET /api/Orders') // [HttpGet] + class [Route("api/[controller]")]
    expect(r).toContain('GET /api/Orders/{id}') // + method template
    expect(r).toContain('POST /api/Orders/submit')
    expect(r).toContain('DELETE /admin/orders/{id}') // absolute method template overrides the prefix
  })

  it('mints minimal-API routes with a literal path', () => {
    const r = routes()
    expect(r).toContain('GET /health')
    expect(r).toContain('POST /orders')
  })

  it('leaves non-literal and convention-only routes unclaimed', () => {
    const r = routes()
    // Interpolated/const attribute template, a non-literal MapGet arg, a MapGet path
    // without a leading slash, and MapControllers() all mint nothing.
    expect(r).not.toContain('GET /api/Orders/items') // the const-template action
    expect(r.some((x) => x.includes('nostar'))).toBe(false)
    expect(r.some((x) => x.includes('MapControllers'))).toBe(false)
  })

  it('mints exactly the six resolvable routes, no more', () => {
    expect(routes()).toEqual([
      'DELETE /admin/orders/{id}',
      'GET /api/Orders',
      'GET /api/Orders/{id}',
      'GET /health',
      'POST /api/Orders/submit',
      'POST /orders',
    ])
  })
})
