/**
 * Shared types for SDK installer modules (ADR-047).
 *
 * Each language has its own installer at `installers/<language>.ts` exporting
 * a `detect / plan / apply` triple. Plans are pure data — no fs side effects
 * during planning — so `init --dry-run` can render a patch without ever
 * touching the project. `apply` runs the codemod in place.
 *
 * Step 2 (this PR) ships the interface and an empty registry. Step 3 (Node
 * installer) and step 4 (Python installer) populate it.
 */

// Field names match ADR-047's documented patch shape exactly: `file`, `kind`,
// `name`, `version`. Patches will be reviewed by humans and matched in tests
// by name; renaming for clarity would have cost more than it bought.

export interface DependencyEdit {
  file: string
  kind: 'add' | 'remove'
  name: string
  version: string
}

export interface EntrypointEdit {
  file: string
  before: string
  after: string
}

export interface EnvEdit {
  // `null` denotes a recommendation only — the user will set the env var in
  // their orchestration layer, NEAT does not write a `.env` file.
  file: string | null
  key: string
  value: string
}

// Files the installer generates from scratch (ADR-069 §1). The generated
// `otel-init.{js,ts}` for the Node installer rides here, along with the
// per-package `.env.neat` (ADR-069 §4). Treated as additive writes — the
// apply phase skips any file already present (ADR-069 §6).
export interface GeneratedFile {
  file: string
  contents: string
  // When true, write only if the file does not already exist. The apply
  // phase logs an `already instrumented` / `already present` notice instead
  // of overwriting (ADR-069 §6).
  skipIfExists?: boolean
}

export interface InstallPlan {
  // Free-form language tag matching the service node's language: `'javascript'`,
  // `'python'`, …
  language: string
  // Service directory the plan targets. Absolute path.
  serviceDir: string
  dependencyEdits: DependencyEdit[]
  entrypointEdits: EntrypointEdit[]
  envEdits: EnvEdit[]
  // ADR-069 §1, §4 — generated files (otel-init, .env.neat). Optional so
  // installers that don't generate files (the Python installer at MVP) can
  // omit it.
  generatedFiles?: GeneratedFile[]
  // ADR-069 §2 — flagged when entry-point resolution found nothing.
  // The apply phase records this in the summary and skips all file writes
  // for the package.
  libOnly?: boolean
  // ADR-069 §2 — resolved entry-point path (absolute). Present when the
  // installer is going to inject the require/import. Absent for libOnly
  // packages and for the Python installer.
  entryFile?: string
  // ADR-073 §1 + ADR-074 §3 — when a framework owns its own boot, the
  // installer skips `pkg.main` injection and emits framework-native
  // instrumentation files instead. Five values today: Next.js from v0.3.8,
  // then Remix / SvelteKit / Nuxt / Astro from v0.3.9.
  framework?: 'next' | 'remix' | 'sveltekit' | 'nuxt' | 'astro'
  // ADR-073 §1 — Next.js' `next.config.{js,ts,mjs}` may need the
  // `experimental.instrumentationHook: true` flag set when the major
  // version is < 15. The apply phase mutates the file in place when this
  // field is set. Absent → no config mutation planned.
  nextConfigEdit?: {
    file: string
    // Reason this edit is queued — surfaces in the dry-run patch and the
    // apply summary so the operator knows why their next.config moved.
    reason: string
  }
}

// ADR-069 §9 — apply outcome per service. The CLI surfaces these counts
// at the end of `neat init --apply`.
export type ApplyOutcome = 'instrumented' | 'already-instrumented' | 'lib-only' | 'failed'

export interface ApplyResult {
  serviceDir: string
  outcome: ApplyOutcome
  // Free-form reason string for `lib-only` / `failed` outcomes. Surfaced
  // in the CLI summary so the user knows why a package was skipped.
  reason?: string
  // Absolute paths the apply phase actually wrote to. Used by the contract
  // test that asserts the allowed-path-set restriction (ADR-069 §7).
  writtenFiles: string[]
}

export interface Installer {
  // Free-form module name. Used for the patch header and for diagnostics.
  name: string
  // Returns true if the installer thinks `serviceDir` is shaped like a project
  // it can instrument. Cheap; no fs writes.
  detect(serviceDir: string): boolean | Promise<boolean>
  // Builds an `InstallPlan` describing the edits the installer would make.
  // Pure data; no fs writes. An empty plan (every edits array empty) means
  // the SDK is already installed and there is nothing to do.
  plan(serviceDir: string): InstallPlan | Promise<InstallPlan>
  // Apply a previously-produced plan. Mutates files in place. On failure,
  // produces `<serviceDir>/neat-rollback.patch` per ADR-047 #7. Returns a
  // structured outcome so the CLI can surface coverage (ADR-069 §9).
  apply(plan: InstallPlan): Promise<ApplyResult>
}

export function isEmptyPlan(plan: InstallPlan): boolean {
  return (
    plan.dependencyEdits.length === 0 &&
    plan.entrypointEdits.length === 0 &&
    plan.envEdits.length === 0 &&
    (plan.generatedFiles?.length ?? 0) === 0 &&
    plan.nextConfigEdit === undefined
  )
}
