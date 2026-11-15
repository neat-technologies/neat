// Policy family: check_policies — the single tool covering the state-read,
// dry-run, and soft-guardrail (applicable-to) modes per ADR-045 / ADR-108.

import type {
  ApplicablePoliciesResponse,
  HypotheticalAction,
  PolicyViolation,
} from '@neat.is/types'
import type { HttpClient } from '../client.js'
import {
  formatEmptyResponse,
  formatErrorResponse,
  formatToolResponse,
  type ToolResponse,
} from '../format.js'
import { postJson, projectPath } from './shared.js'
import { z } from 'zod'
import { CheckPoliciesScopeSchema, HypotheticalActionSchema } from '@neat.is/types'
import { defineTool, projectField } from './registry.js'

export interface CheckPoliciesInput {
  // 'all' (default) returns every current violation. 'unresolved' is reserved
  // for future resolution tracking — for the MVP it behaves the same as 'all'.
  // { policyId } narrows to violations of one named policy.
  scope?: 'all' | 'unresolved' | { policyId: string }
  // When provided, dry-run evaluation: return violations that *would* result
  // if the action were applied. Without it, return current violations.
  hypotheticalAction?: HypotheticalAction
  // Soft guardrail (ADR-108). When provided, return the policies APPLICABLE to
  // this node — the rules the agent should keep in mind while editing it,
  // surfaced as context. Informs only; never blocks. Takes precedence over the
  // violation-read and dry-run modes.
  applicableTo?: string
  project?: string
}

interface PoliciesCheckResponse {
  allowed: boolean
  hypotheticalAction?: HypotheticalAction
  violations: PolicyViolation[]
}

// check_policies — single MCP tool covering both state-read and dry-run modes
// per ADR-045. The contract explicitly rejects the audit's two-tool split
// (evaluate_policy + get_policy_violations); both modes route through here.
export async function checkPolicies(
  client: HttpClient,
  input: CheckPoliciesInput,
): Promise<ToolResponse> {
  try {
    // Soft guardrail mode (ADR-108). Surface the policies that govern the node
    // the agent is working at, as a labeled context block. It informs; it does
    // not block — there is no allowed/denied verdict on this path.
    if (input.applicableTo) {
      const body = await client.get<ApplicablePoliciesResponse>(
        projectPath(
          input.project,
          `/policies/applicable?node=${encodeURIComponent(input.applicableTo)}`,
        ),
      )
      return formatApplicablePolicies(body)
    }

    let violations: PolicyViolation[]
    let allowed = true
    let hypothetical: HypotheticalAction | undefined

    if (input.hypotheticalAction) {
      // Dry-run via POST /policies/check.
      const body = await postJson<PoliciesCheckResponse>(
        client,
        projectPath(input.project, '/policies/check'),
        { hypotheticalAction: input.hypotheticalAction },
      )
      violations = body.violations
      allowed = body.allowed
      hypothetical = body.hypotheticalAction
    } else {
      // State read via GET /policies/violations. Optional scope filters via
      // ?policyId=, severity isn't surfaced in the tool input today.
      const qsParams = new URLSearchParams()
      if (typeof input.scope === 'object' && 'policyId' in input.scope) {
        qsParams.set('policyId', input.scope.policyId)
      }
      const qs = qsParams.size > 0 ? `?${qsParams.toString()}` : ''
      const body = await client.get<{ violations: PolicyViolation[] }>(
        projectPath(input.project, `/policies/violations${qs}`),
      )
      violations = body.violations
      allowed = violations.every((v) => v.onViolation !== 'block')
    }

    if (violations.length === 0) {
      return formatEmptyResponse(
        hypothetical
          ? `No violations would result from the hypothetical action (${hypothetical.kind}).`
          : 'No policy violations recorded.',
      )
    }

    const blockCount = violations.filter((v) => v.onViolation === 'block').length
    const summaryParts: string[] = []
    if (hypothetical) {
      summaryParts.push(
        `Hypothetical ${hypothetical.kind} would surface ${violations.length} violation${violations.length === 1 ? '' : 's'}`,
      )
    } else {
      summaryParts.push(
        `${violations.length} policy violation${violations.length === 1 ? '' : 's'} currently recorded`,
      )
    }
    if (blockCount > 0) {
      summaryParts.push(`${blockCount} of which block`)
    }
    if (!allowed && hypothetical) {
      summaryParts.push('action denied')
    }
    const summary = summaryParts.join('; ') + '.'

    const blockLines = violations.map((v) => {
      const subject = v.subject.nodeId ?? v.subject.edgeId ?? v.subject.path?.[0] ?? '(global)'
      return `  • [${v.severity}/${v.onViolation}] ${v.policyName}: ${v.message} — ${subject}`
    })
    const severities = [...new Set(violations.map((v) => v.severity))]
    return formatToolResponse({
      summary,
      block: blockLines.join('\n'),
      // Confidence: hypothetical results inherit a 0.7 cap (the engine
      // can't fully simulate every action shape in MVP); confirmed
      // violations report 1.00 since the engine ran against current state.
      confidence: hypothetical ? 0.7 : 1,
      provenance: severities.join(' '),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

// The soft-guardrail context block (ADR-108). This is the "hook to the top of
// agent memory": the policies that govern where the agent is working, surfaced
// so the rules ride along as it edits. It INFORMS — there is deliberately no
// allowed/denied verdict and no blocking language here. The post-launch kernel
// gate (ADR-093) is the only surface that refuses an action; this is not it.
function formatApplicablePolicies(body: ApplicablePoliciesResponse): ToolResponse {
  const { node, applicable } = body
  if (applicable.length === 0) {
    return formatEmptyResponse(
      `No policies apply to ${node}. Nothing to keep inside the lines here — and note this is advisory: NEAT surfaces policies for awareness, it never blocks your edit.`,
    )
  }
  const summary =
    `APPLICABLE POLICIES — ${applicable.length} ${applicable.length === 1 ? 'policy applies' : 'policies apply'} where you're working (${node}). ` +
    `Keep these in mind as you edit. They inform; they do not block. Nothing here gates or stops your change.`
  const lines = applicable.map((p) => {
    const tail = p.match === 'region' ? ' [nearby]' : ''
    return `  • [${p.severity}/${p.onViolation}] ${p.policyName}${tail}: ${p.reason}`
  })
  return formatToolResponse({
    summary,
    block: lines.join('\n'),
    // The policies themselves are declared in policy.json — EXTRACTED, fully
    // known; the confidence is in the rule's existence, not a guess.
    confidence: 1,
    provenance: 'EXTRACTED (policy.json)',
  })
}

export const policyTools = [
  defineTool({
    name: 'check_policies',
    description:
      'Before an edit, ask which architectural policies apply to its node; before a proposed action, dry-run its policy effect. Returns advisory rules or violations across structure, compatibility, provenance, ownership, and blast radius. Policies inform the agent; this tool does not block changes.',
    schema: {
      scope: CheckPoliciesScopeSchema.optional().describe('Narrow to a subset. Default "all".'),
      hypotheticalAction: HypotheticalActionSchema.optional().describe(
        'Dry-run mode: simulate the action and return resulting violations. Omit for current state.',
      ),
      applicableTo: z
        .string()
        .optional()
        .describe(
          'Soft guardrail (ADR-108): pass the node id you are about to edit and check_policies returns the policies that govern it, as a context block — so you stay inside the lines. Advisory only; never blocks.',
        ),
      project: projectField,
    },
    build: (ctx) => async (input) =>
      checkPolicies(ctx.client, {
        ...input,
        project: ctx.projectFor(input),
      } as Parameters<typeof checkPolicies>[1]),
  }),
]
