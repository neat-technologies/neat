// Instrumentation family: the six /neat extend tools (ADR-081, ADR-086) for
// filling instrumentation gaps. Three diagnose (read-only), three operate
// (file-scope-restricted, idempotent, reversible). NEAT never calls an LLM and
// never auto-applies; the agent reasons over their output.

import { HttpError, type HttpClient } from '../client.js'
import {
  formatEmptyResponse,
  formatErrorResponse,
  formatToolResponse,
  type ToolResponse,
} from '../format.js'
import { postJson, projectPath } from './shared.js'

export interface ListUninstrumentedInput {
  project?: string
}

interface LibraryCoverageResult {
  library: string
  coverage: string
  installedVersion?: string
  instrumentation_package?: string
  package_version?: string
  registration?: string
  notes?: string
}

export async function neatListUninstrumented(
  client: HttpClient,
  input: ListUninstrumentedInput,
): Promise<ToolResponse> {
  try {
    const result = await client.get<{ libraries: LibraryCoverageResult[] }>(
      projectPath(input.project, '/extend/list-uninstrumented'),
    )
    const libs = result.libraries
    if (libs.length === 0) {
      return formatEmptyResponse(
        'All detected libraries are covered by the auto-instrumentations bundle or the HTTP fallback. No extension needed.',
      )
    }
    const blockLines = libs.map((l) => {
      const pkgBit = l.instrumentation_package
        ? ` → ${l.instrumentation_package}@${l.package_version ?? '*'}`
        : ' → no registry entry'
      return `  • ${l.library} [${l.coverage}]${pkgBit}${l.notes ? ` — ${l.notes}` : ''}`
    })
    return formatToolResponse({
      summary: `${libs.length} librar${libs.length === 1 ? 'y needs' : 'ies need'} instrumentation beyond the auto-instrumentations bundle.`,
      block: blockLines.join('\n'),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface LookupInstrumentationInput {
  library: string
  installedVersion?: string
  project?: string
}

export async function neatLookupInstrumentation(
  client: HttpClient,
  input: LookupInstrumentationInput,
): Promise<ToolResponse> {
  const qs = input.installedVersion
    ? `?library=${encodeURIComponent(input.library)}&version=${encodeURIComponent(input.installedVersion)}`
    : `?library=${encodeURIComponent(input.library)}`
  try {
    const result = await client.get<LibraryCoverageResult>(
      projectPath(input.project, `/extend/lookup${qs}`),
    )
    const lines = [
      `  coverage: ${result.coverage}`,
      ...(result.instrumentation_package
        ? [
            `  instrumentation_package: ${result.instrumentation_package}@${result.package_version ?? '*'}`,
          ]
        : []),
      ...(result.registration ? [`  registration: ${result.registration}`] : []),
      ...(result.notes ? [`  notes: ${result.notes}`] : []),
    ]
    return formatToolResponse({
      summary: `Registry entry for ${input.library}: coverage is ${result.coverage}.`,
      block: lines.join('\n'),
    })
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return formatEmptyResponse(`${input.library} is not in the instrumentation registry.`)
    }
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface DescribeProjectInstrumentationInput {
  project?: string
}

interface ProjectInstrumentationState {
  hookFiles: string[]
  envNeat: boolean
  installedDeps: Record<string, string>
}

export async function neatDescribeProjectInstrumentation(
  client: HttpClient,
  input: DescribeProjectInstrumentationInput,
): Promise<ToolResponse> {
  try {
    const state = await client.get<ProjectInstrumentationState>(
      projectPath(input.project, '/extend/describe'),
    )
    const lines: string[] = [
      `  hook files:     ${state.hookFiles.length > 0 ? state.hookFiles.join(', ') : '(none — run neat init first)'}`,
      `  .env.neat:      ${state.envNeat ? 'present' : 'absent'}`,
    ]
    const depEntries = Object.entries(state.installedDeps)
    if (depEntries.length > 0) {
      lines.push('  installed OTel deps:')
      for (const [pkg, ver] of depEntries) {
        lines.push(`    ${pkg}@${ver}`)
      }
    } else {
      lines.push('  installed OTel deps: (none)')
    }
    const ready = state.hookFiles.length > 0
    return formatToolResponse({
      summary: ready
        ? `Project has ${state.hookFiles.length} instrumentation hook file${state.hookFiles.length === 1 ? '' : 's'} and is ready for neat_apply_extension.`
        : 'Project has no instrumentation hook files. Run neat init before extending.',
      block: lines.join('\n'),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface ApplyExtensionInput {
  library: string
  instrumentation_package: string
  version: string
  registration_snippet: string
  project?: string
}

interface ExtensionApplyResult {
  library: string
  filesTouched: string[]
  depsAdded: string[]
  installOutput: string
  alreadyApplied: boolean
}

export async function neatApplyExtension(
  client: HttpClient,
  input: ApplyExtensionInput,
): Promise<ToolResponse> {
  try {
    const result = await postJson<ExtensionApplyResult>(
      client,
      projectPath(input.project, '/extend/apply'),
      {
        library: input.library,
        instrumentation_package: input.instrumentation_package,
        version: input.version,
        registration_snippet: input.registration_snippet,
      },
    )
    if (result.alreadyApplied) {
      return formatEmptyResponse(
        `${input.library} instrumentation is already applied — no changes made.`,
      )
    }
    const lines = [
      `  files touched: ${result.filesTouched.join(', ') || '(none)'}`,
      `  deps added:    ${result.depsAdded.join(', ') || '(none)'}`,
      `  install:       ${result.installOutput}`,
    ]
    return formatToolResponse({
      summary: `Applied ${input.instrumentation_package} for ${input.library}. ${result.filesTouched.length} file${result.filesTouched.length === 1 ? '' : 's'} touched, logged to ~/.neat/extend-log.ndjson.`,
      block: lines.join('\n'),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface DryRunExtensionInput {
  library: string
  instrumentation_package: string
  version: string
  registration_snippet: string
  project?: string
}

interface ExtensionDiff {
  library: string
  filesTouched: string[]
  depsToAdd: string[]
  packageJsonPatch: object
  templatePatch: string
}

export async function neatDryRunExtension(
  client: HttpClient,
  input: DryRunExtensionInput,
): Promise<ToolResponse> {
  try {
    const result = await postJson<ExtensionDiff>(
      client,
      projectPath(input.project, '/extend/dry-run'),
      {
        library: input.library,
        instrumentation_package: input.instrumentation_package,
        version: input.version,
        registration_snippet: input.registration_snippet,
      },
    )
    const lines = [
      `  files that would be touched: ${result.filesTouched.join(', ') || '(none)'}`,
      `  deps to add:                 ${result.depsToAdd.join(', ') || '(none)'}`,
      `  hook file patch:             ${result.templatePatch}`,
    ]
    return formatToolResponse({
      summary: `Dry run for ${input.library}: ${result.filesTouched.length} file${result.filesTouched.length === 1 ? '' : 's'} would be touched. No changes made.`,
      block: lines.join('\n'),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface RollbackExtensionInput {
  library: string
  project?: string
}

export async function neatRollbackExtension(
  client: HttpClient,
  input: RollbackExtensionInput,
): Promise<ToolResponse> {
  try {
    const result = await postJson<{ undone: boolean; message: string }>(
      client,
      projectPath(input.project, '/extend/rollback'),
      { library: input.library },
    )
    if (!result.undone) {
      return formatEmptyResponse(
        `No prior apply found for ${input.library} — nothing to roll back.`,
      )
    }
    return formatToolResponse({
      summary: `Rolled back instrumentation for ${input.library}. ${result.message}. Run your package manager install to sync the lockfile.`,
      block: `  result: ${result.message}`,
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}
