// §6 of the project-identity contract (docs/contracts/project-identity.md) —
// the one line every daemon response carries as the `neat-binding` header,
// resolved from the identity the daemon was started with. Kept in its own small
// module (not daemon.ts) so it is pure, cheap to test, and reuses the single
// `bindingLine` renderer (#1373 — one renderer, every surface prints it the
// same way).
//
// Two sources, in order:
//   1. A hosted tenant daemon identifies itself from env (neat-infra#215 §11):
//      NEAT_ORG is always set on a hosted tenant, NEAT_PROJECT_NAME is its
//      display name, NEAT_PROJECT_ID is set only for a registered project — a
//      console project has none, so the line renders `(no id yet)`.
//   2. A local per-project daemon reads the committed `<repo>/.neat/project.json`
//      and `<repo>/.neat/binding.json` at its project root.
// A legacy multi-project daemon has no single identity, so it gets no line and
// stamps no header.

import { bindingLine, readBinding, readProjectIdentity } from './project-identity.js'

export interface DaemonBindingInput {
  // The per-project daemon's project name and root path (ADR-096 singleProject).
  // Absent → a legacy multi-project daemon: no line.
  singleProject?: string
  singleProjectPath?: string
  // How this daemon names itself in the line: `pid:<pid>:<port>` for a local
  // daemon, or an endpoint for a hosted one.
  daemonAddr: string
  // Defaults to process.env; injectable for tests.
  env?: NodeJS.ProcessEnv
}

export async function resolveDaemonBindingLine(
  input: DaemonBindingInput,
): Promise<string | undefined> {
  const env = input.env ?? process.env
  const org = env.NEAT_ORG

  // 1. Hosted tenant daemon — identity from env.
  if (org !== undefined && org.length > 0) {
    const id = env.NEAT_PROJECT_ID
    return bindingLine({
      name: env.NEAT_PROJECT_NAME ?? input.singleProject ?? '<hosted>',
      ...(id ? { projectId: id } : {}),
      binding: 'hosted',
      org,
      daemon: input.daemonAddr,
    })
  }

  // 2. Local per-project daemon — identity from the committed .neat/ files. The
  // readers throw on a malformed file; a failure degrades to the daemon's own
  // name rather than taking the daemon down over a bad project.json.
  if (input.singleProject && input.singleProjectPath) {
    const ident = await readProjectIdentity(input.singleProjectPath).catch(() => undefined)
    const bnd = await readBinding(input.singleProjectPath).catch(() => undefined)
    const hosted = bnd?.binding === 'hosted'
    const org = hosted ? bnd?.org : undefined
    return bindingLine({
      name: ident?.name ?? input.singleProject,
      ...(ident?.projectId ? { projectId: ident.projectId } : {}),
      binding: hosted ? 'hosted' : 'local',
      ...(org ? { org } : {}),
      daemon: input.daemonAddr,
    })
  }

  // 3. Legacy multi-project daemon — no single identity, no header.
  return undefined
}
