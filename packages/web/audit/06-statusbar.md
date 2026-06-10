# StatusBar Component

**File:** `packages/web/app/components/StatusBar.tsx`  
**CSS:** `.status`, `.st-item`, `.st-spacer`, `.live`, `.live-dead`, `.scrub`

---

## Visual anatomy

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● neat  bloomberg-platform   graph total  247 nodes / 831 edges    t [━━━━━━━━━━━━●] now ⌐ 14:22:31 UTC │
└──────────────────────────────────────────────────────────────────────────────┘
```

Height: 28px. JetBrains Mono 11px. `--paper-2` text on `--ink-1` background.

---

## Items (left to right)

### 1. NEAT indicator (`.st-item`)

Shows connection state.

| State | CSS class on `.st-item` | `::before` dot | Color |
|-------|------------------------|---------------|-------|
| Connected | `.live` | 6px circle, `--prov-observed` (green), pulsing | animated `pulse` keyframe |
| Disconnected | `.live-dead` | 6px circle, `--paper-4` (grey), static | no animation |

Label structure: `<span class="k">neat</span> <span class="v">{project}</span>`

- `project` comes from `GET /api/health` response field `d.project`
- Falls back to `—` until health check responds

### 2. Graph total (`.st-item`)

```
graph total  247 nodes / 831 edges
```

One `.st-item` carrying both whole-graph counts under a shared `graph total`
label, so it reads as the daemon's full-graph totals — every node and edge
type — distinct from the canvas header, which counts only the files and edges
drawn on the canvas (`N files · M drawn`). The label spells out the scope so the
two counters don't read as contradictory totals of the same thing.

- `k`: "graph total" — `--paper-3`
- `v id="st-nodes"`: node count from `graphData.nodes.length` — `--paper-1`
- `k`: "nodes /" — `--paper-3`
- `v id="st-edges"`: edge count from `graphData.edges.length` — `--paper-1`
- `k`: "edges" — `--paper-3`
- Hover title spells out the whole-graph scope
- Shows `—` for each count until graph loads

### 4. "core offline" label (conditional)

Only rendered when `healthy === false` (not `null`).

```
core offline
```

- `.k` with `color: #e87a7a` (red)
- No `.v` — label only

### 5. Spacer (`.st-spacer`)

`flex: 1` — pushes scrubber to right edge.

### 6. Time scrubber (`.scrub`)

Right side. Visual decoration — not interactive.

```
t [━━━━━━━━━━━━━━━━━━━━━━━━━━━━●] now ⌐ 14:22:31 BST
```

| Element | Class | Description |
|---------|-------|-------------|
| Label | `.k` | "t" — `--paper-3` |
| Track | `.bar` | 220px × 4px, background `--ink-3` |
| Fill | `.bar .fill` | 100% width, gradient (blue→green) |
| Playhead | `.bar .head` | 2px × 10px, `--accent` gold, right edge |
| Timestamp | `.now` | Live clock, `--paper-1` |

Clock format: `HH:MM:SS TZ` (e.g. `14:22:31 BST`).  
Updates every 1 second via `setInterval`.

---

## Update intervals

| Data | Interval | Source |
|------|----------|--------|
| Clock | 1 second | `setInterval` |
| Health check | 15 seconds | `GET /api/health` |
| Node/edge count | On prop change | `graphData` prop from `AppShell` |

---

## API dependencies

| Endpoint | When | Data used |
|----------|------|-----------|
| `GET /api/health` | on mount + every 15s | `d.ok` → live/dead; `d.project` → project label |

---

## Pulse animation

```css
@keyframes pulse {
  0%   { box-shadow: 0 0 0 0 rgba(95,207,158,0.45); }
  70%  { box-shadow: 0 0 0 6px rgba(95,207,158,0); }
  100% { box-shadow: 0 0 0 0 rgba(95,207,158,0); }
}
```

Applied to `.status .live::before` — the green dot. 1.8s infinite.
