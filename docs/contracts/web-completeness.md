---
name: web-completeness
description: No permanent stub UI in packages/web/. Every interactive element either maps to a real action or is explicitly disabled with affordance. No duplicate components. Audit doc tracks the inventory.
governs:
  - "packages/web/app/components/**"
  - "packages/web/app/**/page.tsx"
  - "packages/web/audit/09-gaps-and-stubs.md"
adr: [ADR-056]
enforcement: [lint, review]
---

# Web shell completeness contract

The first of four web-shell contracts (ADRs 056-059). Sibling contracts: [`web-multi-project.md`](./web-multi-project.md), [`web-debugging.md`](./web-debugging.md), [`web-bootstrap.md`](./web-bootstrap.md).

Permanent stub UI is its own credibility leak. The user clicks a button, expecting an action, gets silence, concludes NEAT is half-built. Worse for an MVP that's supposed to be diagnostic itself.

## Binding rules

### 1. No permanent stubs

Every interactive element rendered to the user — button, tab, link, menu item, keyboard shortcut — is one of:

- **Wired:** has an `onClick` / `onKeyDown` / equivalent handler that produces an observable change in UI or backend state.
- **Explicitly disabled:** `disabled` attribute set, lower opacity, tooltip / badge ("Coming soon", "v0.3.x", etc.) so the user perceives the affordance as unavailable, not broken.

Anything else (rendered, looks active, does nothing) is a contract violation.

### 2. No empty handlers

`onClick={() => {}}` or `onClick={undefined}` on a rendered, non-disabled component is the most common stub shape and the most disorienting failure mode for users. Forbidden.

### 3. Component uniqueness

No two files in `packages/web/app/components/` may export a default component with the same name. If extension is needed (filtered view, grouped variant, etc.), extend the existing file — don't fork. Prevents the kind of `GraphView.tsx` / `GraphCanvas.tsx` confusion that already led to a deletion in prior commits.

### 4. Audit doc tracks the inventory

`packages/web/audit/09-gaps-and-stubs.md` is the canonical inventory of known-stub elements. As stubs get wired or explicitly disabled, the audit doc updates. The contract test reads the doc and asserts no stub appears in source code without a matching entry — drift in either direction (audit-says-stub-but-code-is-wired, or code-has-stub-but-audit-doesn't-list-it) is a finding.

## Today's inventory (the work to do)

Per `audit/09-gaps-and-stubs.md` at the time this contract landed:

| Component | Stub elements |
|---|---|
| TopBar | History, Share buttons |
| Rail | Layers, Find, NeatScript, Time travel, Blast radius, Diff, Comments, Agents, Settings buttons |
| GraphCanvas toolbar | Layout: cose, Locked toggles |
| Inspector | Owners tab, History tab |

Thirteen elements total. Each must either be wired (handler implemented, action observable) or explicitly disabled with affordance. Implementation Agent flips the corresponding `it.todo`s as each element ships.

## What's NOT covered

- Visual / interaction design choices — the contract says wire-or-disable, not "what should the History panel look like."
- Component naming conventions — the contract says no duplicates, not "use suffix `Panel` for overlays."
- Accessibility — separate concern, separate contract if/when needed.

## Authority

`packages/web/app/components/` is the primary scope. `packages/web/app/**/page.tsx` covers route-level rendering. `packages/web/audit/09-gaps-and-stubs.md` is the inventory the contract reads.

## Enforcement

`it.todo` block in `contracts.test.ts` for ADR-056. Three regression scans:

1. No empty `onClick={() => {}}` or `onClick={undefined}` in `packages/web/app/components/**`.
2. No two files under `packages/web/app/components/` export default components with the same name.
3. Every entry in `audit/09-gaps-and-stubs.md`'s "Stub buttons" table corresponds to a button in source code, and vice versa (drift in either direction fails the test).

The thirteen-element inventory above is the per-element checklist. Each element's todo flips to live as it's wired or disabled.

Full rationale: [ADR-056](../decisions.md#adr-056--web-shell-completeness).
