'use client'

import { useState, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
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
    try {
      window.localStorage.setItem('neat:authToken', trimmed)
    } catch {
      // Storage quota / private-mode — keep going; the fetch below will fail.
    }

    let res: Response
    try {
      res = await fetch('/api/projects', {
        headers: { Authorization: `Bearer ${trimmed}` },
        cache: 'no-store',
      })
    } catch {
      setState({ kind: 'error', message: ERR_NETWORK })
      return
    }

    if (res.status === 401) {
      try {
        window.localStorage.removeItem('neat:authToken')
      } catch {
        /* ignore */
      }
      setState({ kind: 'error', message: ERR_WRONG_TOKEN })
      return
    }

    if (!res.ok) {
      setState({ kind: 'error', message: `Daemon returned ${res.status}; try again.` })
      return
    }

    const next = safeNext(searchParams?.get('next') ?? null)
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
