import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance } from '@neat.is/types'

// Java symbol→symbol CALLS (ADR-158 §3, the Java rung): same-file, and only when
// the callee resolves to exactly one method.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'java-spring-train-ticket')

// "caller -> callee" for every Java symbol CALLS in the graph, by simple name.
function calls(): string[] {
  const out: string[] = []
  getGraph().forEachEdge((_id, a) => {
    const e = a as GraphEdge
    if (e.type !== EdgeType.CALLS || !e.source.startsWith('symbol:') || !e.target.startsWith('symbol:')) return
    out.push(`${e.source.split('.').pop()} -> ${e.target.split('.').pop()}`)
  })
  return out.sort()
}

describe('Java symbol CALLS', () => {
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-javasym-'))
    await fs.writeFile(path.join(dir, 'pom.xml'), '<project><artifactId>svc</artifactId></project>')
    await fs.mkdir(path.join(dir, 'src', 'main', 'java', 'a'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'src', 'main', 'java', 'a', 'Svc.java'),
      `package a;
public class Svc extends Base {
  private Repo repo;
  public void run() {
    helper();
    this.other();
    Util.format("x");
    over(1);
    inherited();
    repo.save();
    new Thread(new Runnable() { public void run() { helper(); } });
  }
  void helper() {}
  void other() {}
  void over(int a) {}
  void over(String a) {}
}
class Util {
  static String format(String s) { return s; }
}
`,
    )
    resetGraph()
    await extractFromDirectory(getGraph(), dir, { announce: false })
  })

  it('resolves unqualified, this. and same-file Type. calls, and nothing else', () => {
    // over(): overloaded. inherited(): not declared here. repo.save(): needs the
    // receiver's type. helper() inside the anonymous Runnable: its own run() shadows.
    expect(calls()).toEqual(['run -> format', 'run -> helper', 'run -> other'])
  })
})

describe('Java symbol CALLS on train-ticket (extractFromDirectory)', () => {
  beforeAll(async () => {
    resetGraph()
    await extractFromDirectory(getGraph(), FIXTURE, { announce: false })
  })

  it("links preserve's createConsign to its getServiceUrl helper", () => {
    const file = 'src/main/java/preserve/service/PreserveServiceImpl.java'
    let edge: GraphEdge | undefined
    getGraph().forEachEdge((_id, a) => {
      const e = a as GraphEdge
      if (e.type === EdgeType.CALLS && e.source.endsWith('.createConsign') && e.target.endsWith('.getServiceUrl')) edge = e
    })
    expect(edge?.provenance).toBe(Provenance.EXTRACTED)
    expect(edge?.evidence).toMatchObject({ file, line: 424 })
  })
})
