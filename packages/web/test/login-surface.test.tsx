import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// next/navigation is server-aware; stub it so the component-under-test can
// render in jsdom without a real Next router context.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))

// next/dynamic with { ssr: false } returns a placeholder during the first
// render in jsdom. Force the component to load eagerly so the test can
// assert against its DOM.
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: (loader: () => Promise<{ default?: unknown; LogoAnimation?: unknown }>) => {
    const mod: { current: React.ComponentType | null } = { current: null }
    loader().then((m) => {
      mod.current = (m.default ?? (m as { LogoAnimation?: React.ComponentType }).LogoAnimation) as React.ComponentType
    })
    return function Lazy() {
      const C = mod.current
      return C ? <C /> : null
    }
  },
}))

function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  // Fresh per-test localStorage — keeps assertions independent of prior test
  // files' side effects and dodges jsdom version drift.
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: makeStorage(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ADR-073 §3 — /login surface', () => {
  it('renders the NEAT-token input, caption, and Open dashboard button', async () => {
    const { LoginForm } = await import('../components/login-form')
    render(<LoginForm />)

    const input = screen.getByLabelText(/NEAT token/i)
    expect(input).toBeInTheDocument()
    expect(input.getAttribute('type')).toBe('password')

    expect(
      screen.getByText(/Your token was printed when you ran/i),
    ).toBeInTheDocument()

    expect(screen.getByRole('button', { name: /Open dashboard/i })).toBeInTheDocument()
  })

  it('strips the prior login-02 affordances — no Email, no Forgot password, no GitHub, no Sign up', async () => {
    const { LoginForm } = await import('../components/login-form')
    render(<LoginForm />)

    expect(screen.queryByLabelText(/Email/i)).toBeNull()
    expect(screen.queryByLabelText(/^Password$/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /GitHub/i })).toBeNull()
    expect(screen.queryByText(/Sign up/i)).toBeNull()
    expect(screen.queryByText(/Forgot/i)).toBeNull()
  })

  it('renders the logo animation centred on the letter "N"', async () => {
    const { LogoAnimation } = await import('../components/logo-animation')
    render(<LogoAnimation />)

    // The animation's centre letter is the load-bearing visual; it starts at "N"
    // and cycles N → E → A → T on the 900 / 140ms beat.
    expect(screen.getByTestId('logo-letter').textContent).toBe('N')
  })
})

describe('ADR-073 §3 / ADR-101 — authedFetch attaches the active profile bearer', () => {
  it('attaches `Authorization: Bearer <token>` from the active profile', async () => {
    const fetchStub = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const { setActiveProfile } = await import('../lib/active-profile')
    setActiveProfile({
      project: 'alpha',
      endpoint: 'http://127.0.0.1:8080',
      authToken: 'paste-this-into-prod',
    })

    const { authedFetch } = await import('../lib/authed-fetch')
    await authedFetch('/api/health?project=alpha')

    const sentInit = fetchStub.mock.calls[0]?.[1] as { headers?: Headers } | undefined
    expect(sentInit?.headers?.get('authorization')).toBe('Bearer paste-this-into-prod')

    setActiveProfile(null)
  })

  it('omits the Authorization header when the active profile carries no token', async () => {
    const fetchStub = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const { setActiveProfile } = await import('../lib/active-profile')
    setActiveProfile({ project: 'alpha', endpoint: 'http://127.0.0.1:8080' })

    const { authedFetch } = await import('../lib/authed-fetch')
    await authedFetch('/api/health?project=alpha')

    const sentInit = fetchStub.mock.calls[0]?.[1] as { headers?: Headers } | undefined
    expect(sentInit?.headers?.get('authorization')).toBeNull()

    setActiveProfile(null)
  })
})
