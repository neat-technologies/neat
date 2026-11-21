import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ENV_UNKNOWN, normalizeEnv } from '@neat.is/types'
import { DEFAULT_PRODUCTION_ENV } from './runtime-env.js'

// A project's environment settings (ADR-280 ruling (c)): which environment is its
// production one, read from `<project>/.neat/environments.json` as
// `{ "productionEnv": "<name>" }`. The file is optional and committed with the
// project like `.neat/project.json`; `.neat/` is open-ended (project-identity.md
// §2a). Absent, unreadable, or naming no usable environment, the setting is
// `production`, the value every project starts with.

export const PROJECT_ENVIRONMENTS_FILE = path.join('.neat', 'environments.json')

/** The project's production environment, normalised the way ingest normalises environments. */
export async function readProductionEnv(projectDir: string | undefined): Promise<string> {
  if (!projectDir) return DEFAULT_PRODUCTION_ENV
  try {
    const raw = JSON.parse(await fs.readFile(path.join(projectDir, PROJECT_ENVIRONMENTS_FILE), 'utf8')) as { productionEnv?: unknown }
    if (typeof raw?.productionEnv !== 'string') return DEFAULT_PRODUCTION_ENV
    const env = normalizeEnv(raw.productionEnv)
    return env === ENV_UNKNOWN ? DEFAULT_PRODUCTION_ENV : env
  } catch {
    return DEFAULT_PRODUCTION_ENV
  }
}
