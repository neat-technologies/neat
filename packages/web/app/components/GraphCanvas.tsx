'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import type { GraphData } from './AppShell'
import { authedFetch, authedEventSourceUrl } from '../../lib/authed-fetch'
import {
  buildModel,
  compoundElements,
  degreeByNode,
  type FileFirstModel,
} from './graph-model'
import { ObservedOverlay, type ObservedMode } from './ObservedOverlay'

// ---------------------------------------------------------------------------
// Canvas overhaul (live-canvas-layout ADR).
//
// Layout: ELK `layered` (cytoscape-elk), deterministic tiered dependency flow,
// NOT COSE. Runs on initial load and on an explicit "re-tidy" only — NEVER on
// every SSE event (that would reflow the whole graph and read as jarring).
//
// Shape vocabulary (cytoscape native shapes):
//   file = ellipse (the only FILLED node) · service = round-rectangle COMPOUND
//   container (collapsed by default via cytoscape-expand-collapse) ·
//   database = barrel · config = tag · infra = hexagon · frontier = diamond
//   (dashed). Stroked outlines on black; file the only fill. Sized by degree.
//
// Edges: curve-style taxi; provenance by STYLE (EXTRACTED white solid ·
//   OBSERVED green dashed · INFERRED grey dotted · STALE faded). No always-on
//   edge-type labels — verb+confidence live on hover / in the inspector.
//
// Focus: hover → label + tooltip; select → neighborhood lit, rest dimmed;
//   labels gated (hubs always, others on hover/zoom).
//
// LIVE MODEL (critical): on SSE node-added / edge-added we PIN every existing
// position, place only the new node near its neighbor, batch/debounce ~750ms,
// and PULSE the new node/edge in WITHOUT relayout. Framed as fusion/completion
// — the observed layer arriving completes the picture.
// ---------------------------------------------------------------------------

const BATCH_MS = 750

interface GraphCanvasProps {
  // null until AppShell's resolution chain lands on a real project (#461).
  project: string | null
  selectedNodeId: string | null
  onNodeSelect: (id: string) => void
  onGraphLoaded: (data: GraphData) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onCyReady?: (cy: any) => void
  onProjectNotFound?: () => void
}

function visualProv(p: string): 'STATIC' | 'OBSERVED' | 'INFERRED' | 'STALE' {
  if (p === 'OBSERVED') return 'OBSERVED'
  if (p === 'INFERRED') return 'INFERRED'
  if (p === 'STALE') return 'STALE'
  return 'STATIC'
}

// Projects whose observed=0 overlay has been dismissed. Lives at module scope so
// the dismissal survives a GraphCanvas re-mount — the per-daemon reachability
// poll re-resolves the active profile and remounts us, which would otherwise
// reset any per-instance ref and let the overlay bounce straight back.
const observedOverlayDismissed = new Set<string>()

export function GraphCanvas({
  project,
  selectedNodeId,
  onNodeSelect,
  onGraphLoaded,
  onCyReady,
  onProjectNotFound,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cyRef = useRef<any>(null)
  const fullRef = useRef<GraphData>({ nodes: [], edges: [] })
  const modelRef = useRef<FileFirstModel | null>(null)
  // batched SSE deltas waiting for the debounce window to close.
  const pendingRef = useRef<{ nodes: GraphNode[]; edges: GraphEdge[] }>({
    nodes: [],
    edges: [],
  })
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sseRef = useRef<EventSource | null>(null)

  const [loading, setLoading] = useState(true)
  const [observedCount, setObservedCount] = useState(0)
  const [overlay, setOverlay] = useState<{ mode: ObservedMode } | null>(null)
  const [hoverTip, setHoverTip] = useState<{ x: number; y: number; text: string } | null>(null)

  // -- cytoscape style ------------------------------------------------------
  // Shapes carry node kind; line treatment carries provenance. Monochrome on
  // black; the glyph shape (not hue) draws kinds apart. File is the only fill.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildStyle = useCallback((): any[] => {
    const cssVar = (n: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim()
    const fg = cssVar('--fg') || '#fff'
    const muted = cssVar('--fg-muted') || '#888'
    const rule = cssVar('--rule') || '#333'
    const observed = cssVar('--prov-observed') || '#5fcf9e'

    return [
      {
        selector: 'node',
        style: {
          'background-color': '#000',
          'background-opacity': 1,
          'border-width': 1.2,
          'border-color': muted,
          width: 'data(_size)',
          height: 'data(_size)',
          shape: 'ellipse',
          label: '',
          'font-family': 'DM Mono, monospace',
          'font-size': 8,
          color: muted,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 5,
          'text-outline-width': 2,
          'text-outline-color': '#000',
          'min-zoomed-font-size': 8,
        },
      },
      // file — the primary node, the ONLY filled shape
      {
        selector: 'node.k-file',
        style: { 'background-color': fg, 'border-color': fg, shape: 'ellipse', color: fg },
      },
      // database — barrel
      { selector: 'node.k-db', style: { shape: 'barrel', 'border-color': muted } },
      // config — tag
      { selector: 'node.k-config', style: { shape: 'tag', 'border-color': muted } },
      // infra — hexagon
      { selector: 'node.k-infra', style: { shape: 'hexagon', 'border-color': muted } },
      // frontier — diamond, dashed (unresolved territory)
      {
        selector: 'node.k-frontier',
        style: { shape: 'diamond', 'border-style': 'dashed', 'border-color': muted },
      },
      // service — compound container (round-rectangle). Files nest inside.
      {
        selector: 'node.k-service',
        style: {
          shape: 'round-rectangle',
          'background-color': '#000',
          'background-opacity': 0.35,
          'border-width': 1,
          'border-color': rule,
          'border-style': 'solid',
          label: 'data(label)',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -4,
          'font-size': 9,
          color: muted,
          'min-zoomed-font-size': 6,
          padding: 14,
        },
      },
      // collapsed compound — still a container the user opens, never a leaf.
      {
        selector: 'node.cy-expand-collapse-collapsed-node',
        style: {
          'background-color': '#0a0a0a',
          'background-opacity': 1,
          'border-color': muted,
          shape: 'round-rectangle',
        },
      },
      // selection + focus treatment
      {
        selector: 'node:selected',
        style: { 'border-color': fg, 'border-width': 2.4, color: fg, 'z-index': 999 },
      },
      { selector: '.dim', style: { opacity: 0.14 } },
      { selector: 'edge.dim', style: { opacity: 0.05 } },
      { selector: 'node.hl, edge.hl', style: { opacity: 1 } },
      { selector: 'edge.hl', style: { width: 2, opacity: 1 } },
      // gated labels: hubs always show; .show-label toggled on hover/zoom.
      { selector: 'node.is-hub, node.show-label', style: { label: 'data(label)' } },

      // -- edges --------------------------------------------------------------
      {
        selector: 'edge',
        style: {
          'curve-style': 'taxi',
          'taxi-direction': 'downward',
          'taxi-turn': '50%',
          'line-color': muted,
          'line-style': 'solid',
          width: 1.1,
          opacity: 0.55,
          'target-arrow-shape': 'triangle',
          'target-arrow-color': muted,
          'arrow-scale': 0.7,
          label: '',
        },
      },
      // provenance by style — EXTRACTED white solid
      {
        selector: 'edge.p-STATIC',
        style: { 'line-color': fg, 'target-arrow-color': fg, 'line-style': 'solid', opacity: 0.6 },
      },
      // OBSERVED green dashed — the live layer, the one accent
      {
        selector: 'edge.p-OBSERVED',
        style: {
          'line-color': observed,
          'target-arrow-color': observed,
          'line-style': 'dashed',
          width: 1.5,
          opacity: 0.95,
        },
      },
      // INFERRED grey dotted
      {
        selector: 'edge.p-INFERRED',
        style: { 'line-color': muted, 'target-arrow-color': muted, 'line-style': 'dotted', opacity: 0.5 },
      },
      // STALE faded (legend/style only — no decay animation per spec)
      {
        selector: 'edge.p-STALE',
        style: { 'line-color': muted, 'target-arrow-color': muted, 'line-style': 'dashed', opacity: 0.22 },
      },
      // service-coarse fallback (#536) — distinct coarse treatment, never faked.
      {
        selector: 'edge.coarse',
        style: { 'line-style': 'dashed', opacity: 0.4, 'line-dash-pattern': [2, 6] },
      },
      // the live pulse — applied transiently when an edge/node arrives via SSE.
      { selector: '.pulse', style: { 'overlay-color': observed, 'overlay-opacity': 0.35, 'overlay-padding': 8 } },
    ]
  }, [])

  const nodeClasses = (kind: string, isHub: boolean) =>
    `k-${kind}${isHub ? ' is-hub' : ''}`
  const edgeClasses = (prov: string, coarse: boolean) =>
    `p-${visualProv(prov)}${coarse ? ' coarse' : ''}`

  // Sized-by-degree within a clamped band — hubs read larger.
  const sizeFor = (kind: string, degree: number) => {
    if (kind === 'service') return 40
    if (kind === 'file') return Math.max(12, Math.min(34, 12 + degree * 2.4))
    return Math.max(20, Math.min(40, 20 + degree * 2))
  }

  // -- ELK layered layout ---------------------------------------------------
  const runElk = useCallback((animate: boolean) => {
    const cy = cyRef.current
    if (!cy) return
    cy.layout({
      name: 'elk',
      animate,
      animationDuration: animate ? 350 : 0,
      fit: true,
      padding: 48,
      nodeDimensionsIncludeLabels: true,
      elk: {
        algorithm: 'layered',
        'elk.direction': 'DOWN',
        'elk.layered.spacing.nodeNodeBetweenLayers': 64,
        'elk.spacing.nodeNode': 38,
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.edgeRouting': 'ORTHOGONAL',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).run()
  }, [])

  // collapse every service container by default (the hairball stays dead).
  const collapseAllServices = useCallback(() => {
    const cy = cyRef.current
    if (!cy || !cy.expandCollapse) return
    try {
      const api = cy.expandCollapse('get')
      const parents = cy.nodes('.k-service')
      if (parents.length) api.collapse(parents)
    } catch {
      /* extension not ready — non-fatal */
    }
  }, [])

  // -- full render (load + re-tidy) -----------------------------------------
  const renderAll = useCallback(() => {
    const cy = cyRef.current
    const model = modelRef.current
    if (!cy || !model) return
    const full = fullRef.current
    const deg = degreeByNode(full.edges)
    const els = compoundElements(full.nodes, full.edges, model)
    const degVals = [...deg.values()].sort((a, b) => b - a)
    const hubCut = degVals.length
      ? Math.max(4, degVals[Math.floor(degVals.length * 0.15)] ?? 4)
      : 999

    cy.startBatch()
    cy.elements().remove()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const add: any[] = []
    for (const el of els) {
      if (el.group === 'nodes') {
        const kind = String(el.data._kind)
        const d = deg.get(String(el.data.id)) ?? 0
        add.push({
          group: 'nodes',
          data: { ...el.data, _size: sizeFor(kind, d) },
          classes: nodeClasses(kind, d >= hubCut),
        })
      } else {
        add.push({
          group: 'edges',
          data: el.data,
          classes: edgeClasses(String(el.data._provenance), !!el.data._coarse),
        })
      }
    }
    cy.add(add)
    cy.endBatch()

    runElk(false)
    collapseAllServices()
  }, [runElk, collapseAllServices])

  // -- live SSE: pin + place-near-neighbor + pulse, NO relayout -------------
  const flushBatch = useCallback(() => {
    const cy = cyRef.current
    const model = modelRef.current
    if (!cy || !model) return
    const pending = pendingRef.current
    pendingRef.current = { nodes: [], edges: [] }
    if (pending.nodes.length === 0 && pending.edges.length === 0) return

    const full = fullRef.current
    cy.startBatch()
    // Pin everything that already exists so nothing already placed can move.
    cy.nodes().lock()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh: any[] = []
    for (const n of pending.nodes) {
      if (cy.getElementById(n.id).nonempty()) continue
      const kind = visualKindOf(n.type)
      const parent =
        n.type === 'FileNode' ? model.serviceByFile.get(n.id) : undefined
      const near = neighborPosition(cy, full, n.id)
      fresh.push({
        group: 'nodes',
        data: {
          id: n.id,
          label: labelOf(n),
          _nodeType: n.type,
          _kind: kind,
          _size: sizeFor(kind, 1),
          ...(parent && cy.getElementById(parent).nonempty() ? { parent } : {}),
          _raw: n,
        },
        classes: nodeClasses(kind, false) + ' pulse',
        ...(near ? { position: near } : {}),
      })
    }
    for (const e of pending.edges) {
      if (cy.getElementById(e.id).nonempty()) continue
      if (e.type === 'CONTAINS') continue
      if (cy.getElementById(e.source).empty() || cy.getElementById(e.target).empty())
        continue
      const srcSvc = model.byId.get(e.source)?.type === 'ServiceNode'
      const tgtSvc = model.byId.get(e.target)?.type === 'ServiceNode'
      fresh.push({
        group: 'edges',
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          _type: e.type,
          _verb: e.type.toLowerCase().replace(/_/g, ' '),
          _provenance: e.provenance,
          _confidence: e.confidence,
          _coarse: srcSvc || tgtSvc,
          _raw: e,
        },
        classes: edgeClasses(e.provenance, srcSvc || tgtSvc) + ' pulse',
      })
    }
    cy.add(fresh)
    cy.nodes().unlock()
    cy.endBatch()

    // pulse, then settle — fusion/completion: the live layer landing in place.
    const added = cy.elements('.pulse')
    setTimeout(() => added.removeClass('pulse'), 900)
  }, [])

  // -- effect: init cytoscape, fetch graph, wire SSE ------------------------
  useEffect(() => {
    let destroyed = false
    if (!project) return
    const proj = project

    async function init() {
      const cytoscape = (await import('cytoscape')).default
      const elk = (await import('cytoscape-elk')).default
      const expandCollapse = (await import('cytoscape-expand-collapse')).default
      try {
        cytoscape.use(elk)
      } catch {
        /* already registered */
      }
      try {
        cytoscape.use(expandCollapse)
      } catch {
        /* already registered */
      }

      const res = await authedFetch(
        `/api/graph?project=${encodeURIComponent(proj)}`,
      ).catch(() => null)
      if (!res || destroyed) return
      if (res.status === 404) {
        onProjectNotFound?.()
        return
      }
      if (!res.ok) return
      const data: GraphData = await res.json()
      if (destroyed) return

      fullRef.current = data
      modelRef.current = buildModel(data.nodes, data.edges)
      onGraphLoaded(data)

      const obs = data.edges.filter(
        (e) => e.type !== 'CONTAINS' && e.provenance === 'OBSERVED',
      ).length
      setObservedCount(obs)

      // typed `any` because the registered extensions (expandCollapse) add
      // methods cytoscape's Core type doesn't know about.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cy: any = cytoscape({
        container: containerRef.current,
        elements: [],
        minZoom: 0.05,
        maxZoom: 4,
        wheelSensitivity: 0.25,
        boxSelectionEnabled: false,
        style: buildStyle(),
      })
      cyRef.current = cy
      onCyReady?.(cy)

      // collapsed-by-default; never auto-relayout on expand/collapse.
      try {
        cy.expandCollapse({
          layoutBy: null,
          fisheye: false,
          animate: true,
          undoable: false,
          cueEnabled: true,
          expandCollapseCueSize: 9,
        })
      } catch {
        /* non-fatal */
      }

      renderAll()
      setLoading(false)

      if (obs === 0 && !observedOverlayDismissed.has(proj))
        void resolveOverlayMode(proj).then((m) => setOverlay({ mode: m }))

      function focusNode(id: string) {
        cy.elements().removeClass('hl dim')
        const n = cy.getElementById(id)
        if (n.empty()) return
        const neigh = n.closedNeighborhood()
        cy.elements().not(neigh).addClass('dim')
        neigh.addClass('hl')
        // auto-expand the selected service / a file's parent so file-level
        // context is always revealed on selection.
        try {
          const api = cy.expandCollapse('get')
          if (n.hasClass('k-service') && api.isExpandable(n)) api.expand(n)
          const parent = n.parent()
          if (parent.nonempty() && api.isExpandable(parent)) api.expand(parent)
        } catch {
          /* non-fatal */
        }
        onNodeSelect(id)
      }

      cy.on('tap', 'node', (evt: { target: { id: () => string; select: () => void } }) => {
        cy.$(':selected').unselect()
        evt.target.select()
        focusNode(evt.target.id())
      })
      cy.on('tap', (evt: { target: unknown }) => {
        if (evt.target === cy) {
          cy.elements().removeClass('hl dim')
          cy.$(':selected').unselect()
          setHoverTip(null)
        }
      })

      // hover → label + tooltip (verb/confidence for edges).
      cy.on('mouseover', 'node', (evt: { target: { addClass: (c: string) => void; data: (k: string) => unknown; renderedPosition: () => { x: number; y: number } } }) => {
        evt.target.addClass('show-label')
        const t = evt.target
        const p = t.renderedPosition()
        setHoverTip({ x: p.x, y: p.y, text: String(t.data('label') ?? t.data('id')) })
      })
      cy.on('mouseout', 'node', (evt: { target: { removeClass: (c: string) => void } }) => {
        evt.target.removeClass('show-label')
        setHoverTip(null)
      })
      cy.on('mouseover', 'edge', (evt: { target: { data: (k: string) => unknown; renderedMidpoint: () => { x: number; y: number } } }) => {
        const t = evt.target
        const verb = String(t.data('_verb') ?? '')
        const conf = t.data('_confidence')
        const prov = String(t.data('_provenance') ?? '').toLowerCase()
        const txt = `${verb} · ${prov}${typeof conf === 'number' ? ` · ${conf.toFixed(2)}` : ''}${t.data('_coarse') ? ' · service-coarse' : ''}`
        const p = t.renderedMidpoint()
        setHoverTip({ x: p.x, y: p.y, text: txt })
      })
      cy.on('mouseout', 'edge', () => setHoverTip(null))

      // zoom-gated labels: above a threshold, reveal all; below, only hubs.
      cy.on('zoom', () => {
        if (cy.zoom() > 1.3) cy.nodes().addClass('show-label')
        else cy.nodes('.show-label').not('.is-hub').removeClass('show-label')
      })

      // -- SSE: batch + pin + pulse, never relayout --------------------------
      const sse = new EventSource(
        authedEventSourceUrl(`/api/events?project=${encodeURIComponent(proj)}`),
      )
      sseRef.current = sse

      function scheduleFlush() {
        if (batchTimerRef.current) return
        batchTimerRef.current = setTimeout(() => {
          batchTimerRef.current = null
          flushBatch()
          const full = fullRef.current
          modelRef.current = buildModel(full.nodes, full.edges)
          onGraphLoaded({ nodes: [...full.nodes], edges: [...full.edges] })
          const obsNow = full.edges.filter(
            (e) => e.type !== 'CONTAINS' && e.provenance === 'OBSERVED',
          ).length
          setObservedCount(obsNow)
          if (obsNow > 0) setOverlay(null) // the picture is completing.
        }, BATCH_MS)
      }

      sse.addEventListener('node-added', (e) => {
        const { node } = JSON.parse((e as MessageEvent).data) as { node: GraphNode }
        const full = fullRef.current
        if (!full.nodes.some((n) => n.id === node.id)) full.nodes.push(node)
        pendingRef.current.nodes.push(node)
        scheduleFlush()
      })
      sse.addEventListener('edge-added', (e) => {
        const { edge } = JSON.parse((e as MessageEvent).data) as { edge: GraphEdge }
        const full = fullRef.current
        if (!full.edges.some((x) => x.id === edge.id)) full.edges.push(edge)
        pendingRef.current.edges.push(edge)
        scheduleFlush()
      })
      sse.addEventListener('error', () => {
        /* StatusBar owns the SSE-down surface */
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__cy = cy
    }

    init().catch(console.error)

    return () => {
      destroyed = true
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current)
        batchTimerRef.current = null
      }
      if (sseRef.current) {
        sseRef.current.close()
        sseRef.current = null
      }
      if (cyRef.current) {
        cyRef.current.destroy()
        cyRef.current = null
      }
    }
  }, [project])

  // external selection (search / palette / deep-link) — pan + select + focus.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy || !selectedNodeId) return
    const el = cy.getElementById(selectedNodeId)
    if (el && el.nonempty()) {
      cy.animate({ center: { eles: el }, zoom: 1.4 }, { duration: 300 })
      cy.$(':selected').unselect()
      el.select()
      cy.elements().removeClass('hl dim')
      const neigh = el.closedNeighborhood()
      cy.elements().not(neigh).addClass('dim')
      neigh.addClass('hl')
    }
  }, [selectedNodeId])

  return (
    <main className="canvas-wrap">
      <div id="cy" ref={containerRef} aria-label="File-first dependency graph" role="img" />

      {loading && (
        <div className="canvas-skeleton" aria-hidden="true">
          <span className="label">loading graph…</span>
        </div>
      )}

      {hoverTip && (
        <div className="canvas-hovertip" style={{ left: hoverTip.x + 12, top: hoverTip.y + 12 }}>
          {hoverTip.text}
        </div>
      )}

      <div className="canvas-tag">
        <span className="title">graph</span>
        <span className="meta">
          {fullRef.current.nodes.filter((n) => n.type === 'FileNode').length} files
          {observedCount > 0 ? ` · ${observedCount} observed` : ''}
        </span>
      </div>

      <div className="canvas-toolbar">
        <button
          title="Re-run the deterministic ELK layout — the only time the graph reflows"
          onClick={() => runElk(true)}
        >
          re-tidy
        </button>
        <span className="div" />
        <button onClick={() => cyRef.current?.fit(undefined, 48)}>fit</button>
        <button onClick={() => cyRef.current?.center()}>center</button>
        <span className="div" />
        <span className="layout-name">
          layout: <span className="mono">elk · layered</span>
        </span>
      </div>

      <div className="zoomctl">
        <button title="Zoom in" onClick={() => { const cy = cyRef.current; if (cy) cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }) }}>+</button>
        <button title="Zoom out" onClick={() => { const cy = cyRef.current; if (cy) cy.zoom({ level: cy.zoom() / 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }) }}>−</button>
        <button title="Fit" onClick={() => cyRef.current?.fit(undefined, 48)}>⌖</button>
      </div>

      <aside className="legend" id="legend">
        <h4>Edge provenance</h4>
        <div className="legend-row"><span className="swatch" /><span className="name">Extracted</span></div>
        <div className="legend-row"><span className="swatch dashed" /><span className="name">Observed</span></div>
        <div className="legend-row"><span className="swatch dotted" /><span className="name">Inferred</span></div>
        <div className="legend-row"><span className="swatch stale" /><span className="name">Stale</span></div>
        <div className="legend-rule" />
        <h4 style={{ marginTop: 0 }}>Node kind</h4>
        <div className="nodes-grid">
          <div className="nrow"><span className="kdot file" />file</div>
          <div className="nrow"><span className="kdot" />service</div>
          <div className="nrow"><span className="kdot" />database</div>
          <div className="nrow"><span className="kdot" />config</div>
          <div className="nrow"><span className="kdot" />infra</div>
          <div className="nrow"><span className="kdot" />frontier</div>
        </div>
      </aside>

      {overlay && (
        <ObservedOverlay
          mode={overlay.mode}
          project={project}
          onDismiss={() => {
            if (project) observedOverlayDismissed.add(project)
            setOverlay(null)
          }}
        />
      )}
    </main>
  )
}

// ---- helpers ---------------------------------------------------------------

function visualKindOf(type: string): string {
  switch (type) {
    case 'FileNode':
      return 'file'
    case 'ServiceNode':
      return 'service'
    case 'DatabaseNode':
      return 'db'
    case 'ConfigNode':
      return 'config'
    case 'FrontierNode':
      return 'frontier'
    case 'InfraNode':
      return 'infra'
    default:
      return 'service'
  }
}

function labelOf(n: GraphNode): string {
  if (n.type === 'FileNode') {
    const p = (n as { path?: string }).path ?? n.id
    const parts = p.split('/')
    return parts[parts.length - 1] || p
  }
  return (n as { name?: string }).name ?? n.id
}

// find a position near an existing neighbor of `id` so a new node lands beside
// the thing it connects to, not at the origin (fusion-in-place, no reflow).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function neighborPosition(cy: any, full: GraphData, id: string): { x: number; y: number } | null {
  const neighborIds = new Set<string>()
  for (const e of full.edges) {
    if (e.type === 'CONTAINS') continue
    if (e.source === id) neighborIds.add(e.target)
    if (e.target === id) neighborIds.add(e.source)
  }
  for (const nid of neighborIds) {
    const el = cy.getElementById(nid)
    if (el && el.nonempty() && el.isNode()) {
      const p = el.position()
      return { x: p.x + 40, y: p.y + 40 }
    }
  }
  return null
}

// Decide Mode A (instrumentation wired, idle) vs Mode B (didn't engage). The
// real diagnosis lives in the daemon (#547 / errors.ndjson); here we probe the
// instrumentation endpoint where present and default to Mode A (neutral,
// expectant) so we never wrongly accuse a healthy idle setup.
async function resolveOverlayMode(project: string): Promise<ObservedMode> {
  try {
    const r = await authedFetch(
      `/api/instrumentation?project=${encodeURIComponent(project)}`,
    )
    if (r.ok) {
      const d = (await r.json()) as { engaged?: boolean }
      if (d && d.engaged === false) return 'B'
    }
  } catch {
    /* endpoint may not exist yet — fall through to the neutral mode */
  }
  return 'A'
}
