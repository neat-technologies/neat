/**
 * Installer registry. v0.2.5 step 2 ships the scaffolding; the JavaScript
 * installer (step 3) and Python installer (step 4) populate `INSTALLERS`.
 */

import type { Installer, InstallPlan } from './shared.js'
import { javascriptInstaller } from './javascript.js'
import { pythonInstaller } from './python.js'
import { goInstaller } from './go.js'
export { isEmptyPlan } from './shared.js'
export { javascriptInstaller } from './javascript.js'
export { pythonInstaller } from './python.js'
export { goInstaller } from './go.js'
export type {
  ApplyOutcome,
  ApplyResult,
  DependencyEdit,
  EntrypointEdit,
  EnvEdit,
  GeneratedFile,
  Installer,
  InstallPlan,
} from './shared.js'

// Lockfile basenames installers must never write to (ADR-047 — "lockfiles
// never touched"). Used by the patch renderer's safety check below.
export const FORBIDDEN_LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'go.sum',
])

// Order is priority — first match wins per service. JavaScript leads because
// it's the most common shape in the projects NEAT targets; Python follows.
export const INSTALLERS: Installer[] = [javascriptInstaller, pythonInstaller, goInstaller]

/**
 * Resolve the first installer that claims a given service directory. Returns
 * `null` if none match.
 *
 * Per language, the first matching installer wins. Order in `INSTALLERS`
 * defines that priority — declarations are explicit, not alphabetical.
 */
export async function pickInstaller(serviceDir: string): Promise<Installer | null> {
  for (const inst of INSTALLERS) {
    if (await inst.detect(serviceDir)) return inst
  }
  return null
}

export interface PatchSection {
  installer: string
  plan: InstallPlan
}

/**
 * Render install plans into a single review-friendly text patch. The format
 * is intentionally human-shaped, not unified-diff: agents and humans both
 * read this. Determinism — same input, byte-identical output — is the
 * load-bearing property (ADR-047 #6).
 */
export function renderPatch(sections: PatchSection[]): string {
  if (sections.length === 0) {
    return [
      '# neat install plan',
      '',
      'No SDK installers matched the discovered services. Two reasons this',
      'normally happens:',
      '  - the project uses a language NEAT does not yet instrument',
      '    (Java / Ruby / .NET / Rust are out of MVP scope per ADR-047);',
      '  - the SDK is already installed, so the installer returned an empty',
      '    plan.',
      '',
      'You can re-run `neat init --apply` later to pick up new services.',
      '',
    ].join('\n')
  }

  const lines: string[] = ['# neat install plan', '']
  for (const section of sections) {
    const { installer, plan } = section
    lines.push(`## ${installer} (${plan.language}) — ${plan.serviceDir}`)
    lines.push('')

    if (plan.libOnly) {
      lines.push('### skipped — no resolvable entry point (lib-only)')
      lines.push('')
      continue
    }

    if (plan.entryFile) {
      lines.push(`entry: ${plan.entryFile}`)
      lines.push('')
    }

    if (plan.dependencyEdits.length > 0) {
      lines.push('### dependencies')
      // Group by manifest file so each section names the path the apply phase
      // will write, satisfying the dry-run/apply path-parity contract
      // (ADR-069 §8).
      const byFile = new Map<string, typeof plan.dependencyEdits>()
      for (const dep of plan.dependencyEdits) {
        // Hard-fail rather than render a patch that could mislead the user
        // into thinking NEAT touches lockfiles.
        const base = dep.file.split(/[\\/]/).pop() ?? dep.file
        if (FORBIDDEN_LOCKFILES.has(base)) {
          throw new Error(
            `installer "${installer}" produced a dependency edit against a lockfile (${dep.file}); ` +
              `lockfiles must never be touched (ADR-047).`,
          )
        }
        const existing = byFile.get(dep.file) ?? []
        existing.push(dep)
        byFile.set(dep.file, existing)
      }
      for (const [file, deps] of byFile) {
        lines.push(`--- ${file}`)
        for (const dep of deps) {
          lines.push(`+ "${dep.name}": "${dep.version}"`)
        }
      }
      lines.push('')
    }

    if (plan.generatedFiles && plan.generatedFiles.length > 0) {
      lines.push('### generated files')
      for (const gen of plan.generatedFiles) {
        lines.push(`--- (new file) ${gen.file}`)
        for (const ln of gen.contents.split(/\r?\n/)) {
          lines.push(`+ ${ln}`)
        }
      }
      lines.push('')
    }

    if (plan.entrypointEdits.length > 0) {
      lines.push('### entry-point injection')
      for (const e of plan.entrypointEdits) {
        lines.push(`--- ${e.file}`)
        lines.push(`+ ${e.after}`)
        lines.push(`  ${e.before}`)
      }
      lines.push('')
    }

    if (plan.envEdits.length > 0) {
      lines.push('### env (written to <package-dir>/.env.neat)')
      for (const env of plan.envEdits) {
        lines.push(`- ${env.key}=${env.value}`)
      }
      lines.push('')
    }

    // ADR-073 §1 — surface the next.config edit in the dry-run patch so the
    // operator can review the framework-flag change before it lands.
    if (plan.nextConfigEdit) {
      lines.push('### next.config (framework flag)')
      lines.push(`--- ${plan.nextConfigEdit.file}`)
      lines.push(`+ experimental: { instrumentationHook: true }, // ${plan.nextConfigEdit.reason}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}
