'use client'

import { useEffect, useRef, useCallback } from 'react'
import type { GraphNode, GraphEdge } from '@neat.is/types'
import type { GraphData } from './AppShell'
import { authedFetch } from '../../lib/authed-fetch'

// Map NEAT node types to design visual types
function visualType(node: GraphNode): string {
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
function visualProv(provenance: string): 'STATIC' | 'OBSERVED' | 'INFERRED' {
  if (provenance === 'OBSERVED') return 'OBSERVED'
  if (provenance === 'INFERRED') return 'INFERRED'
  return 'STATIC' // EXTRACTED, STALE, FRONTIER
}

// Map NEAT edge type enum to lowercase display verb
function edgeVerb(type: string): string {
  return type.toLowerCase().replace(/_/g, ' ')
}

const COMPOUND_TYPES = new Set(['cloud', 'env', 'vpc', 'cluster', 'namespace'])

interface GraphCanvasProps {
  project: string
  selectedNodeId: string | null
  onNodeSelect: (id: string) => void
  onGraphLoaded: (data: GraphData) => void
  onCyReady?: (cy: unknown) => void
}

export function GraphCanvas({ project, selectedNodeId, onNodeSelect, onGraphLoaded, onCyReady }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null)
  const minimapFrameRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cyRef = useRef<any>(null)
  const provFilterRef = useRef<Set<string>>(new Set())
  const metaRef = useRef({ nodeCount: 0, edgeCount: 0 })
  const sseRef = useRef<EventSource | null>(null)

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

    ctx.lineWidth = 0.5
    cy.edges().forEach((e: { source: () => { position: () => { x: number; y: number } }; target: () => { position: () => { x: number; y: number } }; data: (k: string) => string }) => {
      const a = e.source().position()
      const b = e.target().position()
      ctx.strokeStyle = e.data('_color') + '55'
      ctx.beginPath()
      ctx.moveTo(a.x * s + ox, a.y * s + oy)
      ctx.lineTo(b.x * s + ox, b.y * s + oy)
      ctx.stroke()
    })
    cy.nodes().forEach((n: { data: (k: string) => string | boolean; position: () => { x: number; y: number } }) => {
      if (n.data('_isCompound')) return
      const p = n.position()
      ctx.fillStyle = (n.data('_color') as string) || '#888'
      ctx.beginPath()
      ctx.arc(p.x * s + ox, p.y * s + oy, 1.4, 0, Math.PI * 2)
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

    async function init() {
      // Dynamic import avoids SSR issues
      const cytoscape = (await import('cytoscape')).default

      // ADR-057 #5 — every API call carries the active project.
      const res = await authedFetch(`/api/graph?project=${encodeURIComponent(project)}`).catch(() => null)
      if (!res || !res.ok || destroyed) return
      const data: GraphData = await res.json()
      if (destroyed) return

      onGraphLoaded(data)
      metaRef.current = { nodeCount: data.nodes.length, edgeCount: data.edges.length }

      const cssVar = (name: string) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim()

      const TYPE_STYLE: Record<string, { color: string; shape: string; size?: number }> = {
        service:   { color: cssVar('--n-service'),   shape: 'round-rectangle', size: 32 },
        db:        { color: cssVar('--n-db'),         shape: 'barrel',          size: 34 },
        cache:     { color: cssVar('--n-cache'),      shape: 'barrel',          size: 28 },
        stream:    { color: cssVar('--n-stream'),     shape: 'cut-rectangle',   size: 32 },
        queue:     { color: cssVar('--n-queue'),      shape: 'cut-rectangle',   size: 28 },
        lambda:    { color: cssVar('--n-lambda'),     shape: 'diamond',         size: 30 },
        cron:      { color: cssVar('--n-cron'),       shape: 'tag',             size: 26 },
        api:       { color: cssVar('--n-api'),        shape: 'round-rectangle', size: 22 },
        apigw:     { color: cssVar('--n-apigw'),      shape: 'round-rectangle', size: 36 },
        compute:   { color: cssVar('--n-compute'),    shape: 'round-rectangle', size: 32 },
        storage:   { color: cssVar('--n-storage'),    shape: 'round-tag',       size: 28 },
        external:  { color: cssVar('--n-external'),   shape: 'round-octagon',   size: 30 },
        search:    { color: cssVar('--n-search'),     shape: 'barrel',          size: 28 },
        cluster:   { color: cssVar('--n-cluster'),    shape: 'round-rectangle' },
        namespace: { color: cssVar('--n-namespace'),  shape: 'round-rectangle' },
        vpc:       { color: cssVar('--n-vpc'),        shape: 'round-rectangle' },
        env:       { color: cssVar('--n-env'),        shape: 'round-rectangle' },
        cloud:     { color: cssVar('--ink-3'),        shape: 'round-rectangle' },
      }

      const provColor: Record<string, string> = {
        STATIC:   cssVar('--prov-static'),
        OBSERVED: cssVar('--prov-observed'),
        INFERRED: cssVar('--prov-inferred'),
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const elements: any[] = []
      data.nodes.forEach((n: GraphNode) => {
        const vt = visualType(n)
        const ts = TYPE_STYLE[vt] ?? { color: '#888', shape: 'ellipse', size: 24 }
        elements.push({
          data: {
            id: n.id,
            label: (n as { name?: string }).name ?? n.id,
            type: vt,
            _color: ts.color,
            _shape: ts.shape,
            _size: ts.size ?? 28,
            _isCompound: COMPOUND_TYPES.has(vt),
            _nodeType: n.type,
            _raw: n,
          },
          classes: `t-${vt} ${COMPOUND_TYPES.has(vt) ? 'compound' : 'leaf'}`,
        })
      })

      data.edges.forEach((e: GraphEdge) => {
        const vp = visualProv(e.provenance)
        const color = provColor[vp] ?? '#888'
        elements.push({
          data: {
            id: e.id,
            source: e.source,
            target: e.target,
            type: edgeVerb(e.type),
            provenance: vp,
            confidence: e.confidence,
            _color: color,
            _width: vp === 'INFERRED' ? 1 : vp === 'OBSERVED' ? 1.4 : 1.2,
            _style: vp === 'INFERRED' ? 'dotted' : vp === 'OBSERVED' ? 'dashed' : 'solid',
            _opacity: vp === 'INFERRED' ? 0.55 : vp === 'OBSERVED' ? 0.85 : 0.75,
          },
        })
      })

      const cy = cytoscape({
        container: containerRef.current,
        elements,
        minZoom: 0.001,
        maxZoom: 50,
        wheelSensitivity: 0.25,
        autoungrabify: true,
        autounselectify: false,
        boxSelectionEnabled: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        style: ([
          {
            selector: 'node.compound',
            style: {
              'background-color': 'data(_color)',
              'background-opacity': 0.35,
              'border-width': 1,
              'border-color': '#2a2a30',
              'border-style': 'solid',
              shape: 'round-rectangle',
              'corner-radius': '4',
              label: 'data(label)',
              'text-valign': 'top',
              'text-halign': 'left',
              'text-margin-x': 8,
              'text-margin-y': 4,
              'font-family': 'JetBrains Mono, monospace',
              'font-size': 10.5,
              color: '#9b968c',
              padding: '24px',
              'text-transform': 'lowercase',
            },
          },
          { selector: 'node.t-cloud',     style: { 'background-opacity': 0.18, padding: '32px', 'font-size': 11.5, color: '#d8d3c9' } },
          { selector: 'node.t-env',       style: { 'background-opacity': 0.3,  padding: '28px', 'font-size': 11,   color: '#d8d3c9' } },
          { selector: 'node.t-vpc',       style: { 'background-opacity': 0.4,  padding: '22px', 'font-size': 10.5 } },
          { selector: 'node.t-cluster',   style: { 'background-opacity': 0.55, padding: '20px' } },
          { selector: 'node.t-namespace', style: { 'background-opacity': 0.65, padding: '16px' } },
          {
            selector: 'node.leaf',
            style: {
              'background-color': 'data(_color)',
              'background-opacity': 0.92,
              shape: 'data(_shape)',
              width: 'data(_size)',
              height: 'data(_size)',
              label: 'data(label)',
              'text-valign': 'bottom',
              'text-halign': 'center',
              'text-margin-y': 5,
              'font-family': 'JetBrains Mono, monospace',
              'font-size': 9.5,
              color: '#d8d3c9',
              'text-outline-width': 2,
              'text-outline-color': '#0a0a0b',
              'border-width': 1,
              'border-color': '#0a0a0b',
              'min-zoomed-font-size': 7,
            },
          },
          { selector: 'node.t-api',      style: { width: 8,  height: 8,  'font-size': 8.5, color: '#9b968c' } },
          { selector: 'node.t-cron',     style: { width: 18, height: 14 } },
          { selector: 'node.t-external', style: { 'background-opacity': 0.7, 'border-color': '#46443f', 'border-width': 1, 'border-style': 'dashed', color: '#9b968c' } },
          { selector: 'node.t-lambda',   style: { width: 22, height: 22 } },
          { selector: 'node.t-queue',    style: { width: 20, height: 20 } },
          {
            selector: 'node:selected',
            style: {
              'border-color': cssVar('--accent'),
              'border-width': 2,
              'background-opacity': 1,
              color: '#f4efe6',
              'font-weight': 600,
              'z-index': 999,
            },
          },
          { selector: '.dim',      style: { opacity: 0.18 } },
          { selector: 'edge.dim', style: { opacity: 0.08 } },
          { selector: 'node.hl, edge.hl', style: { opacity: 1 } },
          { selector: 'edge.hl',  style: { width: 'mapData(_width, 0, 2, 1.6, 2.4)', opacity: 1 } },
          {
            selector: 'edge',
            style: {
              'curve-style': 'bezier',
              'control-point-step-size': 30,
              'line-color': 'data(_color)',
              'line-style': 'data(_style)',
              width: 'data(_width)',
              opacity: 'data(_opacity)',
              'target-arrow-shape': 'triangle-backcurve',
              'target-arrow-color': 'data(_color)',
              'arrow-scale': 0.85,
              'font-family': 'JetBrains Mono, monospace',
              'font-size': 8,
              color: '#6a675f',
              'text-rotation': 'autorotate',
              'text-background-color': '#0a0a0b',
              'text-background-opacity': 1,
              'text-background-padding': 2,
            },
          },
          { selector: 'edge[type]', style: { label: 'data(type)', 'min-zoomed-font-size': 11 } },
          { selector: 'node.t-apigw', style: { shape: 'round-rectangle', width: 36, height: 22, 'font-size': 9 } },
        ] as any),
        layout: {
          name: 'cose',
          animate: false,
          randomize: true,
          idealEdgeLength: 90,
          nodeRepulsion: 9000,
          edgeElasticity: 80,
          gravity: 0.4,
          numIter: 2200,
          nestingFactor: 1.4,
          componentSpacing: 100,
          padding: 30,
          fit: true,
        },
      })

      cyRef.current = cy
      onCyReady?.(cy)

      // Update legend counts
      const counts: Record<string, number> = { STATIC: 0, OBSERVED: 0, INFERRED: 0 }
      data.edges.forEach((e) => {
        const vp = visualProv(e.provenance)
        counts[vp] = (counts[vp] ?? 0) + 1
      })
      const ctStatic = document.getElementById('ct-static')
      const ctObserved = document.getElementById('ct-observed')
      const ctInferred = document.getElementById('ct-inferred')
      if (ctStatic) ctStatic.textContent = String(counts.STATIC)
      if (ctObserved) ctObserved.textContent = String(counts.OBSERVED)
      if (ctInferred) ctInferred.textContent = String(counts.INFERRED)

      // Update canvas tag
      const metaEl = document.querySelector('.canvas-tag .meta')
      if (metaEl) metaEl.textContent = `live · ${data.nodes.length} nodes · ${data.edges.length} edges · cose layout`

      // Selection handler
      function focusNode(id: string) {
        cy.elements().removeClass('hl dim')
        const n = cy.getElementById(id)
        if (!n || n.length === 0) return
        const neigh = n.neighborhood().add(n)
        cy.elements().not(neigh).addClass('dim')
        neigh.addClass('hl')
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
        }
      })

      // Initial layout + selection
      cy.ready(() => {
        setTimeout(() => {
          cy.fit(undefined, 40)
          if (cy.zoom() < 0.25) {
            cy.zoom({ level: 0.45, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
          }
          // Select first service node if available
          const first = cy.nodes('.leaf').first()
          if (first && first.length) {
            first.select()
            focusNode(first.id())
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

      // Minimap updates
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

      // Zoom controls
      const zIn = document.getElementById('z-in')
      const zOut = document.getElementById('z-out')
      const zFit = document.getElementById('z-fit')
      if (zIn) zIn.onclick = () => cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
      if (zOut) zOut.onclick = () => cy.zoom({ level: cy.zoom() / 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
      if (zFit) zFit.onclick = () => cy.fit(undefined, 60)

      // SSE live updates (graceful — pre-v0.2.8 will get unavailable error and stop)
      const sse = new EventSource('/api/events')
      sseRef.current = sse

      function pushGraphUpdate() {
        onGraphLoaded({
          nodes: cy.nodes(':visible').map((n: { data: (k: string) => unknown }) => n.data('_raw') as GraphNode),
          edges: cy.edges(':visible').map((e: { data: (k: string) => unknown }) => ({ id: e.data('id'), source: e.data('source'), target: e.data('target'), type: e.data('type'), provenance: e.data('provenance'), confidence: e.data('confidence') }) as GraphEdge),
        })
      }

      sse.addEventListener('node-added', (e) => {
        const { node } = JSON.parse(e.data) as { node: GraphNode }
        const vt = visualType(node)
        const ts = TYPE_STYLE[vt] ?? { color: '#888', shape: 'ellipse', size: 24 }
        cy.add({
          data: {
            id: node.id,
            label: (node as { name?: string }).name ?? node.id,
            type: vt,
            _color: ts.color,
            _shape: ts.shape,
            _size: ts.size ?? 28,
            _isCompound: COMPOUND_TYPES.has(vt),
            _raw: node,
          },
          classes: `t-${vt} ${COMPOUND_TYPES.has(vt) ? 'compound' : 'leaf'}`,
        })
        pushGraphUpdate()
      })
      sse.addEventListener('edge-added', (e) => {
        const { edge } = JSON.parse(e.data) as { edge: GraphEdge }
        const vp = visualProv(edge.provenance)
        const color = provColor[vp] ?? '#888'
        cy.add({
          data: {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: edgeVerb(edge.type),
            provenance: vp,
            _color: color,
            _width: vp === 'INFERRED' ? 1 : vp === 'OBSERVED' ? 1.4 : 1.2,
            _style: vp === 'INFERRED' ? 'dotted' : vp === 'OBSERVED' ? 'dashed' : 'solid',
            _opacity: vp === 'INFERRED' ? 0.55 : vp === 'OBSERVED' ? 0.85 : 0.75,
          },
        })
        pushGraphUpdate()
      })
      sse.addEventListener('node-removed', (e) => {
        const { id } = JSON.parse(e.data) as { id: string }
        const el = cy.getElementById(id)
        if (el && el.length) el.remove()
        pushGraphUpdate()
      })
      sse.addEventListener('edge-removed', (e) => {
        const { id } = JSON.parse(e.data) as { id: string }
        const el = cy.getElementById(id)
        if (el && el.length) el.remove()
        pushGraphUpdate()
      })
      sse.addEventListener('error', () => {
        // pre-v0.2.8 or connection drop — ignore silently
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
  }, [project])

  return (
    <main className="canvas-wrap">
      <div id="cy" ref={containerRef} aria-label="Service dependency graph" role="img" />

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
        <button onClick={() => cyRef.current?.fit(undefined, 40)}>Fit</button>
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
          <span className="swatch" style={{ background: 'var(--prov-static)' }} />
          <span className="name">Static</span>
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

        <div className="legend-rule" />

        <h4 style={{ marginTop: 0 }}>Node kind</h4>
        <div className="nodes-grid">
          {[
            ['service', '--n-service'], ['db', '--n-db'], ['cache', '--n-cache'],
            ['stream', '--n-stream'], ['lambda', '--n-lambda'], ['cron', '--n-cron'],
            ['api', '--n-api'], ['compute', '--n-compute'], ['storage', '--n-storage'],
            ['external', '--n-external'],
          ].map(([label, v]) => (
            <div key={label} className="nrow">
              <span className="nsq" style={{ background: `var(${v})` }} />
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

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __cy: any
  }
}
