import type { GraphNode } from '@neat.is/types'
import type { NeatGraph } from './graph.js'

// The shapes of a project's search index, kept in substrate so the project
// registry (projects.ts) can hold an index without importing the search engine
// that builds one (search.ts, a query). See docs/contracts/substrate.md (#1684).

export interface ScoredNode {
  node: GraphNode
  score: number
}

export interface SearchResponse {
  query: string
  provider: 'ollama' | 'transformers' | 'substring'
  matches: ScoredNode[]
}

export interface SearchIndex {
  readonly provider: SearchResponse['provider']
  search(query: string, limit?: number): Promise<SearchResponse>
  refresh(graph: NeatGraph): Promise<void>
}
