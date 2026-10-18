// A change detector for literal env values (ADR-266 amendment, #1487). The
// workload spec keeps an env var's name, never its value, so a value changed
// under the same name was invisible to "changed since healthy". Each literal env
// entry now carries `valueHash`: HMAC-SHA256 of the value, keyed by a per-project
// random salt, cut to 16 hex. A plain hash would let a short secret be
// brute-forced from the snapshot; keyed by a salt that never leaves the machine,
// the hash only says "same as before" or "different".
//
// The salt is 32 random bytes, generated once per project and kept at
// `<neat-out>/env-hash.key` with 0600 permissions. It is never written to the
// graph, the snapshot or a baseline, and nothing syncs it.

import { createHmac, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const ENV_HASH_KEY_FILE = 'env-hash.key'

/**
 * The project's env-hash salt, created on first use. `dir` is the project's
 * neat-out. Undefined when it can't be read or written, in which case env entries
 * carry no `valueHash` (a missing detector, never a weaker one).
 */
export async function loadEnvSalt(dir: string): Promise<Buffer | undefined> {
  const file = path.join(dir, ENV_HASH_KEY_FILE)
  try {
    await fs.mkdir(dir, { recursive: true })
    try {
      await fs.writeFile(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    // A file left looser by hand is tightened, not trusted as is.
    const stat = await fs.stat(file)
    if ((stat.mode & 0o077) !== 0) await fs.chmod(file, 0o600)
    const hex = (await fs.readFile(file, 'utf8')).trim()
    if (!/^[0-9a-f]{64}$/.test(hex)) return undefined
    return Buffer.from(hex, 'hex')
  } catch {
    return undefined
  }
}

/** HMAC-SHA256 of one env value under the project's salt, 16 hex. */
export function envValueHash(salt: Buffer, value: string): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 16)
}
