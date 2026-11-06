import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance } from '@neat.is/types'

// C# symbol→symbol CALLS (ADR-158 §3, the C# rung): same-file (tier 1), typed
// receiver (tier 2), interface→single-implementor (tier 3); a CALLS edge only where
// the callee resolves to exactly one method, never a guess.

// "caller -> callee" for every C# symbol CALLS in the graph, by method simple name.
function calls(): string[] {
  const out: string[] = []
  getGraph().forEachEdge((_id, a) => {
    const e = a as GraphEdge
    if (e.type !== EdgeType.CALLS || !e.source.startsWith('symbol:') || !e.target.startsWith('symbol:')) {
      return
    }
    expect(e.provenance).toBe(Provenance.EXTRACTED)
    out.push(`${e.source.split('.').pop()} -> ${e.target.split('.').pop()}`)
  })
  return out.sort()
}

describe('C# symbol CALLS (tiers 1-3)', () => {
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cssym-'))
    await fs.writeFile(path.join(dir, 'app.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n')
    await fs.writeFile(
      path.join(dir, 'App.cs'),
      `namespace Shop
{
    public class OrderService
    {
        private readonly IRepo _repo;                           // interface field (tiers 2/3)
        private readonly Mailer _mailer;                        // class field (tier 2)
        private readonly System.Net.Http.HttpClient _http;      // external type

        public OrderService(IRepo repo) { _repo = repo; }

        public int Place(Item item)
        {
            Validate(item);          // tier 1: unqualified -> OrderService.Validate
            this.Log("placing");     // tier 1: this. -> OrderService.Log
            _repo.Save(item);        // tier 3: _repo is IRepo, single impl SqlRepo -> SqlRepo.Save
            _mailer.Send();          // tier 2: _mailer is Mailer (class) -> Mailer.Send
            var r = Make();          // tier 1: Make() -> OrderService.Make
            r.Use();                 // var receiver -> unclaimed
            _http.Dispose();         // external type -> unclaimed
            CallsOverload();         // tier 1 -> OrderService.CallsOverload
            return Rates.Default();  // tier 1: Type. static -> Rates.Default
        }

        private void Validate(Item item) { }
        private void Log(string m) { }
        private Helper Make() { return new Helper(); }
        public int Overloaded(int x) { return x; }
        public int Overloaded(string s) { return 0; }
        public void CallsOverload() { Overloaded(1); }   // overloaded name -> unclaimed
    }

    public interface IRepo { void Save(Item item); }
    public class SqlRepo : IRepo { public void Save(Item item) { } }

    public class Mailer { public void Send() { } }
    public class Helper { public void Use() { } }
    public static class Rates { public static int Default() { return 1; } }
    public record Item(string Id);
}
`,
    )
    resetGraph()
    await extractFromDirectory(getGraph(), dir, { announce: false })
  })

  it('resolves tier 1 (unqualified / this. / Type.), tier 2 (class field), tier 3 (interface→impl)', () => {
    expect(calls()).toEqual([
      'Place -> CallsOverload', // tier 1 unqualified
      'Place -> Default', // tier 1 static Type.M
      'Place -> Log', // tier 1 this.
      'Place -> Make', // tier 1 unqualified
      'Place -> Save', // tier 3 interface → single implementor
      'Place -> Send', // tier 2 class field
      'Place -> Validate', // tier 1 unqualified
    ])
  })

  it('leaves a var receiver, an external type, and an overloaded name unclaimed', () => {
    const set = calls()
    expect(set).not.toContain('Place -> Use') // `var r` — type unknown
    expect(set).not.toContain('Place -> Dispose') // HttpClient — outside the service
    expect(set).not.toContain('CallsOverload -> Overloaded') // two overloads
  })
})
