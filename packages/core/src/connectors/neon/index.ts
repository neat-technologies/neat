import type { ResolveConnectorTarget } from '../index.js'
import type { ConnectorContext, ObservedConnector, ObservedSignal } from '../types.js'
import { DEFAULT_NEON_STATEMENT_LIMIT, fetchNeonStatements } from './client.js'
import { diffNeonStatementsToSignals, type NeonStatementBaseline } from './map.js'
import { createNeonResolveTarget } from './resolve.js'
import { readNeonCredentials, type NeonConnectorConfig } from './types.js'

export * from './client.js'
export * from './map.js'
export * from './resolve.js'
export * from './types.js'

export interface NeonConnectorDeps {
  fetchStatements?: typeof fetchNeonStatements
  now?: () => Date
}

export class NeonConnector implements ObservedConnector {
  readonly provider = 'neon'
  private readonly baselines = new Map<string, NeonStatementBaseline>()

  constructor(
    private readonly config: NeonConnectorConfig,
    private readonly deps: NeonConnectorDeps = {},
  ) {}

  async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
    const credentials = readNeonCredentials(ctx.credentials)
    const fetchStatements = this.deps.fetchStatements ?? fetchNeonStatements
    const rows = await fetchStatements(
      credentials.connectionString,
      this.config.projectId,
      this.config.statementLimit ?? DEFAULT_NEON_STATEMENT_LIMIT,
    )
    return diffNeonStatementsToSignals(
      rows,
      this.baselines,
      (this.deps.now?.() ?? new Date()).toISOString(),
    )
  }
}

export function createNeonConnector(
  config: NeonConnectorConfig,
  deps: NeonConnectorDeps = {},
): { connector: ObservedConnector; resolveTarget: ResolveConnectorTarget } {
  return {
    connector: new NeonConnector(config, deps),
    resolveTarget: createNeonResolveTarget(config),
  }
}
