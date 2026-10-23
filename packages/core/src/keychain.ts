import { execFileSync } from 'node:child_process'

// The OS secret store behind `keychain:` credential references
// (connector-config.md §0). A reference is `keychain:<service>/<account>` —
// NEAT writes `keychain:neat/<provider>/<projectId>`, i.e. service `neat`,
// account `<provider>/<projectId>`. The secret lives in the user's keychain;
// only the reference reaches .neat/connectors.json, and the value is read at
// daemon bootstrap like an env-ref.
//
// macOS uses `security` (the login keychain, or the keychain file named by
// NEAT_KEYCHAIN), Linux `secret-tool` (libsecret). The secret never goes on a
// command line: `security -i` and `secret-tool store` read it from stdin.

export interface KeychainBackend {
  read(service: string, account: string): string | undefined
  write(service: string, account: string, secret: string): void
}

export class KeychainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeychainError'
  }
}

export function parseKeychainRef(ref: string): { service: string; account: string } | undefined {
  if (!ref.startsWith('keychain:')) return undefined
  const rest = ref.slice('keychain:'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return undefined
  return { service: rest.slice(0, slash), account: rest.slice(slash + 1) }
}

export function keychainRef(provider: string, projectId: string): string {
  return `keychain:neat/${provider}/${projectId}`
}

// `security -i` parses its stdin like a shell line; hex keeps any secret byte safe.
const quote = (s: string): string => `"${s.replace(/(["\\])/g, '\\$1')}"`

function macBackend(env: NodeJS.ProcessEnv): KeychainBackend {
  const file = env.NEAT_KEYCHAIN && env.NEAT_KEYCHAIN.length > 0 ? [env.NEAT_KEYCHAIN] : []
  return {
    read(service, account) {
      try {
        return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w', ...file], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).replace(/\n$/, '')
      } catch {
        return undefined
      }
    },
    write(service, account, secret) {
      const hex = Buffer.from(secret, 'utf8').toString('hex')
      const cmd = ['add-generic-password', '-U', '-s', quote(service), '-a', quote(account), '-X', hex, ...file.map(quote)].join(' ')
      try {
        execFileSync('security', ['-i'], { input: `${cmd}\n`, stdio: ['pipe', 'ignore', 'pipe'] })
      } catch (err) {
        throw new KeychainError(`could not write to the macOS keychain — ${(err as Error).message.split('\n')[0]}`)
      }
    },
  }
}

function linuxBackend(): KeychainBackend {
  return {
    read(service, account) {
      try {
        const out = execFileSync('secret-tool', ['lookup', 'service', service, 'account', account], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        return out.length > 0 ? out.replace(/\n$/, '') : undefined
      } catch {
        return undefined
      }
    },
    write(service, account, secret) {
      try {
        execFileSync('secret-tool', ['store', `--label=${service} ${account}`, 'service', service, 'account', account], {
          input: secret,
          stdio: ['pipe', 'ignore', 'pipe'],
        })
      } catch (err) {
        throw new KeychainError(`could not write with secret-tool (is libsecret installed?) — ${(err as Error).message.split('\n')[0]}`)
      }
    },
  }
}

let override: KeychainBackend | undefined

/** Swap the backend (tests). Returns a restore function. */
export function useKeychainBackend(backend: KeychainBackend): () => void {
  const prev = override
  override = backend
  return () => {
    override = prev
  }
}

export function systemKeychain(env: NodeJS.ProcessEnv = process.env): KeychainBackend {
  if (override) return override
  if (process.platform === 'darwin') return macBackend(env)
  if (process.platform === 'linux') return linuxBackend()
  throw new KeychainError(`no keychain support on ${process.platform} — use an env-ref ($VAR) credential instead`)
}

/**
 * The secret a `keychain:` reference points at. Throws KeychainError when the
 * reference is malformed, the platform has no keychain, or nothing is stored
 * under it — never returns the reference itself as if it were the secret.
 */
export function readKeychainRef(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const parsed = parseKeychainRef(ref)
  if (!parsed) throw new KeychainError(`${ref} is not a keychain reference (expected keychain:<service>/<account>)`)
  const value = systemKeychain(env).read(parsed.service, parsed.account)
  if (value === undefined || value.length === 0) {
    throw new KeychainError(`${ref} is not in the keychain — store it with \`neat connector add <provider> --token-stdin\``)
  }
  return value
}
