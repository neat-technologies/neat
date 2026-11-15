// Hosted connector family (ADR-228): the only tools that call the control plane
// (NEAT_CP_URL + a neat_pat_) rather than the daemon. The implementations live
// in connectors.ts; this module only declares them as registry entries, built
// over the context's connectorDeps.

import { z } from 'zod'
import { defineTool } from './registry.js'
import {
  neatConnect,
  neatConnectionStatus,
  neatDisconnect,
  neatListConnectable,
} from '../connectors.js'

export const connectTools = [
  defineTool({
    name: 'neat_list_connectable',
    description:
      'When a hosted graph lacks provider-side evidence, list the providers this project can connect. Returns control-plane options, or a configuration note when NEAT_CP_URL and a neat_pat_ NEAT_API_KEY are unavailable.',
    schema: {},
    build: (ctx) => async () => neatListConnectable(ctx.connectorDeps),
  }),
  defineTool({
    name: 'neat_connect',
    description:
      'When authorized to add hosted provider evidence, connect a listed provider with its API credential. The control plane verifies and seals the credential; the daemon then polls or receives the supported telemetry into OBSERVED. Hosted only.',
    schema: {
      provider: z
        .string()
        .describe('Provider id, e.g. "supabase" or "railway" (see neat_list_connectable)'),
      credential: z
        .string()
        .describe(
          "The provider's own API token — e.g. a Supabase Management token (sbp_...) or a Railway account/team token. Sealed at rest; never stored in the graph or returned.",
        ),
    },
    build: (ctx) => async (input) => neatConnect(ctx.connectorDeps, input),
  }),
  defineTool({
    name: 'neat_connection_status',
    description:
      'When provider evidence is absent or stale in a hosted graph, inspect connections and their connecting, healthy, error, or needs-reconnect status. Returns control-plane state, not a live graph traversal.',
    schema: {},
    build: (ctx) => async () => neatConnectionStatus(ctx.connectorDeps),
  }),
  defineTool({
    name: 'neat_disconnect',
    description:
      'When authorized to remove a hosted provider integration, disconnect it and drop its stored connection. Returns the control-plane result; this changes future provider evidence, not source code.',
    schema: {
      provider: z.string().describe('Provider id to disconnect, e.g. "supabase"'),
    },
    build: (ctx) => async (input) => neatDisconnect(ctx.connectorDeps, input),
  }),
]
