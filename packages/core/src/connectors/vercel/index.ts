// Vercel connector barrel (docs/contracts/connectors.md §9, ADR-146). Vercel is
// the connectors plane's first *push* provider — it provisions a Drain instead
// of exposing a `poll()`, so this dir carries a Drains REST client and its
// types, not the client/connector/map/resolve split a pull provider has. The
// push dispatch entry that wires these into `neat connector add/remove/test`
// lives in `connectors/registry.ts` (`PUSH_PROVIDER_DISPATCH`), mirroring how
// the pull providers register.
export { createVercelDrain, deleteVercelDrain, testVercelDrainDelivery } from './client.js'
export type {
  VercelConnectorConfig,
  VercelCredentials,
  VercelDrainCreated,
  VercelDrainTestResult,
} from './types.js'
