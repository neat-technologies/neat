'use client'

import { useState, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { writeProfileToken, clearProfileToken } from '@/lib/active-profile'
import { asProfileList } from '@/lib/resolve-project'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'

type SubmitState = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'error'; message: string }

const ERR_WRONG_TOKEN = "That token doesn't match this NEAT instance."
const ERR_NETWORK = "Can't reach the daemon; check the URL."

function safeNext(raw: string | null): string {
  if (!raw) return '/'
  // Only accept same-origin paths starting with a single slash.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

// ADR-101 — the bearer is per-profile, so figure out which daemon this login is
// for. The profile label rides on the `?project=` of the page (or the `next`
// it will return to); failing that, the first discovered daemon.
function projectFromNext(next: string): string | null {
  try {
    const qs = next.includes('?') ? next.slice(next.indexOf('?')) : ''
    const fromNext = new URLSearchParams(qs).get('project')
    if (fromNext) return fromNext
  } catch {
    /* malformed next — fall through */
  }
  try {
    return new URLSearchParams(window.location.search).get('project')
  } catch {
    return null
  }
}

export function LoginForm({ className, ...props }: React.ComponentProps<'form'>) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [token, setToken] = useState('')
  const [state, setState] = useState<SubmitState>({ kind: 'idle' })

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmed = token.trim()
    if (!trimmed) return

    setState({ kind: 'submitting' })
    const next = safeNext(searchParams?.get('next') ?? null)

    // Which daemon is this token for? The profile label off the URL/next, else
    // the first discovered daemon (ADR-101).
    let target = projectFromNext(next)
    if (!target) {
      try {
        const list = asProfileList(await (await fetch('/api/profiles', { cache: 'no-store' })).json())
        target = list[0]?.project ?? null
      } catch {
        /* no discovery — fall through to the network error below */
      }
    }
    if (!target) {
      setState({ kind: 'error', message: ERR_NETWORK })
      return
    }

    // Store the bearer for that profile, then validate it against the daemon
    // (a wrong token 401s on a protected daemon's health probe).
    writeProfileToken(target, trimmed)

    let res: Response
    try {
      res = await fetch(`/api/health?project=${encodeURIComponent(target)}`, {
        headers: { Authorization: `Bearer ${trimmed}` },
        cache: 'no-store',
      })
    } catch {
      setState({ kind: 'error', message: ERR_NETWORK })
      return
    }

    if (res.status === 401) {
      clearProfileToken(target)
      setState({ kind: 'error', message: ERR_WRONG_TOKEN })
      return
    }

    if (!res.ok) {
      setState({ kind: 'error', message: `Daemon returned ${res.status}; try again.` })
      return
    }

    router.push(next)
  }

  const submitting = state.kind === 'submitting'
  const errorMessage = state.kind === 'error' ? state.message : null

  return (
    <form className={cn('flex flex-col gap-6', className)} onSubmit={handleSubmit} {...props}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-sm text-muted-foreground text-balance">
            Paste your NEAT token to open the dashboard.
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor="neat-token">NEAT token</FieldLabel>
          <Input
            id="neat-token"
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            required
            value={token}
            onChange={(e) => {
              setToken(e.target.value)
              if (state.kind === 'error') setState({ kind: 'idle' })
            }}
            aria-invalid={state.kind === 'error'}
            aria-describedby="neat-token-hint"
          />
          <FieldDescription id="neat-token-hint">
            Your token was printed when you ran <code className="font-mono">neat deploy</code> — find
            it in your deploy platform's env vars.
          </FieldDescription>
        </Field>
        {errorMessage && (
          <div
            role="alert"
            className="text-sm text-destructive"
            data-testid="login-error"
          >
            {errorMessage}
          </div>
        )}
        <Field>
          <Button type="submit" disabled={submitting || token.trim().length === 0}>
            {submitting ? 'Checking…' : 'Open dashboard'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
