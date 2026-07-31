import { EdgeType, infraId } from '@neat.is/types'
import type { ResolveConnectorTarget } from '../index.js'
import { NEON_SQL_TABLE_TARGET_KIND, type NeonConnectorConfig } from './types.js'

export function createNeonResolveTarget(config: NeonConnectorConfig): ResolveConnectorTarget {
  return (signal) => {
    if (signal.targetKind !== NEON_SQL_TABLE_TARGET_KIND || !signal.targetName) return null
    return {
      targetNodeId: infraId('sql-table', signal.targetName),
      serviceName: config.serviceName,
      edgeType: EdgeType.CALLS,
      ensureInfraNode: { kind: 'sql-table', name: signal.targetName, provider: 'neon' },
    }
  }
}
