import { z } from 'zod'

// Body of POST /pr-verdict (ADR-235): a pull request's two commits, and the
// credentialed clone URL to fetch them with. The daemon clones on the caller's
// word, so the URL is held to the repository the request names: https, on
// github.com, `/<owner>/<name>` with an optional `.git`.

const SHA = /^[0-9a-f]{40}$/
// A GitHub account or repository name — and nothing that could be a path.
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/

export const PrVerdictBodySchema = z
  .object({
    owner: z.string().regex(SLUG, 'not a GitHub account name'),
    name: z.string().regex(SLUG, 'not a GitHub repository name'),
    baseSha: z.string().regex(SHA, 'must be a full 40-character lowercase commit SHA'),
    headSha: z.string().regex(SHA, 'must be a full 40-character lowercase commit SHA'),
    cloneUrl: z.string().url(),
    // Repo-relative paths the PR changes. Optional; capped by the daemon.
    changedFiles: z.array(z.string()).optional(),
    tone: z.enum(['loud', 'professional']).optional(),
  })
  .superRefine((body, ctx) => {
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
    if (repoPath.toLowerCase() !== `/${body.owner}/${body.name}`.toLowerCase()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cloneUrl'], message: 'does not point at owner/name' })
    }
  })
export type PrVerdictBody = z.infer<typeof PrVerdictBodySchema>
