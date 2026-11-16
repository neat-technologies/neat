import { z } from 'zod'

// Ref views (ADR-278, contracts/ref-views.md). A project keeps one live runtime
// layer and, per repository, memory-only static layers keyed by git state. A read
// that names `?ref=<key>` is answered from a view of that state.

const SHA = /^[0-9a-f]{40}$/
// A git state key. `commit:<sha>` for a commit, `worktree:<sha>+<sha256 digest>`
// for a dirty working tree. Branch and tag names are never keys.
export const REF_KEY_PATTERN = /^(?:commit:[0-9a-f]{40}|worktree:[0-9a-f]{40}\+[0-9a-f]{64})$/
export const RefKeySchema = z.string().regex(REF_KEY_PATTERN, 'must be commit:<sha> or worktree:<sha>+<digest>')
export type RefKey = z.infer<typeof RefKeySchema>

// The `ref` block every answer from a view carries. `hiddenRuntimeEdges` counts
// the runtime edges left out because an endpoint is absent at the ref, so a view
// never reads as fully observed. An incomplete layer is served and says so: the
// two counts are present exactly when its extraction had errors or skipped files
// (ADR-278 decision 4a).
export const RefBlockSchema = z.object({
  key: RefKeySchema,
  hiddenRuntimeEdges: z.number().int().nonnegative(),
  extractionErrors: z.number().int().nonnegative().optional(),
  skippedFiles: z.number().int().nonnegative().optional(),
})
export type RefBlock = z.infer<typeof RefBlockSchema>

export const RefStatusSchema = z.enum(['building', 'ready', 'incomplete', 'failed'])
export type RefStatus = z.infer<typeof RefStatusSchema>

// The source token a layer is scoped to: `owner/name` for a bound repository,
// spelled as `sourceBaselines` spells it, or the single token a local daemon's
// own extraction pass names (ADR-233).
// Each segment starts with a letter or digit, so none can be a path step.
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/

// Body of POST /refs. `cloneUrl` is the credentialed clone URL a hosted caller
// sends, held to the repository the request names exactly as POST /pr-verdict
// holds its own. Without it the layer is read from git at the project's scan path.
export const RefBuildBodySchema = z
  .object({
    repository: z.string().regex(SOURCE, 'not a repository'),
    sha: z.string().regex(SHA, 'must be a full 40-character lowercase commit SHA'),
    cloneUrl: z.string().url().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.cloneUrl === undefined) return
    let url: URL
    try {
      url = new URL(body.cloneUrl)
    } catch {
      return // z.string().url() already reported it
    }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cloneUrl'], message: 'must be an https://github.com URL' })
      return
    }
    const repoPath = url.pathname.replace(/\.git$/, '').replace(/\/+$/, '')
    if (repoPath.toLowerCase() !== `/${body.repository}`.toLowerCase()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cloneUrl'], message: 'does not point at the repository' })
    }
  })
export type RefBuildBody = z.infer<typeof RefBuildBodySchema>

export const RefBuildResponseSchema = z.object({
  project: z.string(),
  ref: RefKeySchema,
  status: RefStatusSchema,
})
export type RefBuildResponse = z.infer<typeof RefBuildResponseSchema>

// One retained layer, as GET /refs lists it. No graph content.
export const RefListEntrySchema = z.object({
  key: RefKeySchema,
  repository: z.string(),
  status: RefStatusSchema,
  // Milliseconds since the layer was asked for, and since it was last read.
  ageMs: z.number().int().nonnegative(),
  idleMs: z.number().int().nonnegative(),
  pinned: z.boolean(),
  extractionErrors: z.number().int().nonnegative().optional(),
  skippedFiles: z.number().int().nonnegative().optional(),
})
export type RefListEntry = z.infer<typeof RefListEntrySchema>

export const RefListResponseSchema = z.object({
  project: z.string(),
  count: z.number().int().nonnegative(),
  refs: z.array(RefListEntrySchema),
})
export type RefListResponse = z.infer<typeof RefListResponseSchema>

// The fixed codes a read answers with when its `ref` cannot be served. A read
// that names a ref is never answered from the live graph instead.
export const RefErrorCodeSchema = z.enum(['ref_not_found', 'ref_evicted', 'ref_building', 'ref_failed', 'ref_ambiguous'])
export type RefErrorCode = z.infer<typeof RefErrorCodeSchema>
