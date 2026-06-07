'use client'

import { useEffect, useRef, useCallback } from 'react'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import type { GraphData } from './AppShell'
import { authedFetch, authedEventSourceUrl } from '../../lib/authed-fetch'
import { buildModel, visibleGraph, type FileFirstModel } from './graph-model'
import { GLYPH_LEGEND } from './glyphs'

// Map NEAT node types to design visual types. FileNode is the primary node of
// the file-first graph and gets its own square shape.
function visualType(node: GraphNode): string {
  if (node.type === 'FileNode') return 'file'
  if (node.type === 'ServiceNode') return 'service'
  if (node.type === 'DatabaseNode') return 'db'
  if (node.type === 'ConfigNode') return 'storage'
  if (node.type === 'FrontierNode') return 'external'
  if (node.type === 'InfraNode') {
    const kind = (node as { kind?: string }).kind?.toLowerCase() ?? ''
    if (kind === 'cluster') return 'cluster'
    if (kind === 'namespace') return 'namespace'
    if (kind === 'vpc' || kind === 'network') return 'vpc'
    if (kind === 'storage' || kind === 's3' || kind === 'blob') return 'storage'
    return 'compute'
  }
  return 'service'
}

// Map NEAT provenance to design display values
function visualProv(provenance: string): 'STATIC' | 'OBSERVED' | 'INFERRED' | 'STALE' {
  if (provenance === 'OBSERVED') return 'OBSERVED'
  if (provenance === 'INFERRED') return 'INFERRED'
  if (provenance === 'STALE') return 'STALE'
  return 'STATIC' // EXTRACTED, FRONTIER
}

// Map NEAT edge type enum to lowercase display verb
function edgeVerb(type: string): string {
  return type.toLowerCase().replace(/_/g, ' ')
}

// A FileNode's display label is its basename — the full service-relative path
// lives in the Inspector. Keeps the canvas legible when a service expands.
function nodeLabel(node: GraphNode): string {
  if (node.type === 'FileNode') {
    const p = (node as { path?: string }).path ?? node.id
    const parts = p.split('/')
    return parts[parts.length - 1] || p
  }
  return (node as { name?: string }).name ?? node.id
}

interface GraphCanvasProps {
  // null until AppShell's resolution chain lands on a real project (#461).
  project: string | null
  selectedNodeId: string | null
  onNodeSelect: (id: string) => void
  onGraphLoaded: (data: GraphData) => void
  onCyReady?: (cy: unknown) => void
  // Called when the graph fetch returns 404 so AppShell can recover to a
  // valid project (clears localStorage and re-resolves from /projects).
  onProjectNotFound?: () => void
}

export function GraphCanvas({
  project,
  selectedNodeId,
  onNodeSelect,
  onGraphLoaded,
  onCyReady,
  onProjectNotFound,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null)
  const minimapFrameRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cyRef = useRef<any>(null)
  const provFilterRef = useRef<Set<string>>(new Set())
  const sseRef = useRef<EventSource | null>(null)
  // the full file-first graph as last loaded — drill state recomputes the
  // visible subset off this without re-fetching.
  const fullRef = useRef<GraphData>({ nodes: [], edges: [] })
  const modelRef = useRef<FileFirstModel | null>(null)

  const drawMinimap = useCallback(() => {
    const cy = cyRef.current
    const mmCanvas = minimapCanvasRef.current
    const mmFrame = minimapFrameRef.current
    if (!cy || !mmCanvas || !mmFrame) return

    const dpr = window.devicePixelRatio || 1
    const rect = mmCanvas.getBoundingClientRect()
    if (rect.width === 0) return
    mmCanvas.width = rect.width * dpr
    mmCanvas.height = rect.height * dpr
    const ctx = mmCanvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)

    const bb = cy.elements().boundingBox()
    if (!isFinite(bb.x1)) return
    const pad = 8
    const sx = (rect.width - pad * 2) / (bb.w || 1)
    const sy = (rect.height - pad * 2) / (bb.h || 1)
    const s = Math.min(sx, sy)
    const ox = pad - bb.x1 * s + (rect.width - pad * 2 - bb.w * s) / 2
    const oy = pad - bb.y1 * s + (rect.height - pad * 2 - bb.h * s) / 2

    ctx.lineWidth = 1
    cy.edges().forEach((e: { source: () => { position: () => { x: number; y: number } }; target: () => { position: () => { x: number; y: number } }; data: (k: string) => string }) => {
      const a = e.source().position()
      const b = e.target().position()
      ctx.strokeStyle = (e.data('_color') || '#888') + '99'
      ctx.beginPath()
      ctx.moveTo(a.x * s + ox, a.y * s + oy)
      ctx.lineTo(b.x * s + ox, b.y * s + oy)
      ctx.stroke()
    })
    cy.nodes().forEach((n: { data: (k: string) => string | boolean; position: () => { x: number; y: number } }) => {
      const p = n.position()
      ctx.fillStyle = (n.data('_color') as string) || '#888'
      ctx.beginPath()
      ctx.arc(p.x * s + ox, p.y * s + oy, 3, 0, Math.PI * 2)
      ctx.fill()
    })

    const ext = cy.extent()
    const fx = ext.x1 * s + ox
    const fy = ext.y1 * s + oy
    const fw = (ext.x2 - ext.x1) * s
    const fh = (ext.y2 - ext.y1) * s
    mmFrame.style.left = Math.max(0, fx) + 'px'
    mmFrame.style.top = Math.max(0, fy) + 'px'
    mmFrame.style.width = Math.min(rect.width - Math.max(0, fx), fw) + 'px'
    mmFrame.style.height = Math.min(rect.height - Math.max(0, fy), fh) + 'px'
  }, [])

  // Cytoscape style — shapes carry node kind, line treatment carries
  // provenance. Monochrome on black; the glyph shape, not hue, draws kinds
  // apart, matching the marketing legend.
  const buildStyle = useCallback(() => {
    const cssVar = (name: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const fg = cssVar('--fg') || '#fff'
    const muted = cssVar('--fg-muted') || '#888'
    const rule = cssVar('--rule') || '#333'
    const observed = cssVar('--prov-observed') || '#5fcf9e'
    return [
      {
        selector: 'node',
        style: {
          'background-color': 'data(_color)',
          'background-opacity': 1,
          shape: 'data(_shape)',
          width: 'data(_size)',
          height: 'data(_size)',
          label: 'data(label)',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 7,
          'font-family': 'DM Mono, monospace',
          'font-size': 9,
          color: muted,
          'text-outline-width': 2,
          'text-outline-color': '#000',
          'border-width': 1,
          'border-color': '#000',
          'min-zoomed-font-size': 7,
        },
      },
      // file — the primary node, filled white square
      {
        selector: 'node.t-file',
        style: { 'background-color': fg, shape: 'rectangle', width: 16, height: 16, color: fg },
      },
      { selector: 'node.t-db',       style: { 'background-color': muted, shape: 'ellipse', width: 26, height: 26 } },
      { selector: 'node.t-storage',  style: { 'background-color': '#000', 'border-color': muted, 'border-width': 1.2, shape: 'rectangle', width: 22, height: 16 } },
      { selector: 'node.t-external', style: { 'background-color': '#000', 'border-color': muted, 'border-width': 1, 'border-style': 'dashed', shape: 'pentagon', width: 26, height: 26 } },
      { selector: 'node.t-compute',  style: { 'background-color': muted, shape: 'diamond', width: 24, height: 24 } },
      { selector: 'node.t-cluster, node.t-namespace, node.t-vpc', style: { 'background-color': '#000', 'border-color': rule, 'border-width': 1, shape: 'triangle', width: 26, height: 26 } },
      {
        selector: 'node:selected',
        style: {
          'border-color': fg,
          'border-width': 2,
          color: fg,
          'z-index': 999,
        },
      },
      { selector: '.dim', style: { opacity: 0.16 } },
      { selector: 'edge.dim', style: { opacity: 0.06 } },
      { selector: 'node.hl, edge.hl', style: { opacity: 1 } },
      { selector: 'edge.hl', style: { width: 1.8, opacity: 1 } },
      {
        selector: 'edge',
        style: {
          'curve-style': 'bezier',
          'control-point-step-size': 32,
          'line-color': 'data(_color)',
          'line-style': 'data(_style)',
          width: 'data(_width)',
          opacity: 'data(_opacity)',
          'target-arrow-shape': 'triangle',
          'target-arrow-color': 'data(_color)',
          'arrow-scale': 0.7,
          'font-family': 'DM Mono, monospace',
          'font-size': 7,
          color: muted,
          'text-rotation': 'autorotate',
          'text-background-color': '#000',
          'text-background-opacity': 1,
          'text-background-padding': 2,
        },
      },
      { selector: 'edge[type]', style: { label: 'data(type)', 'min-zoomed-font-size': 13 } },
      // observed gets the live accent on its arrow
      { selector: 'edge.p-OBSERVED', style: { 'line-color': observed, 'target-arrow-color': observed } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any
  }, [])

  // Translate a node/edge into a cytoscape element. Shapes + colors come from
  // the marketing palette via CSS vars resolved in buildStyle's selectors;
  // here we only need the per-element data the style binds to.
  const nodeElement = useCallback((n: GraphNode) => {
    const vt = visualType(n)
    const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const colorVar = vt === 'file' ? '--n-file' : vt === 'service' ? '--n-service' : `--n-${vt}`
    const color = cssVar(colorVar) || cssVar('--fg-muted') || '#888'
    return {
      data: {
        id: n.id,
        label: nodeLabel(n),
        type: vt,
        _color: color,
        _shape: 'ellipse',
        _size: 24,
        _nodeType: n.type,
        _raw: n,
      },
      classes: `t-${vt}`,
    }
  }, [])

  const edgeElement = useCallback((e: GraphEdge & { _origSource?: string; _origTarget?: string }) => {
    const vp = visualProv(e.provenance)
    const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const color = vp === 'OBSERVED' ? (cssVar('--prov-observed') || '#5fcf9e') : (cssVar('--fg-muted') || '#888')
    return {
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        type: edgeVerb(e.type),
        provenance: vp,
        confidence: e.confidence,
        _color: color,
        _width: vp === 'OBSERVED' ? 1.4 : vp === 'INFERRED' ? 1 : 1.2,
        _style: vp === 'INFERRED' ? 'dotted' : vp === 'OBSERVED' ? 'dashed' : 'solid',
        _opacity: vp === 'INFERRED' ? 0.5 : vp === 'OBSERVED' ? 0.9 : 0.7,
      },
      classes: `p-${vp}`,
    }
  }, [])

  // Recompute the visible cytoscape elements from the full graph + drill
  // state. Called on load, on drill in/out, and on SSE updates. Never rolls
  // file edges into service edges (file-awareness §3) — visibleGraph keeps
  // every rendered edge file-grained, re-anchoring a hidden file's endpoint
  // onto its collapsed-service container without summarizing.
  const rerender = useCallback((animate: boolean) => {
    const cy = cyRef.current
    const model = modelRef.current
    if (!cy || !model) return
    const full = fullRef.current
    const vis = visibleGraph(full.nodes, full.edges, model, new Set())

    cy.elements().remove()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const els: any[] = []
    for (const n of vis.nodes) els.push(nodeElement(n))
    for (const e of vis.edges) els.push(edgeElement(e))
    cy.add(els)

    cy.layout({
      name: 'cose',
      animate,
      randomize: !animate,
      idealEdgeLength: 90,
      nodeRepulsion: 9000,
      edgeElasticity: 80,
      gravity: 0.4,
      numIter: animate ? 1000 : 2000,
      componentSpacing: 110,
      padding: 40,
      fit: true,
    }).run()

    // refresh canvas meta tag
    const metaEl = document.querySelector('.canvas-tag .meta')
    if (metaEl) {
      const fileCount = full.nodes.filter((n) => n.type === 'FileNode').length
      metaEl.textContent = `${fileCount} files · ${vis.edges.length} edges`
    }
    // refresh provenance counts (off the full graph so they don't jump while drilling)
    const counts: Record<string, number> = { STATIC: 0, OBSERVED: 0, INFERRED: 0, STALE: 0 }
    full.edges.forEach((e) => {
      if (e.type === 'CONTAINS') return
      counts[visualProv(e.provenance)] += 1
    })
    const set = (id: string, v: number) => { const el = document.getElementById(id); if (el) el.textContent = String(v) }
    set('ct-static', counts.STATIC)
    set('ct-observed', counts.OBSERVED)
    set('ct-inferred', counts.INFERRED)
    set('ct-stale', counts.STALE)
  }, [nodeElement, edgeElement])

  // Pan + select node when selectedNodeId is set from outside (search, URL, incidents link)
  useEffect(() => {
    const cy = cyRef.current
    if (!cy || !selectedNodeId) return
    const el = cy.getElementById(selectedNodeId)
    if (el && el.length) {
      cy.animate({ center: { eles: el }, zoom: 1.4 }, { duration: 300 })
      cy.$(':selected').unselect()
      el.select()
    }
  }, [selectedNodeId])


  useEffect(() => {
    let destroyed = false

    // #461 — project not resolved yet (or registry is empty). Don't fetch a
    // graph that can only 404; the effect re-runs once AppShell resolves.
    if (!project) return
    const proj = project // narrowed copy for the closures below

    async function init() {
      const cytoscape = (await import('cytoscape')).default

      // ADR-057 #5 — every API call carries the active project.
      const res = await authedFetch(`/api/graph?project=${encodeURIComponent(proj)}`).catch(() => null)
      if (!res || destroyed) return
      if (res.status === 404) { onProjectNotFound?.(); return }
      if (!res.ok) return
      const data: GraphData = await res.json()
      if (destroyed) return

      fullRef.current = data
      modelRef.current = buildModel(data.nodes, data.edges)
      // Inspector consumes the full file-first graph so file→target detail and
      // service→files are both available regardless of what the canvas shows.
      onGraphLoaded(data)

      const cy = cytoscape({
        container: containerRef.current,
        elements: [],
        minZoom: 0.001,
        maxZoom: 50,
        wheelSensitivity: 0.25,
        autoungrabify: true,
        autounselectify: false,
        boxSelectionEnabled: false,
        style: buildStyle(),
      })

      cyRef.current = cy
      onCyReady?.(cy)

      rerender(false)

      function focusNode(id: string) {
        cy.elements().removeClass('hl dim')
        const n = cy.getElementById(id)
        if (!n || n.length === 0) return
        const neigh = n.neighborhood().add(n)
        cy.elements().not(neigh).addClass('dim')
        neigh.addClass('hl')
        onNodeSelect(id)
      }

      // Single tap selects + inspects.
      cy.on('tap', 'node', (evt: { target: { id: () => string; select: () => void } }) => {
        cy.$(':selected').unselect()
        evt.target.select()
        focusNode(evt.target.id())
      })
      cy.on('tap', (evt: { target: unknown }) => {
        if (evt.target === cy) {
          cy.elements().removeClass('hl dim')
          cy.$(':selected').unselect()
        }
      })

      cy.ready(() => {
        setTimeout(() => {
          cy.fit(undefined, 50)
          if (cy.zoom() < 0.25) {
            cy.zoom({ level: 0.45, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
          }
          drawMinimap()
        }, 80)
      })

      // Trackpad pan + pinch-zoom
      const cyEl = containerRef.current
      if (cyEl) {
        const wheelHandler = (e: WheelEvent) => {
          if (e.ctrlKey) {
            e.preventDefault()
            e.stopPropagation()
            const factor = Math.exp(-e.deltaY * 0.015)
            const newZoom = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), cy.zoom() * factor))
            const rect = cyEl.getBoundingClientRect()
            cy.zoom({ level: newZoom, renderedPosition: { x: e.clientX - rect.left, y: e.clientY - rect.top } })
          } else {
            e.preventDefault()
            e.stopPropagation()
            cy.panBy({ x: -e.deltaX, y: -e.deltaY })
          }
        }
        cyEl.addEventListener('wheel', wheelHandler, { passive: false, capture: true })
      }

      cy.on('viewport zoom pan render', () => requestAnimationFrame(drawMinimap))
      window.addEventListener('resize', () => requestAnimationFrame(drawMinimap))

      // Legend provenance filter
      document.querySelectorAll<HTMLElement>('.legend-row[data-prov]').forEach((row) => {
        row.addEventListener('click', () => {
          const p = row.dataset.prov!
          if (provFilterRef.current.has(p)) {
            provFilterRef.current.delete(p)
            row.style.opacity = '1'
          } else {
            provFilterRef.current.add(p)
            row.style.opacity = '0.4'
          }
          cy.edges().forEach((e: { data: (k: string) => string; style: (k: string, v: string) => void }) => {
            e.style('display', provFilterRef.current.has(e.data('provenance')) ? 'none' : 'element')
          })
        })
      })

      const zIn = document.getElementById('z-in')
      const zOut = document.getElementById('z-out')
      const zFit = document.getElementById('z-fit')
      if (zIn) zIn.onclick = () => cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
      if (zOut) zOut.onclick = () => cy.zoom({ level: cy.zoom() / 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
      if (zFit) zFit.onclick = () => cy.fit(undefined, 60)

      // SSE live updates, scoped to the active project (ADR-051 dual-mount).
      const sse = new EventSource(
        authedEventSourceUrl(`/api/events?project=${encodeURIComponent(proj)}`),
      )
      sseRef.current = sse

      function applyDelta(mutate: (full: GraphData) => void) {
        const full = fullRef.current
        mutate(full)
        modelRef.current = buildModel(full.nodes, full.edges)
        onGraphLoaded({ nodes: [...full.nodes], edges: [...full.edges] })
        rerender(false)
      }

      sse.addEventListener('node-added', (e) => {
        const { node } = JSON.parse(e.data) as { node: GraphNode }
        applyDelta((full) => {
          if (!full.nodes.some((n) => n.id === node.id)) full.nodes.push(node)
        })
      })
      sse.addEventListener('edge-added', (e) => {
        const { edge } = JSON.parse(e.data) as { edge: GraphEdge }
        applyDelta((full) => {
          if (!full.edges.some((x) => x.id === edge.id)) full.edges.push(edge)
        })
      })
      sse.addEventListener('node-removed', (e) => {
        const { id } = JSON.parse(e.data) as { id: string }
        applyDelta((full) => { full.nodes = full.nodes.filter((n) => n.id !== id) })
      })
      sse.addEventListener('edge-removed', (e) => {
        const { id } = JSON.parse(e.data) as { id: string }
        applyDelta((full) => { full.edges = full.edges.filter((x) => x.id !== id) })
      })
      sse.addEventListener('error', () => {
        // pre-v0.2.8 or connection drop — handled by StatusBar's SSE state.
      })

      window.__cy = cy
    }

    init().catch(console.error)

    return () => {
      destroyed = true
      if (sseRef.current) {
        sseRef.current.close()
        sseRef.current = null
      }
      if (cyRef.current) {
        cyRef.current.destroy()
        cyRef.current = null
      }
    }
    // Re-init only when the project changes; drill state is handled by the
    // separate [expanded] effect above so we don't tear down cytoscape on
    // every open/close.
  }, [project])

  return (
    <main className="canvas-wrap">
      <div id="cy" ref={containerRef} aria-label="File-first dependency graph" role="img" />

      <div className="canvas-tag">
        <span className="title">NEAT</span>
        <span className="meta">loading…</span>
      </div>

      <div className="canvas-toolbar">
        <button
          className="on"
          title="Toggle node dragging"
          onClick={() => {
            const cy = cyRef.current
            if (cy) cy.autoungrabify(!cy.autoungrabify())
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          Locked
        </button>
        <span className="div" />
        <button onClick={() => cyRef.current?.fit(undefined, 50)}>Fit</button>
        <button onClick={() => cyRef.current?.center()}>Center</button>
        <span className="div" />
        <button onClick={() => cyRef.current?.layout({ name: 'cose', animate: true, randomize: false, idealEdgeLength: 90, nodeRepulsion: 9000, edgeElasticity: 80, gravity: 0.4, numIter: 1200 }).run()}>
          Layout: <span className="mono">cose</span>
        </button>
      </div>

      <div className="zoomctl">
        <button id="z-in" title="Zoom in">+</button>
        <button id="z-out" title="Zoom out">−</button>
        <button id="z-fit" title="Fit">⌖</button>
      </div>

      <aside className="legend" id="legend">
        <h4>Edge provenance</h4>
        <div className="legend-row" data-prov="STATIC">
          <span className="swatch" />
          <span className="name">Extracted</span>
          <span className="ct mono" id="ct-static">—</span>
        </div>
        <div className="legend-row" data-prov="OBSERVED">
          <span className="swatch dashed" />
          <span className="name">Observed</span>
          <span className="ct mono" id="ct-observed">—</span>
        </div>
        <div className="legend-row" data-prov="INFERRED">
          <span className="swatch dotted" />
          <span className="name">Inferred</span>
          <span className="ct mono" id="ct-inferred">—</span>
        </div>
        <div className="legend-row" data-prov="STALE">
          <span className="swatch stale" />
          <span className="name">Stale</span>
          <span className="ct mono" id="ct-stale">—</span>
        </div>

        <div className="legend-rule" />

        <h4 style={{ marginTop: 0 }}>Node kind</h4>
        <div className="nodes-grid">
          {GLYPH_LEGEND.map(({ kind, label }) => (
            <div key={kind} className="nrow">
              <KindGlyph kind={kind} />
              {label}
            </div>
          ))}
        </div>
      </aside>

      <div className="minimap" id="minimap">
        <span className="minimap-label">overview</span>
        <canvas id="minimap-canvas" ref={minimapCanvasRef} />
        <div className="frame" id="minimap-frame" ref={minimapFrameRef} />
      </div>
    </main>
  )
}

// Inline glyph for the legend — kept local so the legend's shape vocabulary
// matches the canvas exactly. Filled square = file (primary node).
function KindGlyph({ kind }: { kind: string }) {
  const filled = kind === 'file'
  let inner: React.ReactNode
  switch (kind) {
    case 'file': inner = <rect x="1.5" y="1.5" width="9" height="9" />; break
    case 'service': inner = <polygon points="6,0.5 11,3.25 11,8.75 6,11.5 1,8.75 1,3.25" strokeLinejoin="round" />; break
    case 'db': inner = <circle cx="6" cy="6" r="5" />; break
    case 'storage': inner = <rect x="1" y="2.5" width="10" height="7" />; break
    case 'external': inner = <polygon points="6,0.5 11.5,4.3 9.4,11 2.6,11 0.5,4.3" strokeLinejoin="round" />; break
    case 'compute': inner = <polygon points="6,0.5 11.5,6 6,11.5 0.5,6" strokeLinejoin="round" />; break
    default: inner = <circle cx="6" cy="6" r="5" />
  }
  return (
    <svg className={`glyph${filled ? ' filled' : ''}`} viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {inner}
    </svg>
  )
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __cy: any
  }
}
