// A barrel whose own module specifier resolves back to this file — the
// pathological self-referential import n8n ships. `./index.js` is the TS-ESM
// name for this very file (index.ts), so it resolves to `index.ts`, itself.
// Without the emitImportEdge self-loop guard this throws and kills the pass.
import './index.js'

export const value = 1
