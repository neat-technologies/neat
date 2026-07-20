'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  useCommandQuery,
} from '@/components/ui/command'
import { authedFetch } from '../../lib/authed-fetch'
import { ALL_NAV, NAV_ROUTES, type NavId } from '../../lib/nav'

// ⌘K command palette (jedorini command, cmdk-free). Jump to a page or search
// for a node (semantic_search via /api/search). This is the "Find" capability;
// the sidebar's Find item points users here.

interface SearchResult {
  node: { id: string; type: string; name?: string }
  score: number
}

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: string | null
  onNavigate: (id: NavId) => void
  onNodeSelect: (id: string) => void
}

export function CommandPalette({
  open,
  onOpenChange,
  project,
  onNavigate,
  onNodeSelect,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const router = useRouter()

  // node search — project-scoped, idle until a project resolves (#461).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!open || !query.trim() || !project) {
      setResults([])
      return
    }
    debounceRef.current = setTimeout(() => {
      authedFetch(
        `/api/search?q=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}`,
      )
        .then((r) => r.json())
        .then((d: { results: SearchResult[] }) => {
          if (Array.isArray(d.results)) setResults(d.results.slice(0, 8))
        })
        .catch(() => setResults([]))
    }, 220)
  }, [query, project, open])

  // reset when the dialog closes.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
    }
  }, [open])

  const pages = ALL_NAV.filter((n) => n.kind === 'page')

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      {/* a tiny controlled bridge: CommandInput owns its own query inside the
          Command context, but we also need it for the node-search effect, so we
          mirror it via the onValueChange hook below. */}
      <PaletteQueryBridge onQuery={setQuery} />
      <CommandInput placeholder="Find a node, jump to a page…" />
      <CommandList>
        <CommandEmpty>Nothing matches. Try a node name or a page.</CommandEmpty>

        <CommandGroup heading="Pages">
          {pages.map((p) => (
            <CommandItem
              key={p.id}
              value={`${p.label} ${p.hint}`}
              onSelect={() => {
                // Honor the same standalone-route map the sidebar uses. Without
                // this, a shipped page that lives at its own route (Incidents →
                // /incidents) gets sent through onNavigate to a nonexistent
                // AppShell branch and lands on StubPage's "not built yet" copy
                // — a real page looking unbuilt (#804).
                const route = NAV_ROUTES[p.id]
                if (route) router.push(route)
                else onNavigate(p.id)
                onOpenChange(false)
              }}
            >
              <span className="font-medium">{p.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">{p.hint}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {results.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Nodes">
              {results.map((r) => (
                <CommandItem
                  key={r.node.id}
                  value={`${r.node.name ?? r.node.id} ${r.node.type}`}
                  onSelect={() => {
                    onNodeSelect(r.node.id)
                    onNavigate('graph')
                    onOpenChange(false)
                  }}
                >
                  <span>{r.node.name ?? r.node.id}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.node.type.replace('Node', '').toLowerCase()}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}

// CommandInput writes to the Command context; this bridge reads that same
// context value out so the parent can drive the node-search effect. Kept tiny
// and colocated.
function PaletteQueryBridge({ onQuery }: { onQuery: (q: string) => void }) {
  const q = useCommandQuery()
  useEffect(() => {
    onQuery(q)
  }, [q, onQuery])
  return null
}
