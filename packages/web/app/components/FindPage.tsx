'use client'

import { useEffect, useRef, useState } from 'react'
import { authedFetch } from '../../lib/authed-fetch'

// ---------------------------------------------------------------------------
// Find page — semantic_search over the fused graph as a full-page surface
// (web-shell §4/§5). The ⌘K palette runs the same search inline; this is the
// room-to-breathe version for exploring the result set. Selecting a result
// focuses that node on the graph.
// ---------------------------------------------------------------------------

interface FindPageProps {
  project: string | null
  onNodeSelect: (id: string) => void
  onNavigateGraph: () => void
}

interface SearchResult {
  node: { id: string; type: string; name?: string }
  score: number
}

export function FindPage({ project, onNodeSelect, onNavigateGraph }: FindPageProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced semantic search, idle until a project resolves (#461) and until
  // the user has typed something. Mirrors CommandPalette's debounce shape.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim() || !project) {
      setResults(null)
      setError(null)
      return
    }
    debounceRef.current = setTimeout(() => {
      authedFetch(`/api/search?q=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}`)
        .then((r) => r.json())
        .then((d: { results?: SearchResult[] }) => {
          setResults(Array.isArray(d.results) ? d.results : [])
          setError(null)
        })
        .catch(() => setError('search failed'))
    }, 220)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, project])

  const select = (id: string) => {
    onNodeSelect(id)
    onNavigateGraph()
  }

  return (
    <div className="page-scroll">
      <header className="page-head">
        <h1 className="page-title">Find</h1>
        <p className="page-sub">
          Semantic search over the fused graph. Jump straight to a node, a file, or
          a service — or press ⌘K anywhere for the same search inline.
        </p>
      </header>

      <section className="page-section">
        <input
          type="search"
          className="find-input"
          placeholder="Search the graph — a file, a service, a database…"
          aria-label="Search the graph"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />

        {error && <div className="page-empty">{error}</div>}

        {!error && results === null && (
          <div className="page-empty">
            Type to search. Results are ranked by semantic relevance over the
            node set — names, paths, and node kinds.
          </div>
        )}

        {!error && results !== null && results.length === 0 && (
          <div className="page-empty">Nothing matches “{query}”. Try a node name, a file path, or a service.</div>
        )}

        {!error && results !== null && results.length > 0 && (
          <table className="page-table">
            <thead>
              <tr>
                <th>Node</th>
                <th>Kind</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.node.id}>
                  <td>
                    <button className="td-link" onClick={() => select(r.node.id)} title="Focus this node on the graph">
                      {r.node.name ?? r.node.id}
                    </button>
                  </td>
                  <td className="td-mono">{r.node.type.replace('Node', '').toLowerCase()}</td>
                  <td className="td-mono">{typeof r.score === 'number' ? r.score.toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
