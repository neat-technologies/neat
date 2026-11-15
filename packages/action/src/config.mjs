// The action's inputs, read once from the environment GitHub Actions sets.
// Functions that tests drive with a changing env (the host URL and token) also
// re-read process.env at call time; see host.mjs.

const env = process.env

export const TOKEN = env.INPUT_GITHUB_TOKEN || env.GITHUB_TOKEN || ''
export const ENGINE = env.INPUT_ENGINE || 'neat.is'
export const SCAN_SUBPATH = env.INPUT_SCAN_PATH || ''
export const NEAT_API_URL = env.INPUT_NEAT_API_URL || ''
export const NEAT_API_TOKEN = env.INPUT_NEAT_API_TOKEN || ''
export const TONE = env.INPUT_TONE === 'professional' ? 'professional' : 'loud'
export const SNIPER_DISPATCH_URL = env.INPUT_SNIPER_DISPATCH_URL || ''
export const GRAPH_DIFF_URL = env.INPUT_GRAPH_DIFF_URL || ''
export const WORKSPACE = env.GITHUB_WORKSPACE || process.cwd()
export const SECURITY = env.INPUT_SECURITY === 'off' ? 'off' : 'on'
export const SECURITY_GATE = env.INPUT_SECURITY_GATE === 'fail' ? 'fail' : 'report'

/** The connected NEAT host, read at call time so tests can set it after import. */
export function apiUrl() {
  return process.env.INPUT_NEAT_API_URL || NEAT_API_URL
}
