---
name: design-system
description: "packages/web adopts the vendored jedorini component system — neatified shadcn / Base UI: DM Mono, hard corners (--radius: 0), monochrome black/white plus the one OBSERVED green #5fcf9e reserved for the runtime layer. React 18 / Next 14 stay. The dashboard migrates Tailwind v3 → v4 (a full-dashboard migration with a visual-regression pass) and stays on @base-ui/react (now ^1.6.0), the package the vendored jedorini source also uses — any 1.x API deltas handled in a compat pass (ADR-101)."
governs:
  - "packages/web/package.json"
  - "packages/web/tailwind.config.ts"
  - "packages/web/postcss.config.js"
  - "packages/web/app/globals.css"
  - "packages/web/app/components/ui/**"
adr: [ADR-099, ADR-062, ADR-101]
enforcement: [lint, review]
---

# Design-system contract

The GUI redo adopts a single vendored component system across `packages/web`: **jedorini** — a neatified shadcn / Base UI system. This contract locks the system's identity and the two migrations adopting it requires, and bounds the platform so the redo stays a *design* change rather than a framework jump.

## 1. The jedorini system

`packages/web` adopts jedorini's vendored components. The visual identity:

- **DM Mono** as the typeface.
- **Hard corners** — `--radius: 0`. No rounded corners.
- **Monochrome** — black and white.
- **One accent: the OBSERVED green `#5fcf9e`.** It is the runtime layer's color and is **reserved for it** — the green reads as "this is observed / live" across the canvas and the list pages. It is a system token, not a free-floating accent applied for decoration.

The components are vendored into `packages/web` (shadcn-style, copied into the tree under `app/components/ui/**`), not pulled as an external dependency.

## 2. React 18 / Next 14 stay

This redo does **not** take the React 19 / Next 15 jump. That is risk and churn that does not serve a design redo (React 19 carries real breaking changes), and the dashboard already mounts client-only via `dynamic({ ssr: false })` (ADR-062), so little of Next's SSR surface is in use — most of the reason to chase Next 15 does not apply.

Vendored jedorini components are verified **React-18-safe** as part of the vendor pass: no `use()`, no server actions. A component that depends on a React-19-only API is adapted to React 18 before it lands, or flagged.

## 3. Tailwind v3 → v4 is a full-dashboard migration

jedorini is built on Tailwind v4; `packages/web` is on Tailwind v3. The migration is **not a config swap** — v4's CSS-first config and breaking class / PostCSS changes touch **every existing styled component** in `packages/web`, not only the new jedorini ones. So:

- The migration carries a **visual-regression pass** over the existing dashboard — the same caution the Base UI version alignment gets (§4).
- It is the **heaviest step** of the redo and is **sequenced first**, so the rest of the redo builds on a stable foundation.
- If the cutover gets hairy, a fallback is vendoring jedorini's tokens/components in a way that coexists with v3 first, then doing the v4 cutover as its own step. Plan for it being real work either way.

The OBSERVED green, hard corners (`--radius: 0`), and DM Mono are expressed as Tailwind v4 theme tokens / CSS variables so the system is single-sourced.

## 4. Base UI stays on `@base-ui/react` (`^1.6.0`), shared with jedorini

Both `packages/web` and the vendored jedorini source import the same package, `@base-ui/react`; the dashboard tracks `^1.6.0`, the version jedorini targets. This is a **version alignment, not a package swap** (ADR-101).

Base UI's API moved across its `1.x` line (component names, prop shapes), so holding the dashboard at `^1.6.0` carries a **compat pass**: the version delta is confirmed at build time and any affected Base UI usages are adapted. Budget for it.

## What this contract does not cover

- **Per-component visual spec** — this contract locks the system (typeface, corners, palette, the one green) and the two migrations, not the pixel design of any individual screen.
- **The canvas node/edge vocabulary** — shapes and provenance styles live with the canvas ([`canvas-layout.md`](./canvas-layout.md) and the graph rendering), though they draw from the same palette and reserve the green for OBSERVED.
- **The platform jump** — React 19 / Next 15 are explicitly out of scope (§2); revisiting them is a separate ADR.

## Authority

- **Dependencies + Tailwind/Base UI versions:** `packages/web/package.json`
- **Tailwind v4 config + tokens:** `packages/web/tailwind.config.ts`, `packages/web/app/globals.css`, `packages/web/postcss.config.js`
- **Vendored components:** `packages/web/app/components/ui/**`

## Enforcement

`it.todo` block in `contracts.test.ts` for ADR-099:

- `packages/web` is on Tailwind v4 (assert the v4 dependency + CSS-first config shape).
- React stays 18 and Next stays 14 (assert the pinned majors; no React 19 / Next 15).
- Base UI imports under `packages/web/` resolve to `@base-ui/react` (`^1.6.0`); no `@base-ui-components/react` import is introduced.
- The design tokens — `--radius: 0`, DM Mono, the OBSERVED green `#5fcf9e` — are single-sourced as theme tokens / CSS variables, not scattered literals.
- Vendored `ui/**` components carry no `use()` / server-action usage (React-18-safety regex scan).

Full rationale: [ADR-099](../decisions.md#adr-099--design-system-adoption-the-jedorini-component-system).
