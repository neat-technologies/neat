export const NEON_SQL_TABLE_TARGET_KIND = 'sql-table'

export interface NeonConnectorConfig {
  projectId: string
  serviceName: string
  statementLimit?: number
}

export interface NeonCredentials {
  connectionString: string
}

export interface NeonStatementRow {
  queryid: string
  query: string
  calls: string | number
}

export function readNeonCredentials(input: Record<string, unknown>): NeonCredentials {
  const connectionString = input.connectionString
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new Error('neon connector: credentials.connectionString is required')
  }
  return { connectionString }
}
