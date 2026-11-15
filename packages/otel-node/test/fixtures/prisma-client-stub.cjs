// A stand-in for a generated @prisma/client, small enough for CI (no schema,
// no generate step, no query engine). The test copies it to
// <tmp>/node_modules/@prisma/client/index.js so the facade's module hook sees
// it under its real name. Like the real client, a model op returns a promise
// and the query span starts later, off the caller's stack (here in a
// setImmediate callback). Only a frame carried in context can give it a call
// site.
const { trace, SpanKind } = require('@opentelemetry/api')

function query(model, op) {
  return new Promise((resolve) => {
    setImmediate(() => {
      const span = trace.getTracer('prisma-stub').startSpan('prisma:engine:db_query', {
        kind: SpanKind.CLIENT,
        attributes: { 'db.system': 'postgresql', 'prisma.model': model, 'prisma.operation': op },
      })
      span.end()
      resolve([])
    })
  })
}

class PrismaClient {
  constructor() {
    this.user = {
      findMany: (args) => query('User', 'findMany', args),
      create: (args) => query('User', 'create', args),
    }
  }

  async $disconnect() {}
}

module.exports = { PrismaClient }
